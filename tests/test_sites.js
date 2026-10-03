// Side selection rules: which site a tab URL belongs to, per-side adapter
// defaults, login-service lookup, and the one hard rule of same-site pairing:
// both sides may use the same site, but never the same tab.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../chrome-extension/sites.js"), "utf8");
const context = { URL };
context.globalThis = context;
vm.runInNewContext(source, context);
const Sites = context.globalThis.SideraSites;

// URL -> site, including login hosts and Grok inside X.
assert.equal(Sites.siteForUrl("https://chatgpt.com/"), "chatgpt");
assert.equal(Sites.siteForUrl("https://chatgpt.com/c/abc123"), "chatgpt");
assert.equal(Sites.siteForUrl("https://auth.openai.com/log-in"), "chatgpt");
assert.equal(Sites.siteForUrl("https://grok.com/chat"), "grok");
assert.equal(Sites.siteForUrl("https://accounts.x.ai/sign-in"), "grok");
assert.equal(Sites.siteForUrl("https://x.com/i/grok"), "grok");
assert.equal(Sites.siteForUrl("https://x.com/i/flow/login"), "grok");
assert.equal(Sites.siteForUrl("https://x.com/home"), null, "plain X is not a Sidera site");
assert.equal(Sites.siteForUrl("https://gemini.google.com/app"), "gemini");
assert.equal(Sites.siteForUrl("https://example.com/"), null);
assert.equal(Sites.siteForUrl("http://chatgpt.com/"), null, "only https counts");
assert.equal(Sites.siteForUrl("not a url"), null);
assert.equal(Sites.siteForUrl(""), null);

assert.equal(Sites.urlMatchesAdapter("chatgpt", "https://chatgpt.com/"), true);
assert.equal(Sites.urlMatchesAdapter("grok", "https://chatgpt.com/"), false);

// Any supported site is accepted for either side; defaults match the old
// hard-wired behavior (LEFT ChatGPT, RIGHT Grok); unsupported names fall
// back to the side default instead of inventing a new site.
assert.equal(Sites.normalizeAdapter("chatgpt", "RIGHT"), "chatgpt");
assert.equal(Sites.normalizeAdapter("gemini", "LEFT"), "gemini");
assert.equal(Sites.normalizeAdapter("grok", "LEFT"), "grok");
assert.equal(Sites.normalizeAdapter(undefined, "LEFT"), "chatgpt");
assert.equal(Sites.normalizeAdapter(undefined, "RIGHT"), "grok");
assert.equal(Sites.normalizeAdapter("claude", "RIGHT"), "grok", "unsupported site falls back");
assert.equal(Sites.normalizeAdapter("CHATGPT", "RIGHT"), "chatgpt", "case-insensitive");

assert.equal(Sites.adapterLabel("chatgpt"), "ChatGPT");
assert.equal(Sites.adapterLabel("grok"), "Grok");
assert.equal(Sites.adapterLabel("gemini"), "Gemini");

assert.equal(Sites.loginServiceFor("chatgpt"), "chatgpt");
assert.equal(Sites.loginServiceFor("grok"), "grok");
assert.equal(Sites.loginServiceFor("gemini"), null, "Gemini has no scripted login");

assert.equal(Sites.otherSide("LEFT"), "RIGHT");
assert.equal(Sites.otherSide("RIGHT"), "LEFT");

// Same tab on both sides is rejected; a different tab of the same site is fine.
const registry = { LEFT: { adapter: "chatgpt", tabId: 11 }, RIGHT: { adapter: "chatgpt", tabId: 22 } };
assert.ok(Sites.pairingConflict(registry, "RIGHT", 11), "LEFT's tab cannot also be RIGHT");
assert.ok(Sites.pairingConflict(registry, "LEFT", 22), "RIGHT's tab cannot also be LEFT");
assert.equal(Sites.pairingConflict(registry, "RIGHT", 33), null, "a third tab is fine");
assert.equal(Sites.pairingConflict(registry, "LEFT", 11), null, "re-pairing the same side is fine");
assert.equal(Sites.pairingConflict({ LEFT: { adapter: "chatgpt", tabId: null }, RIGHT: {} }, "RIGHT", 11), null, "unpaired side never conflicts");

// Plain state wording for the popup: never raw machine names.
assert.equal(Sites.stateLabel("WAIT_LEFT"), "Waiting for LEFT");
assert.equal(Sites.stateLabel("WAIT_RIGHT"), "Waiting for RIGHT");
assert.equal(Sites.stateLabel("SEND_RIGHT"), "Sending to RIGHT");
assert.equal(Sites.stateLabel("PROCESS"), "Processing");
assert.equal(Sites.stateLabel("IDLE"), "Idle");
assert.equal(Sites.stateLabel("PAUSED"), "Paused");
// Same wording as the popup's "Sidera program: Not running" row.
assert.equal(Sites.stateLabel("DISCONNECTED"), "Not running");
assert.equal(Sites.stateLabel("SOMETHING_NEW"), "SOMETHING_NEW", "unknown states pass through");

// Plain wording for Chrome's internal messaging errors.
const plain = Sites.plainTabError("Could not establish connection. Receiving end does not exist.", "the LEFT tab");
assert.ok(!/receiving end/i.test(plain));
assert.match(plain, /Reload the tab/);
assert.match(Sites.plainTabError("No tab with id 42", "the RIGHT tab"), /no longer open/);

assert.equal(Sites.homeUrl("chatgpt"), "https://chatgpt.com/");
assert.equal(Sites.homeUrl("grok"), "https://grok.com/");
assert.equal(Sites.homeUrl("gemini"), "https://gemini.google.com/app");

// Picker preselection: the operator's choice wins, then the side's paired
// tab, then a tab the other side is NOT using (so two same-site pickers
// never default to the same tab), preferring the active one.
const tabs = [
  { id: 1, active: false },
  { id: 2, active: true },
  { id: 3, active: false },
];
assert.equal(Sites.chooseTab(tabs, { previousValue: 3 }), 3, "operator's selection is kept");
assert.equal(Sites.chooseTab(tabs, { pairedTabId: 1 }), 1, "paired tab is shown");
assert.equal(Sites.chooseTab(tabs, {}), 2, "active tab by default");
assert.equal(Sites.chooseTab(tabs, { avoidTabIds: [2] }), 1, "the other side's tab is skipped");
assert.equal(Sites.chooseTab(tabs, { avoidTabIds: [1, 2] }), 3);
assert.equal(Sites.chooseTab([{ id: 7, active: true }], { avoidTabIds: [7] }), 7, "a lone tab is still offered");
assert.equal(Sites.chooseTab([], {}), null);

// Tab labels carry the window and the chat title so two same-site tabs can
// be told apart.
assert.equal(Sites.describeTab({ id: 1, title: "Gyrocell brainstorming" }, { windowNumber: 2, multiWindow: true }), "Window 2: Gyrocell brainstorming");
assert.equal(Sites.describeTab({ id: 1, title: "ChatGPT" }, { windowNumber: 1, multiWindow: false }), "ChatGPT");
assert.equal(Sites.describeTab({ id: 1, title: "ChatGPT" }, { windowNumber: 1, multiWindow: false, pairedAs: "LEFT" }), "ChatGPT — paired as LEFT");
assert.equal(Sites.describeTab({ id: 1, title: "" }, {}), "(untitled tab)");
// Two same-site tabs in ONE window often share the title "ChatGPT": they get
// a number so they can be told apart.
const sameWindow = [
  { id: 5, windowId: 1, index: 3, title: "ChatGPT" },
  { id: 4, windowId: 1, index: 1, title: "ChatGPT" },
  { id: 9, windowId: 2, index: 0, title: "ChatGPT" },
];
const numbers = Sites.tabNumbers(sameWindow);
assert.equal(numbers.get(4), 1);
assert.equal(numbers.get(5), 2);
assert.equal(numbers.has(9), false, "a tab alone in its window needs no number");
assert.equal(Sites.describeTab(sameWindow[1], { tabNumber: numbers.get(4) }), "Tab 1: ChatGPT");
assert.equal(Sites.describeTab(sameWindow[0], { tabNumber: numbers.get(5) }), "Tab 2: ChatGPT");
assert.notEqual(
  Sites.describeTab(sameWindow[0], { tabNumber: 2 }),
  Sites.describeTab(sameWindow[1], { tabNumber: 1 }),
  "same-title tabs never read the same",
);
assert.equal(Sites.describeTab(sameWindow[0], { windowNumber: 1, multiWindow: true, tabNumber: 2 }), "Window 1, tab 2: ChatGPT");
// A freshly opened tab only has pendingUrl until it commits.
assert.equal(Sites.siteForUrl(Sites.tabUrl({ url: "", pendingUrl: "https://chatgpt.com/" })), "chatgpt");
assert.equal(Sites.tabUrl({ url: "https://grok.com/", pendingUrl: "https://chatgpt.com/" }), "https://grok.com/");
const long = Sites.describeTab({ id: 1, title: "A very long conversation title that keeps going and going" }, {});
assert.ok(long.length <= 41 && long.endsWith("…"), long);

// The popup itself, against a tiny fake DOM and chrome API: same-window
// ChatGPT tabs are numbered, the AI pick is saved before Pair, the wording is
// plain, and a window opened with "Open in a new window" is preselected when
// its tab appears (on a tab event, not after a guessed delay).
{
  const popupHtml = fs.readFileSync(path.join(__dirname, "../chrome-extension/popup.html"), "utf8");
  assert.ok(!/Open another tab/.test(popupHtml), "the button says it opens a window");
  assert.match(popupHtml, /Open in a new window/);
  assert.ok(!/Last Message ID/.test(popupHtml));
  assert.ok(!/>Mode:</.test(popupHtml));

  class FakeElement {
    constructor(id) {
      this.id = id; this.children = []; this.listeners = {}; this.innerText = ""; this.style = {};
      this._value = undefined; this.placeholder = "";
      const classes = new Set();
      this.classList = { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) };
    }
    set innerHTML(v) { this.children = []; this._value = undefined; }
    get value() {
      if (this._value !== undefined) return this._value;
      return this.children.length ? this.children[0].value : "";
    }
    set value(v) { this._value = String(v); }
    get selectedOptions() { const v = this.value; return this.children.filter((c) => c.value === v); }
    appendChild(child) { this.children.push(child); }
    addEventListener(type, fn) { this.listeners[type] = fn; }
    fire(type) { this.listeners[type](); }
  }
  const elements = new Map();
  const document = {
    getElementById(id) { if (!elements.has(id)) elements.set(id, new FakeElement(id)); return elements.get(id); },
    createElement() { return new FakeElement(null); },
    addEventListener(type, fn) { this.ready = fn; },
  };
  document.getElementById("siteLeft").value = "chatgpt";
  document.getElementById("siteRight").value = "grok";
  document.getElementById("loginService").value = "chatgpt";
  document.getElementById("loginAction").value = "save";

  const tabs = [
    { id: 11, windowId: 1, index: 0, title: "ChatGPT", url: "https://chatgpt.com/", active: true },
    { id: 12, windowId: 1, index: 1, title: "ChatGPT", url: "https://chatgpt.com/" },
  ];
  const sentToBackground = [];
  const tabEvents = { created: [], updated: [], removed: [] };
  const timers = [];
  let createdWindow = null;
  const chrome = {
    runtime: {
      lastError: null,
      sendMessage(msg, cb) {
        sentToBackground.push(msg);
        if (msg.type === "GET_STATUS" && cb) {
          cb({ state: "DISCONNECTED", connected: false, autonomousSubmissions: true, slots: {}, choices: { LEFT: "chatgpt", RIGHT: "chatgpt" } });
        }
      },
      onMessage: { addListener() {} },
    },
    tabs: {
      query(info, cb) { cb(tabs.slice()); },
      onCreated: { addListener(fn) { tabEvents.created.push(fn); } },
      onUpdated: { addListener(fn) { tabEvents.updated.push(fn); } },
      onRemoved: { addListener(fn) { tabEvents.removed.push(fn); } },
    },
    windows: {
      create(opts, cb) {
        createdWindow = { id: 2, tabs: [{ id: 21, windowId: 2, index: 0, title: "", url: "", pendingUrl: opts.url }] };
        cb(createdWindow);
      },
    },
  };
  const popupContext = {
    document, chrome, URL, console,
    setTimeout(fn) { timers.push(fn); return timers.length; },
    clearTimeout() {},
  };
  popupContext.globalThis = popupContext;
  vm.createContext(popupContext);
  vm.runInContext(source, popupContext);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../chrome-extension/popup.js"), "utf8"), popupContext);
  document.ready();

  // Saved choices are shown: RIGHT was picked as ChatGPT before any pairing.
  assert.equal(document.getElementById("siteRight").value, "chatgpt");
  assert.equal(document.getElementById("stateBadge").innerText, "Not running");
  assert.match(document.getElementById("ipcStatus").innerText, /^Not running/);
  assert.match(document.getElementById("modeStatus").innerText, /^On — Sidera pastes/);

  const labels = document.getElementById("tabLeft").children.map((o) => o.innerText);
  assert.deepEqual(labels, ["Tab 1: ChatGPT", "Tab 2: ChatGPT"], "two same-window ChatGPT tabs read differently");
  assert.notEqual(document.getElementById("tabLeft").value, document.getElementById("tabRight").value, "the two pickers start on different tabs");

  // Picking an AI is saved at once, before Pair.
  document.getElementById("siteLeft").value = "gemini";
  document.getElementById("siteLeft").fire("change");
  const choice = sentToBackground.find((m) => m.type === "SET_ADAPTER_CHOICE");
  assert.deepEqual(JSON.parse(JSON.stringify(choice)), { type: "SET_ADAPTER_CHOICE", side: "LEFT", adapterType: "gemini" });

  // "Open in a new window": the new tab is preselected once it is listed,
  // driven by the tab events.
  document.getElementById("btnOpenRight").fire("click");
  assert.equal(createdWindow.tabs[0].pendingUrl, "https://chatgpt.com/");
  tabs.push(createdWindow.tabs[0]);
  tabEvents.created.forEach((fn) => fn(createdWindow.tabs[0]));
  while (timers.length) timers.shift()();
  assert.equal(document.getElementById("tabRight").value, "21", "the new window's tab is preselected");
  assert.match(document.getElementById("statusMessage").innerText, /new window/);
}

console.log("sites checks passed");
