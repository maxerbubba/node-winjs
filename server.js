var winjs = require("node-winjs");
console.log("WinJS loaded.");

winjs.Promise.timeout(1000).then(function () {
    console.log("one second later!");
    return winjs.Promise.timeout(1000);
}).then(function () {
    console.log("two second later!");
    return winjs.Promise.timeout(1000);
}).then(function () {
    console.log("three second later!");
    return winjs.Promise.timeout(1000);
});

