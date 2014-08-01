var fs = require("fs");
var path = require("path");
function read(f) {
    return fs.readFileSync(f).toString();
}
function include(f) {
    eval.apply(global, [read(f)]);
}
var winjs_path = path.join(path.dirname(module.filename), 'WinJS.js');
include(winjs_path);

// assigning to 'exports' will not modify module, must use module.exports
module.exports = WinJS;

