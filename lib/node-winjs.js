var fs = require("fs");
function read(f) {
    return fs.readFileSync(f).toString();
}
function include(f) {
    eval.apply(global, [read(f)]);
}
include('lib/WinJS.js');

// assigning to 'exports' will not modify module, must use module.exports
module.exports = WinJS;
