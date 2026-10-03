// Exercises background.js against a fake chrome API: either side can pair any
// supported site, the same site can sit on both sides in two tabs, messages
// route by tab id (never bouncing back to the sender), the same tab can never
// hold both sides, and Start checks each side's own site sign-in.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..", "chrome-extension");

function makeHarness({ localStore = {} } = {}) {
  const tabs = new Map();
  const sentToTabs = [];
  const posted = []; // messages the background sends to the Python mediator
  const timers = [];
  const listeners = { onMessage: null, onUpdated: null, onRemoved: null, onReplaced: null, nativeOnMessage: null };
  // How a tab answers chrome.tabs.sendMessage; tests override per message type.
  // Returning { __error: "..." } simulates a tab with no content script.
  let tabResponder = (tabId, msg) => (msg.type === "ASSIGN_HEMISPHERE" ? { status: "paired" } : undefined);

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
      local: {
        get(keys, cb) { cb({ ...localStore }); },
        set(items, cb) { Object.assign(localStore, items); if (cb) cb(); },
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
        if (response && response.__error) {
          chrome.runtime.lastError = { message: response.__error };
          if (cb) cb(undefined);
          chrome.runtime.lastError = null;
          return;
        }
        if (cb) cb(response);
      },
      update() {},
      onUpdated: { addListener(fn) { listeners.onUpdated = fn; } },
      onRemoved: { addListener(fn) { listeners.onRemoved = fn; } },
      onReplaced: { addListener(fn) { listeners.onReplaced = fn; } },
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
    // Pass a tab id as `fromTab` for messages that come from a content script.
    dispatch(request, fromTab) {
      let response;
      const sender = fromTab != null ? { tab: { id: fromTab } } : {};
      listeners.onMessage(request, sender, (resp) => { response = resp; });
      return response;
    },
    fromMediator(msg) { listeners.nativeOnMessage(msg); },
    tabNavigated(tabId) { listeners.onUpdated(tabId, { status: "complete" }, tabs.get(tabId)); },
    closeTab(tabId) { tabs.delete(tabId); listeners.onRemoved(tabId); },
    replaceTab(oldId, newId, url) {
      tabs.delete(oldId);
      tabs.set(newId, { id: newId, url, title: `tab-${newId}`, status: "complete", active: false, index: newId, windowId: 1 });
      listeners.onReplaced(newId, oldId);
    },
    localStore,
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
  assert.match(started.error, /Pair a tab as LEFT and a tab as RIGHT/);
}

// Start is refused with a clear message naming the side that is missing,
// instead of starting a handshake that would stall silently.
{
  const h = makeHarness();
  h.addTab(11, "https://chatgpt.com/");
  h.addTab(12, "https://grok.com/");
  assert.equal(h.dispatch({ type: "PAIR_TAB", side: "LEFT", adapterType: "chatgpt", tabId: 11 }).success, true);
  const onlyLeft = h.dispatch({ type: "START" });
  assert.equal(onlyLeft.ok, false);
  assert.equal(onlyLeft.error, "Pair a tab as RIGHT before starting.");
  assert.ok(!h.posted.some((m) => m.type === "START"), "no START reaches the mediator");

  const h2 = makeHarness();
  h2.addTab(12, "https://grok.com/");
  assert.equal(h2.dispatch({ type: "PAIR_TAB", side: "RIGHT", adapterType: "grok", tabId: 12 }).success, true);
  const onlyRight = h2.dispatch({ type: "START" });
  assert.equal(onlyRight.ok, false);
  assert.equal(onlyRight.error, "Pair a tab as LEFT before starting.");
}

// REGRESSION (audit HIGH): inbound replies are attributed by the sender's tab
// id against the registry. A leftover same-site tab that was re-paired away
// can never speak for a side, and is told to stand down.
{
  const h = makeHarness();
  h.addTab(11, "https://chatgpt.com/c/old");
  h.addTab(22, "https://chatgpt.com/c/right");
  h.addTab(33, "https://chatgpt.com/c/new-left");
  assert.equal(h.dispatch({ type: "PAIR_TAB", side: "LEFT", adapterType: "chatgpt", tabId: 11 }).success, true);
  assert.equal(h.dispatch({ type: "PAIR_TAB", side: "RIGHT", adapterType: "chatgpt", tabId: 22 }).success, true);

  // Re-pair LEFT to tab 33: the old tab 11 is told to stand down.
  assert.equal(h.dispatch({ type: "PAIR_TAB", side: "LEFT", adapterType: "chatgpt", tabId: 33 }).success, true);
  assert.deepEqual(sends(h, "UNASSIGN_HEMISPHERE").map((entry) => entry.tabId), [11]);

  // A reply from the stray old tab claiming LEFT is dropped, not forwarded,
  // and the stray is told to stand down again.
  h.dispatch({ type: "RESPONSE_CAPTURED", source: "LEFT", content: "stray reply" }, 11);
  assert.equal(h.posted.filter((m) => m.type === "RESPONSE_CAPTURED").length, 0, "stray reply never reaches the mediator");
  assert.deepEqual(sends(h, "UNASSIGN_HEMISPHERE").map((entry) => entry.tabId), [11, 11]);

  // The real LEFT tab's reply is forwarded.
  h.dispatch({ type: "RESPONSE_CAPTURED", source: "LEFT", content: "real left reply", fresh: true }, 33);
  const captured = h.posted.filter((m) => m.type === "RESPONSE_CAPTURED");
  assert.equal(captured.length, 1);
  assert.equal(captured[0].source, "LEFT");
  assert.equal(captured[0].content, "real left reply");
  assert.equal(captured[0].fresh, true);

  // The side label comes from the registry, never from the page: RIGHT's tab
  // claiming to be LEFT is forwarded as RIGHT.
  h.dispatch({ type: "RESPONSE_CAPTURED", source: "LEFT", content: "mislabeled" }, 22);
  const relabeled = h.posted.filter((m) => m.type === "RESPONSE_CAPTURED");
  assert.equal(relabeled.length, 2);
  assert.equal(relabeled[1].source, "RIGHT");

  // Same rule for the other content events.
  h.dispatch({ type: "SUBMISSION_CONFIRMED", destination: "LEFT", message_id: "SIDERA-1" }, 22);
  const confirms = h.posted.filter((m) => m.type === "SUBMISSION_CONFIRMED");
  assert.equal(confirms.length, 1);
  assert.equal(confirms[0].destination, "RIGHT");
  h.dispatch({ type: "INJECTION_ERROR", hemisphere: "RIGHT", message_id: "SIDERA-2", error: "x" }, 11);
  assert.equal(h.posted.filter((m) => m.type === "INJECTION_ERROR").length, 0, "stray injection error dropped");
}

// MEDIUM (audit): pairing requires the tab to acknowledge. A tab with no
// content script (opened before install, or discarded) fails with a plain
// error and the side stays unpaired.
{
  const h = makeHarness();
  h.addTab(11, "https://chatgpt.com/");
  h.setTabResponder((tabId, msg) => (msg.type === "ASSIGN_HEMISPHERE" ? { __error: "Could not establish connection. Receiving end does not exist." } : undefined));
  const resp = h.dispatch({ type: "PAIR_TAB", side: "LEFT", adapterType: "chatgpt", tabId: 11 });
  assert.equal(resp.success, false);
  assert.match(resp.error, /Reload the tab/);
  assert.ok(!/Receiving end/i.test(resp.error), "raw chrome error is not shown");
  const status = h.dispatch({ type: "GET_STATUS" });
  assert.equal(status.leftPaired, false);
  assert.ok(!h.posted.some((m) => m.type === "HOOK_SLOT"), "no HOOK_SLOT for a failed pairing");
}

// Closing a paired tab unpairs the side at once; during a run the mediator is
// paused with a plain reason, and a send to the unpaired side reports an
// INJECTION_ERROR instead of vanishing into the console.
{
  const h = makeHarness();
  h.addTab(11, "https://chatgpt.com/c/a");
  h.addTab(22, "https://chatgpt.com/c/b");
  assert.equal(h.dispatch({ type: "PAIR_TAB", side: "LEFT", adapterType: "chatgpt", tabId: 11 }).success, true);
  assert.equal(h.dispatch({ type: "PAIR_TAB", side: "RIGHT", adapterType: "chatgpt", tabId: 22 }).success, true);

  // Mediator reports a running exchange, then the RIGHT tab is closed.
  h.fromMediator({ type: "STATE_UPDATE", state: "WAIT_RIGHT", turn_count: 3 });
  h.closeTab(22);
  const status = h.dispatch({ type: "GET_STATUS" });
  assert.equal(status.rightPaired, false, "closed tab unpairs the side");
  assert.equal(status.leftPaired, true);
  assert.equal(status.slots.RIGHT.adapter, "chatgpt", "the AI choice is kept for re-pairing");
  const pauses = h.posted.filter((m) => m.type === "PAUSE");
  assert.equal(pauses.length, 1);
  assert.match(pauses[0].reason, /RIGHT \(ChatGPT\) tab was closed/);
  assert.match(pauses[0].reason, /press Resume/);

  // A send to the now-unpaired side reports a plain error to the mediator.
  h.fromMediator({ type: "SUBMIT_MESSAGE", destination: "RIGHT", text: "hello", message_id: "SIDERA-9" });
  const errors = h.posted.filter((m) => m.type === "INJECTION_ERROR");
  assert.equal(errors.length, 1);
  assert.equal(errors[0].hemisphere, "RIGHT");
  assert.match(errors[0].error, /No tab is paired as RIGHT/);

  // onReplaced behaves like a close for the old tab id.
  h.replaceTab(11, 44, "https://chatgpt.com/c/a");
  assert.equal(h.dispatch({ type: "GET_STATUS" }).leftPaired, false);
}

// The chosen AI must match the site the tab is on; the legacy active-tab path
// infers the site from the tab instead of defaulting blindly.
{
  const h = makeHarness();
  h.addTab(51, "https://gemini.google.com/app", true);
  const mismatch = h.dispatch({ type: "PAIR_TAB", side: "LEFT", adapterType: "chatgpt", tabId: 51 });
  assert.equal(mismatch.success, false);
  assert.match(mismatch.error, /on Gemini, not ChatGPT/);

  const legacy = h.dispatch({ type: "PAIR_TAB", side: "LEFT" });
  assert.equal(legacy.success, true);
  assert.equal(legacy.adapterType, "gemini", "legacy pairing reads the site from the tab");

  h.addTab(52, "https://example.com/", true);
  h.removeTab(51);
  const unsupported = h.dispatch({ type: "PAIR_TAB", side: "RIGHT", tabId: 52 });
  assert.equal(unsupported.success, false);
  assert.match(unsupported.error, /not on a supported site/);
}

// A paired tab that navigates to a DIFFERENT supported site is unpaired (and
// a running exchange pauses); a reload on the same site just re-pairs.
{
  const h = makeHarness();
  h.addTab(11, "https://chatgpt.com/c/a");
  h.addTab(22, "https://chatgpt.com/c/b");
  assert.equal(h.dispatch({ type: "PAIR_TAB", side: "LEFT", adapterType: "chatgpt", tabId: 11 }).success, true);
  assert.equal(h.dispatch({ type: "PAIR_TAB", side: "RIGHT", adapterType: "chatgpt", tabId: 22 }).success, true);
  h.fromMediator({ type: "STATE_UPDATE", state: "WAIT_LEFT" });

  h.removeTab(11);
  h.addTab(11, "https://grok.com/");
  h.tabNavigated(11);
  const status = h.dispatch({ type: "GET_STATUS" });
  assert.equal(status.leftPaired, false, "a side cannot silently become another AI");
  const pauses = h.posted.filter((m) => m.type === "PAUSE");
  assert.equal(pauses.length, 1);
  assert.match(pauses[0].reason, /moved from ChatGPT to Grok/);
}

// The AI choices survive a browser restart through storage.local; the tab
// pairings do not (those tabs are gone).
{
  const store = {};
  const h = makeHarness({ localStore: store });
  h.addTab(61, "https://grok.com/");
  h.addTab(62, "https://gemini.google.com/app");
  assert.equal(h.dispatch({ type: "PAIR_TAB", side: "LEFT", adapterType: "grok", tabId: 61 }).success, true);
  assert.equal(h.dispatch({ type: "PAIR_TAB", side: "RIGHT", adapterType: "gemini", tabId: 62 }).success, true);
  assert.deepEqual(plain(store.adapterChoices), { LEFT: "grok", RIGHT: "gemini" });

  // "Restart": a new background with the same local store and no session.
  const h2 = makeHarness({ localStore: plain(store) });
  const status = h2.dispatch({ type: "GET_STATUS" });
  assert.equal(status.slots.LEFT.adapter, "grok");
  assert.equal(status.slots.RIGHT.adapter, "gemini");
  assert.equal(status.leftPaired, false);
  assert.equal(status.rightPaired, false);
}

// Manual forward failures use plain wording, never Chrome's internal errors.
{
  const h = makeHarness();
  h.addTab(11, "https://chatgpt.com/");
  assert.equal(h.dispatch({ type: "PAIR_TAB", side: "LEFT", adapterType: "chatgpt", tabId: 11 }).success, true);
  h.setTabResponder((tabId, msg) => (msg.type === "GET_LATEST_MESSAGE" ? { __error: "Could not establish connection. Receiving end does not exist." } : undefined));
  const resp = h.dispatch({ type: "MANUAL_FORWARD", source: "LEFT" });
  assert.equal(resp.ok, false);
  assert.ok(!/Receiving end/i.test(resp.error), "raw chrome error is not shown");
  assert.match(resp.error, /Reload the tab/);
}

console.log("background routing ok");
