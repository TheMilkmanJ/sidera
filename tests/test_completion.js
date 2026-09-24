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
assert.equal(
  isInterimStatus("Analyze specific pedestrian count data\nExplore European pedestrian zone models"),
  true,
);
assert.equal(
  isInterimStatus("The evidence\nScienceDirect\n+1\nTaylor & Francis Online\nScienceDirect\neScholarship"),
  true,
);
assert.equal(isInterimStatus("sideraflow"), false);
assert.equal(
  finishedAnswer("Worked for 8s\nRan 4 searches\nsideraflow\n25 sources"),
  "sideraflow",
);
assert.equal(finishedAnswer("sideraflow"), "sideraflow");
assert.equal(
  finishedAnswer("A small city should close its downtown streets to cars.\nExplore pedestrianization benefits"),
  "A small city should close its downtown streets to cars.",
);
const { isErrorReply } = context.globalThis.SideraCompletion;
assert.equal(isErrorReply("I'm having a hard time fulfilling your request. Can I help you with something else instead?"), true);
assert.equal(isErrorReply("I seem to be encountering an error. Can I try something else for you?"), true);
assert.equal(isErrorReply("Something went wrong. Please try again."), true);
assert.equal(isErrorReply("I encountered an error doing what you asked. Could you try again?"), true);
assert.equal(isErrorReply("Hmm...something seems to have gone wrong."), true);
assert.equal(isErrorReply("Something went wrong with that plan, and here is a long real answer about why the four-day week still works for most districts and what the evidence says, including the attendance data from Colorado, Missouri and Oklahoma that show mixed results across urban and rural districts alike."), false);
assert.equal(isErrorReply("An error budget is a useful concept for reliability engineering. Would you agree?"), false);
assert.equal(isErrorReply("Yes—absolutely. Tell me what you're trying to do and we can take a different route."), false);
assert.equal(isErrorReply("The strongest case for universal basic income is administrative simplicity. What is your view?"), false);
console.log("completion ok");
