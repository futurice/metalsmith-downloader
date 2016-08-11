var debug = require('debug')('metalsmith-downloader');
var fs = require('fs-extra');
var path = require('path');
var request = require('request');

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
            if (err)
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

function chmodFile(filename, mode) {
  return new Promise(function(resolve, reject) {
    fs.chmod(filename, mode, function(err) {
      if (err)
        reject(err);
      else
        resolve();
    });
  });
}

module.exports = function downloader(options) {
  return function(files, metalsmith, done) {
    var dest = metalsmith.destination();

    Promise.all(
      Object.keys(files).map(function(filename) {
        var file = files[filename];
        if (!file || !file.contentsUrl)
          return Promise.resolve();

        debug('Removing file ' + filename + ' from Metalsmith');
        delete files[filename];

        debug('Downloading file ' + filename + ' from ' + file.contentsUrl);
        var filepath = path.resolve(dest, filename);
        return downloadFile(filepath, file.contentsUrl)
          .then(function() {
            if (file.mode) {
              debug('Changing mode of file ' + filename);
              return chmodFile(filename, file.mode);
            }
            return Promise.resolve();
          })
          .then(function() {
            debug('File ' + filename + ' downloaded successfully');
          }).catch(function(err) {
            debug('Error downloading file ' + filename + ': ' + err);
          });
      })
    ).then(function() {
      done();
    }).catch(function(err) {
      done(err);
    });
  };
};
