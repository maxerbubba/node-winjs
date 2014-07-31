var fs = require("fs");
function read(f) {
  return fs.readFileSync(f).toString();
}
function include(f) {
  eval.apply(global, [read(f)]);
}
console.log("running main.");
include('lib/WinJS.js');

WinJS.Promise.timeout(1000).then(function () {
    console.log("one second later!");
});


// assigning to 'exports' will not modify module, must use module.exports
module.exports = {
    Promise: function() {
      return {name:'hi i am a promise'};
    }
  };

