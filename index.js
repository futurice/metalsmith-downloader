/**
 * Copyright (c) 2016 Contributors
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
 * FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS
 * OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
 * WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR
 * IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */

var debug = require('debug')('metalsmith-downloader');
var fs = require('fs-extra');
var path = require('path');
var request = require('request');
var queue = require('queue');

function checkFileExists(filename) {
  return new Promise(function(resolve, reject) {
    fs.stat(filename, function(err, stats) {
      resolve(err ? false : stats.isFile());
    });
  });
}

function downloadFile(filename, url) {
  return new Promise(function(resolve, reject) {
    var dirname = path.dirname(filename);
    fs.mkdirs(dirname, function(err) {
      if (err) return reject(err);

      var pipeError = null;
      var outputStream = null;

      var req = request.get(url);
      req.on('response', function(res) {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          req.abort();
          reject(new Error('Invalid response code: ' + res.statusCode));
          return;
        }

        function deleteAndReject() {
          fs.unlink(filename, function(err) {
            if (err)  // FIXME: Consider this as fatal error
              debug('Error deleting file ' + filename + ': ' + err);
            reject(pipeError);
            pipeError = null;
          });
        }
        function outputCloseHandler() {
          outputStream = null;
          if (pipeError) {
            deleteAndReject();
          } else {
            resolve();
          }
        }
        function outputErrorHandler(err) {
          req.abort();
          pipeError = err;
          outputStream.close();
        }
        outputStream = fs.createWriteStream(filename, {autoClose: true});
        outputStream.on('close', outputCloseHandler);
        outputStream.on('error', outputErrorHandler);
        req.pipe(outputStream);
      });
      req.on('error', function(err) {
        req.abort();
        if (outputStream) {
          pipeError = err;
          outputStream.close();
        } else {
          reject(err);
        }
      });
    });
  });
}

function chmodFile (filename, mode) {
  debug('Changing mode of file ' + filename);
  return new Promise(function(resolve, reject) {
    fs.chmod(filename, mode, function(err) {
      if (err)
        reject(err);
      else
        resolve();
    });
  });
}

function copyFile(src, dst) {
  return new Promise(function(resolve, reject) {
    var dirname = path.dirname(dst);
    fs.mkdirs(dirname, function(err) {
      if (err) return reject(err);

      fs.copy(src, dst, function(err) {
        if (err) return reject(err);
        resolve();
      })
    });
  });
}

function createProcessFile(options) {
  var incremental = options.incremental;
  var cacheDir = options.cache;
  var dest = options.dest;

  return function processFile(filename, file) {
    var filepath = path.resolve(cacheDir || dest, filename);
    var contentsUrl = file.contentsUrl;

    return checkFileExists(filepath)
      .then(function(exists) {
        // NOTE: This won't work with retries unless we successfully remove the failed file
        if (cacheDir && exists) {
          debug('File ' + filename + ' found in cache, not downloading');
          return Promise.resolve();
        }

        if (incremental && exists) {
          debug('File ' + filename + ' already exists, not downloading');
          return Promise.resolve();
        }

        debug('Downloading file ' + filename + ' from ' + contentsUrl);
        return downloadFile(filepath, contentsUrl)
          .then(function() {
            if (file.mode) {
              // FIXME: Shouldn't this affect filepath and not filename?
              return chmodFile(filename, file.mode);
            }

            return Promise.resolve();
          })
          .then(function() {
            debug('File ' + filename + ' downloaded successfully');
          });
      }).then(function() {
        if (!cacheDir)
          return Promise.resolve();

        var destpath = path.resolve(dest, filename);
        debug('Copying ' + filepath + ' to ' + destpath);
        // FIXME: Don't copy if destpath exists && incremental?
        return copyFile(filepath, destpath);
      }).catch(function(err) {
        debug('Error downloading file ' + filename + ': ' + err);
      });
  }
}

function createProcessFileWrapper(q, options) {
  var processFile = createProcessFile(options);
  var maxRetries = options.retries || 0;

  return function processFileWrapper(filename, file, retries) {
    retries = retries || 0;

    return function processFileWrapperInner(cb) {
      if (retries > maxRetries) {
        return setTimeout(function() {
          cb(Error(`Number of retries exceeds ${maxRetries} on ${filename}`));
        }, 0);
      }

      debug('Processing ' + filename);

      return processFile(filename, file)
        .then(function() {
          cb();
        })
        .catch(function() {
          debug('Retrying ' + filename);
          q.push(processFileWrapper(filename, file, retries + 1));
          cb();
        })
    }
  }
}

module.exports = function downloader(options) {

  return function(files, metalsmith, done) {
    var _options = Object.assign(options || {}, {
      dest: metalsmith.destination()
    });
    var q = queue({concurrency: _options.concurrency || Infinity});

    var processFile = createProcessFileWrapper(q, _options);

    Object.keys(files)
      .filter(function(filename) {
        var file = files[filename];
        return file && file.contentsUrl;
      })
      .forEach(function(filename) {
        var file = files[filename];
        delete files[filename];
        q.push(processFile(filename, file));
      });

    q.start(done);
  };
};
