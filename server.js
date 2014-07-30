var winjs = require("node-winjs");

console.log("WinJS loaded.");
console.log(JSON.stringify(winjs));

var p = new winjs.Promise(2);
console.log(JSON.stringify(p));

console.log();
console.log("done.");