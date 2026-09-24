const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../chrome-extension/completion.js"), "utf8");
const context = { globalThis: {} };
vm.runInNewContext(source, context);
const { isInterimStatus, finishedAnswer } = context.globalThis.SideraCompletion;

assert.equal(isInterimStatus("Worked for 3s\nRan 4 searches\nThinking\nWorked for 3s\n25 sources"), true);
assert.equal(isInterimStatus("Working"), true);
assert.equal(isInterimStatus("Working for 1s"), true);
assert.equal(isInterimStatus(""), true);
assert.equal(
  isInterimStatus("Opened page\nen.wikipedia.org/wiki/Pineapple\nThinking"),
  true,
);
assert.equal(isInterimStatus("Opened page\nen.wikipedia.org/wiki/Pineapple"), true);
assert.equal(isInterimStatus("sideraflow"), false);
assert.equal(
  finishedAnswer("Worked for 8s\nRan 4 searches\nsideraflow\n25 sources"),
  "sideraflow",
);
assert.equal(finishedAnswer("sideraflow"), "sideraflow");
console.log("completion ok");
