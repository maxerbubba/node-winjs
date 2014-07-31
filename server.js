var winjs = require("./lib/main.js");

console.log("WinJS loaded.");
console.log(JSON.stringify(winjs));

var p = new winjs.Promise(2);
console.log(JSON.stringify(p));

console.log();
console.log("done.");

setTimeout(function () { console.log("bye"); }, 10000);