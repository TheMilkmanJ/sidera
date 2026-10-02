// A fresh service worker opens no tab. Choosing a side opens that AI and
// pairs the new tab. The same choice on both sides is two tabs.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..", "chrome-extension");
const created = [];
const posted = [];
const popupMessages = [];
let nextId = 10;
let onMessage = null;
const updatedListeners = [];

function promiseLike() {
  return { catch() { return this; } };
}

const context = {
  console,
  setTimeout,
  clearTimeout,
  URL,
  importScripts(name) {
    vm.runInContext(fs.readFileSync(path.join(root, name), "utf8"), context);
  },
  chrome: {
    runtime: {
      lastError: null,
      connectNative() {
        return {
          postMessage(payload) { posted.push(payload); },
          onMessage: { addListener() {} },
          onDisconnect: { addListener() {} },
        };
      },
      sendMessage() { popupMessages.push(...arguments); return promiseLike(); },
      onMessage: { addListener(fn) { onMessage = fn; } },
    },
    storage: {
      session: {
        set() { return promiseLike(); },
        get(_keys, callback) { callback({}); },
      },
    },
    tabs: {
      onUpdated: {
        addListener(fn) { updatedListeners.push(fn); },
        removeListener(fn) {
          const index = updatedListeners.indexOf(fn);
          if (index >= 0) updatedListeners.splice(index, 1);
        },
      },
      create(options, callback) {
        nextId += 1;
        const tab = { id: nextId, url: options.url, status: "complete" };
        created.push(tab);
        callback(tab);
      },
      get(id, callback) {
        const tab = created.find((item) => item.id === id);
        callback(tab || null);
      },
      sendMessage(_tabId, message, callback) {
        if (message.type === "ASSIGN_HEMISPHERE") {
          callback({ status: "paired", hemisphere: message.hemisphere, adapter: message.adapterType });
          return;
        }
        if (callback) callback({ status: "ok" });
      },
      query(_query, callback) { callback([]); },
      update() {},
    },
    windows: { update() {} },
    debugger: {},
  },
};
context.globalThis = context;
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(root, "background.js"), "utf8"), context);

assert.equal(created.length, 0, "loading the extension opens no tab");
assert.equal(typeof onMessage, "function");

const responses = [];
onMessage({ type: "OPEN_AND_PAIR", side: "LEFT", adapter: "chatgpt" }, {}, (resp) => responses.push(resp));
onMessage({ type: "OPEN_AND_PAIR", side: "RIGHT", adapter: "chatgpt" }, {}, (resp) => responses.push(resp));

assert.equal(responses.length, 2);
assert.equal(responses[0].success, true);
assert.equal(responses[1].success, true);
assert.equal(responses[0].adapter, "chatgpt");
assert.equal(responses[1].adapter, "chatgpt");
assert.equal(responses[0].label, "ChatGPT");
assert.equal(responses[1].label, "ChatGPT");
assert.notEqual(responses[0].tabId, responses[1].tabId);
assert.deepEqual(created.map((tab) => tab.url), ["https://chatgpt.com/", "https://chatgpt.com/"]);

const hooks = posted.filter((packet) => packet.type === "HOOK_SLOT" && packet.tab_id);
assert.deepEqual(hooks.map((packet) => packet.slot_id), ["LEFT", "RIGHT"]);
assert.deepEqual(hooks.map((packet) => packet.adapter_type), ["chatgpt", "chatgpt"]);
assert.notEqual(hooks[0].tab_id, hooks[1].tab_id);

const before = created.length;
let refused = null;
onMessage({ type: "OPEN_AND_PAIR", side: "LEFT", adapter: "" }, {}, (resp) => { refused = resp; });
assert.equal(refused.success, false);
assert.equal(created.length, before, "an empty choice opens nothing");

const claude = [];
onMessage({ type: "OPEN_AND_PAIR", side: "LEFT", adapter: "claude" }, {}, (resp) => claude.push(resp));
onMessage({ type: "OPEN_AND_PAIR", side: "RIGHT", adapter: "claude" }, {}, (resp) => claude.push(resp));
assert.equal(claude[0].success, true);
assert.equal(claude[1].success, true);
assert.notEqual(claude[0].tabId, claude[1].tabId);
assert.equal(created.filter((tab) => tab.url === "https://claude.ai/new").length, 2);

// The popup dropdowns are filled from those same four choices. Changing one
// asks the extension to open and pair it. Changing both to the same choice
// sends two requests.
const popupHtml = fs.readFileSync(path.join(root, "popup.html"), "utf8");
assert.match(popupHtml, /id="sideLeft"/);
assert.match(popupHtml, /id="sideRight"/);
assert.match(popupHtml, /Nothing opens until you do/);
assert.doesNotMatch(popupHtml, /btnPairLeft/);

const popupSent = [];
const selects = {};
function makeSelect(id) {
  const options = [];
  const select = {
    id,
    value: "",
    innerHTML: "",
    appendChild(option) { options.push(option); },
    addEventListener(type, fn) { select["on" + type] = fn; },
  };
  Object.defineProperty(select, "options", { get() { return options; } });
  selects[id] = select;
  return select;
}
const elements = {
  stateBadge: { className: "", innerText: "" },
  turnCount: { innerText: "" },
  lastMsgId: { innerText: "" },
  ipcStatus: { innerText: "" },
  modeStatus: { innerText: "" },
  lastError: { innerText: "", style: {} },
  statusMessage: { innerText: "Choose LEFT and RIGHT. Nothing opens until you do." },
  sideLeft: makeSelect("sideLeft"),
  sideRight: makeSelect("sideRight"),
  btnStart: { addEventListener() {} },
  btnPause: { addEventListener() {}, classList: { add() {}, remove() {} } },
  btnStop: { addEventListener() {} },
  btnForwardLR: { addEventListener() {} },
  btnForwardRL: { addEventListener() {} },
  maxTurns: { value: "50", addEventListener() {} },
  btnApplyMax: { addEventListener() {} },
  btnOpenData: { addEventListener() {} },
  btnOpenLog: { addEventListener() {} },
  loginEmail: { value: "", style: {}, addEventListener() {} },
  loginPassword: { value: "", style: {}, placeholder: "", addEventListener() {} },
  loginSaved: { innerText: "" },
  loginService: { value: "chatgpt", addEventListener() {} },
  loginAction: { value: "save", addEventListener() {} },
  btnApplyLogin: { innerText: "", addEventListener() {} },
};
const popup = {
  document: {
    addEventListener(type, fn) { if (type === "DOMContentLoaded") fn(); },
    getElementById(id) { return elements[id]; },
    createElement() { return { value: "", textContent: "" }; },
  },
  SideraSites: context.SideraSites,
  chrome: {
    runtime: {
      lastError: null,
      sendMessage(message, callback) {
        popupSent.push(message);
        if (callback) callback({ ok: true, saved: false, service: message.service, success: true, label: "ChatGPT" });
      },
      onMessage: { addListener() {} },
    },
  },
};
popup.globalThis = popup;
vm.createContext(popup);
vm.runInContext(fs.readFileSync(path.join(root, "popup.js"), "utf8"), popup);
assert.deepEqual(selects.sideLeft.options.map((option) => option.value), ["", "chatgpt", "grok", "gemini", "claude"]);
assert.deepEqual(selects.sideRight.options.map((option) => option.textContent), ["Choose", "ChatGPT", "Grok", "Gemini", "Claude"]);
assert.equal(elements.statusMessage.innerText, "Choose LEFT and RIGHT. Nothing opens until you do.");
assert.equal(popupSent.filter((message) => message.type === "OPEN_AND_PAIR").length, 0);

selects.sideLeft.value = "gemini";
selects.sideLeft.onchange();
selects.sideRight.value = "gemini";
selects.sideRight.onchange();
const opens = popupSent.filter((message) => message.type === "OPEN_AND_PAIR");
assert.equal(JSON.stringify(opens), JSON.stringify([
  { type: "OPEN_AND_PAIR", side: "LEFT", adapter: "gemini" },
  { type: "OPEN_AND_PAIR", side: "RIGHT", adapter: "gemini" },
]));

console.log("open and pair checks passed");
