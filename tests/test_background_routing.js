// Exercises background.js against a fake chrome API: either side can pair any
// supported site, the same site can sit on both sides in two tabs, messages
// route by tab id (never bouncing back to the sender), the same tab can never
// hold both sides, and Start checks each side's own site sign-in.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..", "chrome-extension");

function makeHarness() {
  const tabs = new Map();
  const sentToTabs = [];
  const posted = []; // messages the background sends to the Python mediator
  const timers = [];
  const listeners = { onMessage: null, onUpdated: null, nativeOnMessage: null };
  // How a tab answers chrome.tabs.sendMessage; tests override per message type.
  let tabResponder = () => undefined;

  const chrome = {
    runtime: {
      lastError: null,
      connectNative() {
        return {
          onMessage: { addListener(fn) { listeners.nativeOnMessage = fn; } },
          onDisconnect: { addListener() {} },
          postMessage(msg) { posted.push(msg); },
        };
      },
      sendMessage() { return Promise.resolve(); },
      onMessage: { addListener(fn) { listeners.onMessage = fn; } },
    },
    storage: {
      session: {
        get(keys, cb) { cb({}); },
        set() { return Promise.resolve(); },
      },
    },
    tabs: {
      get(tabId, cb) {
        const tab = tabs.get(tabId) || null;
        chrome.runtime.lastError = tab ? null : { message: `No tab with id ${tabId}` };
        cb(tab);
        chrome.runtime.lastError = null;
      },
      query(info, cb) {
        let result = [...tabs.values()];
        if (info && info.active) result = result.filter((t) => t.active);
        cb(result);
      },
      sendMessage(tabId, msg, cb) {
        sentToTabs.push({ tabId, msg });
        const response = tabResponder(tabId, msg);
        if (cb) cb(response);
      },
      update() {},
      onUpdated: { addListener(fn) { listeners.onUpdated = fn; } },
    },
    windows: { update() {} },
    debugger: { attach: async () => {}, sendCommand: async () => {}, detach: async () => {} },
  };

  const ctx = {
    console: { log() {}, warn() {}, error() {} },
    setTimeout(fn, ms) { timers.push({ fn, ms }); return timers.length; },
    clearTimeout() {},
    setInterval: () => 1,
    clearInterval() {},
    URL,
    chrome,
    importScripts(...files) {
      for (const file of files) {
        vm.runInContext(fs.readFileSync(path.join(root, file), "utf8"), ctx);
      }
    },
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(root, "background.js"), "utf8"), ctx);

  return {
    addTab(id, url, active = false) { tabs.set(id, { id, url, title: `tab-${id}`, status: "complete", active, index: id, windowId: 1 }); },
    removeTab(id) { tabs.delete(id); },
    setTabResponder(fn) { tabResponder = fn; },
    // A popup/content message into the background; returns the response.
    dispatch(request) {
      let response;
      listeners.onMessage(request, {}, (resp) => { response = resp; });
      return response;
    },
    fromMediator(msg) { listeners.nativeOnMessage(msg); },
    tabNavigated(tabId) { listeners.onUpdated(tabId, { status: "complete" }); },
    sentToTabs,
    posted,
  };
}

const sends = (harness, type) => harness.sentToTabs.filter((entry) => entry.msg.type === type);
// Objects born inside the vm have a different Object prototype; strip it so
// strict deep equality compares structure only.
const plain = (value) => JSON.parse(JSON.stringify(value));

// ChatGPT on BOTH sides, two separate tabs: the headline case.
{
  const h = makeHarness();
  h.addTab(11, "https://chatgpt.com/c/first", true);
  h.addTab(22, "https://chatgpt.com/c/second");

  const left = h.dispatch({ type: "PAIR_TAB", side: "LEFT", adapterType: "chatgpt", tabId: 11 });
  assert.deepEqual(plain(left), { success: true, slotId: "LEFT", adapterType: "chatgpt", tabId: 11 });
  const right = h.dispatch({ type: "PAIR_TAB", side: "RIGHT", adapterType: "chatgpt", tabId: 22 });
  assert.deepEqual(plain(right), { success: true, slotId: "RIGHT", adapterType: "chatgpt", tabId: 22 });

  const assigns = sends(h, "ASSIGN_HEMISPHERE");
  assert.deepEqual(assigns.map((a) => [a.tabId, a.msg.hemisphere, a.msg.adapterType]), [
    [11, "LEFT", "chatgpt"],
    [22, "RIGHT", "chatgpt"],
  ]);
  const hooks = h.posted.filter((m) => m.type === "HOOK_SLOT");
  assert.deepEqual(plain(hooks), [
    { type: "HOOK_SLOT", slot_id: "LEFT", adapter_type: "chatgpt", tab_id: 11 },
    { type: "HOOK_SLOT", slot_id: "RIGHT", adapter_type: "chatgpt", tab_id: 22 },
  ]);

  // Messages route by tab id: RIGHT-bound text lands only in tab 22,
  // LEFT-bound only in tab 11 — never back at the sender.
  h.fromMediator({ type: "SUBMIT_MESSAGE", destination: "RIGHT", text: "to the right", message_id: "SIDERA-0000001" });
  h.fromMediator({ type: "SUBMIT_MESSAGE", destination: "LEFT", text: "to the left", message_id: "SIDERA-0000002" });
  const injected = sends(h, "INJECT_AND_SUBMIT");
  assert.deepEqual(injected.map((entry) => [entry.tabId, entry.msg.text]), [
    [22, "to the right"],
    [11, "to the left"],
  ]);

  // The same tab can never hold both sides; the registry is unchanged.
  const conflict = h.dispatch({ type: "PAIR_TAB", side: "RIGHT", adapterType: "chatgpt", tabId: 11 });
  assert.equal(conflict.success, false);
  assert.match(conflict.error, /already paired as LEFT/);
  const status = h.dispatch({ type: "GET_STATUS" });
  assert.equal(status.slots.LEFT.tabId, 11);
  assert.equal(status.slots.RIGHT.tabId, 22);
  assert.equal(status.slots.LEFT.adapter, "chatgpt");
  assert.equal(status.slots.RIGHT.adapter, "chatgpt");

  // Start checks the ChatGPT sign-in in EACH tab, then starts the exchange.
  h.setTabResponder((tabId, msg) => (msg.type === "ENSURE_ACCOUNT_LOGIN" ? { loggedIn: true } : undefined));
  const started = h.dispatch({ type: "START", initial_hemisphere: "LEFT" });
  assert.deepEqual(plain(started), { ok: true });
  const loginChecks = sends(h, "ENSURE_ACCOUNT_LOGIN");
  assert.deepEqual(loginChecks.map((entry) => [entry.tabId, entry.msg.service]), [
    [11, "chatgpt"],
    [22, "chatgpt"],
  ]);
  assert.ok(h.posted.some((m) => m.type === "START" && m.initial_hemisphere === "LEFT"));

  // After a full page load (new chat or reload), the tab is re-assigned the
  // same hemisphere — still by tab id.
  h.tabNavigated(22);
  const reassigns = sends(h, "ASSIGN_HEMISPHERE");
  assert.deepEqual(reassigns[reassigns.length - 1].tabId, 22);
  assert.equal(reassigns[reassigns.length - 1].msg.hemisphere, "RIGHT");
}

// Grok vs Grok: same-site routing and the grok sign-in check on both tabs.
{
  const h = makeHarness();
  h.addTab(41, "https://grok.com/chat/a");
  h.addTab(42, "https://grok.com/chat/b");
  assert.equal(h.dispatch({ type: "PAIR_TAB", side: "LEFT", adapterType: "grok", tabId: 41 }).success, true);
  assert.equal(h.dispatch({ type: "PAIR_TAB", side: "RIGHT", adapterType: "grok", tabId: 42 }).success, true);

  h.fromMediator({ type: "SUBMIT_MESSAGE", destination: "LEFT", text: "left gets this", message_id: "SIDERA-0000003" });
  const injected = sends(h, "INJECT_AND_SUBMIT");
  assert.deepEqual(injected.map((entry) => entry.tabId), [41]);

  h.setTabResponder((tabId, msg) => (msg.type === "ENSURE_ACCOUNT_LOGIN" ? { loggedIn: true } : undefined));
  assert.deepEqual(plain(h.dispatch({ type: "START" })), { ok: true });
  assert.deepEqual(sends(h, "ENSURE_ACCOUNT_LOGIN").map((entry) => [entry.tabId, entry.msg.service]), [
    [41, "grok"],
    [42, "grok"],
  ]);
}

// Gemini vs Gemini: no scripted sign-in exists, so Start goes straight on.
{
  const h = makeHarness();
  h.addTab(51, "https://gemini.google.com/app");
  h.addTab(52, "https://gemini.google.com/app");
  assert.equal(h.dispatch({ type: "PAIR_TAB", side: "LEFT", adapterType: "gemini", tabId: 51 }).success, true);
  assert.equal(h.dispatch({ type: "PAIR_TAB", side: "RIGHT", adapterType: "gemini", tabId: 52 }).success, true);
  assert.deepEqual(plain(h.dispatch({ type: "START" })), { ok: true });
  assert.equal(sends(h, "ENSURE_ACCOUNT_LOGIN").length, 0, "no login flow for Gemini");
  assert.ok(h.posted.some((m) => m.type === "START"));
}

// Mixed pairing the other way round: Grok as LEFT, ChatGPT as RIGHT.
{
  const h = makeHarness();
  h.addTab(61, "https://grok.com/");
  h.addTab(62, "https://chatgpt.com/");
  assert.equal(h.dispatch({ type: "PAIR_TAB", side: "LEFT", adapterType: "grok", tabId: 61 }).success, true);
  assert.equal(h.dispatch({ type: "PAIR_TAB", side: "RIGHT", adapterType: "chatgpt", tabId: 62 }).success, true);
  h.setTabResponder((tabId, msg) => (msg.type === "ENSURE_ACCOUNT_LOGIN" ? { loggedIn: true } : undefined));
  assert.deepEqual(plain(h.dispatch({ type: "START" })), { ok: true });
  assert.deepEqual(sends(h, "ENSURE_ACCOUNT_LOGIN").map((entry) => [entry.tabId, entry.msg.service]), [
    [61, "grok"],
    [62, "chatgpt"],
  ]);
}

// Legacy popup messages (no adapterType, no tabId) keep today's behavior:
// the active tab is paired and the defaults are LEFT ChatGPT, RIGHT Grok.
{
  const h = makeHarness();
  h.addTab(71, "https://chatgpt.com/", true);
  const left = h.dispatch({ type: "PAIR_TAB", side: "LEFT" });
  assert.equal(left.success, true);
  assert.equal(left.tabId, 71);
  assert.equal(left.adapterType, "chatgpt");

  h.removeTab(71);
  h.addTab(72, "https://grok.com/", true);
  const right = h.dispatch({ type: "PAIR_TAB", side: "RIGHT" });
  assert.equal(right.success, true);
  assert.equal(right.tabId, 72);
  assert.equal(right.adapterType, "grok");
}

// A closed tab cannot be paired, and Start without a LEFT tab is refused.
{
  const h = makeHarness();
  const gone = h.dispatch({ type: "PAIR_TAB", side: "LEFT", adapterType: "chatgpt", tabId: 99 });
  assert.equal(gone.success, false);
  assert.match(gone.error, /no longer open/);
  const started = h.dispatch({ type: "START" });
  assert.equal(started.ok, false);
  assert.match(started.error, /Pair a tab as LEFT/);
}

console.log("background routing ok");
