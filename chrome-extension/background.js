const NATIVE_HOST_NAME = "com.sidera.mediator";

let nativePort = null;
let currentMediatorState = "IDLE";
let currentTurnCount = 0;
let lastMessageId = null;
let lastError = null;
let maxTurns = null;
let autonomousSubmissions = true;
// Set while Start is waiting for the operator to finish ChatGPT sign-in.
let signInMessage = null;
let loginWaitGeneration = 0;
const LOGIN_POLL_MS = 1500;
const LOGIN_WAIT_MS = 10 * 60 * 1000;
// Genesis Protocol text from the mediator; a tab that starts a fresh chat
// re-teaches it before continuing.
let genesisText = "";
// Tuning from config.toml that content scripts need (e.g. rotate_after_pastes).
let contentSettings = {};
// Content scripts waiting for a catch-up brief (CONTEXT_REQUEST -> CONTEXT_BRIEF).
const briefWaiters = { LEFT: [], RIGHT: [] };
const BRIEF_TIMEOUT_MS = 8000;

const slotRegistry = {
  LEFT: { adapter: "chatgpt", tabId: null },
  RIGHT: { adapter: "grok", tabId: null },
};

function persistSession() {
  chrome.storage.session.set({
    slotRegistry: slotRegistry,
    currentMediatorState: currentMediatorState,
    currentTurnCount: currentTurnCount,
    lastMessageId: lastMessageId,
    genesisText: genesisText,
    contentSettings: contentSettings,
  }).catch(() => {});
}

function assignTab(tabId, slotId, adapterType, callback) {
  chrome.tabs.sendMessage(tabId, {
    type: "ASSIGN_HEMISPHERE",
    hemisphere: slotId,
    adapterType: adapterType,
    genesis: genesisText,
    settings: contentSettings,
  }, callback);
}

// A paired tab that does a full page load (a site's "New chat" or a reload)
// gets a fresh content script, so hand it its hemisphere again.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== "complete") return;
  for (const slotId of Object.keys(slotRegistry)) {
    const slot = slotRegistry[slotId];
    if (!slot || slot.tabId !== tabId) continue;
    assignTab(tabId, slotId, slot.adapter, () => {
      if (chrome.runtime.lastError) {
        console.warn(`Re-pairing ${slotId} after navigation failed:`, chrome.runtime.lastError.message);
      }
    });
  }
});

function connectNative() {
  if (nativePort) return;
  console.log(`Connecting to Native Messaging host: ${NATIVE_HOST_NAME}`);
  try {
    nativePort = chrome.runtime.connectNative(NATIVE_HOST_NAME);
    nativePort.onMessage.addListener((msg) => {
      console.log("Received from Python mediator:", msg);
      handleMediatorMessage(msg);
    });
    nativePort.onDisconnect.addListener(() => {
      console.warn("Native Messaging host disconnected:", chrome.runtime.lastError?.message);
      nativePort = null;
      currentMediatorState = "DISCONNECTED";
      persistSession();
      broadcastStatus();
    });
    sendToMediator({ type: "GET_STATUS" });
  } catch (err) {
    console.error("Failed to connect to native messaging host:", err);
  }
}

function sendToMediator(payload) {
  if (!nativePort) connectNative();
  if (nativePort) {
    nativePort.postMessage(payload);
  } else {
    console.error("Cannot send to mediator: port disconnected.");
  }
}

function handleMediatorMessage(msg) {
  const type = msg.type;
  if (type === "STATE_UPDATE" || type === "STATUS_RESPONSE") {
    currentMediatorState = msg.state;
    currentTurnCount = msg.turn_count || 0;
    lastMessageId = msg.last_message_id || lastMessageId;
    lastError = msg.last_error || null;
    if (typeof msg.max_turns === "number") maxTurns = msg.max_turns;
    if (typeof msg.autonomous_submissions === "boolean") autonomousSubmissions = msg.autonomous_submissions;
    persistSession();
    broadcastStatus();
  } else if (type === "CONTEXT_BRIEF") {
    const side = (msg.hemisphere || "").toUpperCase();
    const waiters = briefWaiters[side] || [];
    briefWaiters[side] = [];
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.respond({ text: msg.text || "" });
    }
  } else if (type === "SETTINGS") {
    const { type: _ignored, ...settings } = msg;
    contentSettings = settings;
    persistSession();
    for (const slotId of Object.keys(slotRegistry)) {
      const slot = slotRegistry[slotId];
      if (slot && slot.tabId) {
        chrome.tabs.sendMessage(slot.tabId, { type: "SET_SETTINGS", settings: contentSettings }, () => {
          void chrome.runtime.lastError;
        });
      }
    }
  } else if (type === "GENESIS_TEXT") {
    genesisText = msg.text || "";
    persistSession();
    for (const slotId of Object.keys(slotRegistry)) {
      const slot = slotRegistry[slotId];
      if (slot && slot.tabId) {
        chrome.tabs.sendMessage(slot.tabId, { type: "SET_GENESIS", genesis: genesisText }, () => {
          void chrome.runtime.lastError;
        });
      }
    }
  } else if (type === "SUBMIT_MESSAGE") {
    const dest = msg.destination.toUpperCase();
    const slot = slotRegistry[dest];
    if (!slot || !slot.tabId) {
      console.error(`Cannot submit message: Target tab for slot ${dest} is not hooked/paired!`);
      return;
    }
    chrome.tabs.sendMessage(slot.tabId, {
      type: "INJECT_AND_SUBMIT",
      text: msg.text,
      message_id: msg.message_id,
    }, (response) => {
      if (chrome.runtime.lastError) {
        console.error(`Error sending to tab ${slot.tabId}:`, chrome.runtime.lastError.message);
      }
    });
  }
}

function statusSnapshot() {
  return {
    state: currentMediatorState,
    turnCount: currentTurnCount,
    maxTurns: maxTurns,
    lastMessageId: lastMessageId,
    lastError: lastError,
    autonomousSubmissions: autonomousSubmissions,
    signInMessage: signInMessage,
    leftPaired: !!slotRegistry.LEFT.tabId,
    rightPaired: !!slotRegistry.RIGHT.tabId,
    slots: slotRegistry,
    connected: !!nativePort,
  };
}

function broadcastStatus() {
  chrome.runtime.sendMessage({ type: "POPUP_STATUS_UPDATE", ...statusSnapshot() }).catch(() => {});
}

function authUrl(url) {
  return /https:\/\/auth\.openai\.com\//i.test(url || "") || /https:\/\/([^/]+\.)?chatgpt\.com\/auth/i.test(url || "");
}

// If the paired ChatGPT tab is signed out, open its login page and wait until
// the composer is back. The account password stays in Chrome.
function ensureChatGptLogin(tabId, done) {
  const generation = ++loginWaitGeneration;
  const started = Date.now();
  let focused = false;

  function finish(result) {
    if (generation !== loginWaitGeneration) return;
    done(result);
  }

  function poll() {
    if (generation !== loginWaitGeneration) return;
    if (Date.now() - started > LOGIN_WAIT_MS) {
      finish({ ok: false, error: "ChatGPT is still signed out. Sign in in that tab, then press Start again." });
      return;
    }
    chrome.tabs.get(tabId, (tab) => {
      if (generation !== loginWaitGeneration) return;
      if (chrome.runtime.lastError || !tab) {
        finish({ ok: false, error: "The ChatGPT tab is no longer open." });
        return;
      }
      if (tab.status !== "complete") {
        setTimeout(poll, 500);
        return;
      }
      if (authUrl(tab.url)) {
        signInMessage = "Sign in to ChatGPT in the browser. Sidera starts when the chat box is back.";
        if (!focused) {
          focused = true;
          chrome.tabs.update(tabId, { active: true });
          if (tab.windowId) chrome.windows.update(tab.windowId, { focused: true });
        }
        broadcastStatus();
        setTimeout(poll, LOGIN_POLL_MS);
        return;
      }
      chrome.tabs.sendMessage(tabId, { type: "ENSURE_CHATGPT_LOGIN" }, (reply) => {
        if (generation !== loginWaitGeneration) return;
        if (chrome.runtime.lastError || !reply) {
          setTimeout(poll, LOGIN_POLL_MS);
          return;
        }
        if (reply.loggedIn) {
          finish({ ok: true });
          return;
        }
        signInMessage = "Sign in to ChatGPT in the browser. Sidera starts when the chat box is back.";
        if (!focused) {
          focused = true;
          chrome.tabs.update(tabId, { active: true });
          if (tab.windowId) chrome.windows.update(tab.windowId, { focused: true });
        }
        broadcastStatus();
        setTimeout(poll, LOGIN_POLL_MS);
      });
    });
  }

  poll();
}

// Manual Forward: read the newest completed reply from one paired tab and
// hand it to the mediator as if it had just been captured (spec 10).
function manualForward(source, sendResponse) {
  const slot = slotRegistry[source];
  if (!slot || !slot.tabId) {
    sendResponse({ ok: false, error: `${source} is not paired` });
    return;
  }
  chrome.tabs.sendMessage(slot.tabId, { type: "GET_LATEST_MESSAGE" }, (reply) => {
    if (chrome.runtime.lastError || !reply || !reply.text) {
      sendResponse({ ok: false, error: (chrome.runtime.lastError && chrome.runtime.lastError.message) || `No completed reply found in the ${source} tab` });
      return;
    }
    sendToMediator({ type: "MANUAL_FORWARD", source: source, content: reply.text });
    sendResponse({ ok: true, chars: reply.text.length });
  });
}

// Some sites (Gemini) ignore synthetic clicks and key events from a content
// script and only submit on trusted input. The debugger protocol can deliver
// it, so a content script asks for it here after filling the composer: a
// click on the Send button when it knows where that is, otherwise Enter.
const ENTER_KEY = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };

async function trustedSubmit(tabId, point) {
  const target = { tabId: tabId };
  await chrome.debugger.attach(target, "1.3");
  try {
    if (point && Number.isFinite(point.x) && Number.isFinite(point.y)) {
      const mouse = { x: point.x, y: point.y, button: "left", clickCount: 1 };
      await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
      await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", { type: "mousePressed", ...mouse });
      await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", { type: "mouseReleased", ...mouse });
    } else {
      await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", { type: "keyDown", text: "\r", unmodifiedText: "\r", ...ENTER_KEY });
      await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", { type: "keyUp", ...ENTER_KEY });
    }
  } finally {
    try {
      await chrome.debugger.detach(target);
    } catch (err) {
      // Already detached; nothing to clean up.
    }
  }
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const reqType = request.type;
  if (reqType === "TRUSTED_SUBMIT" || reqType === "TRUSTED_ENTER") {
    const tabId = sender.tab && sender.tab.id;
    if (!tabId) {
      sendResponse({ ok: false, error: "no tab" });
      return false;
    }
    trustedSubmit(tabId, request.point)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => {
        console.warn("Trusted submit failed:", err && err.message ? err.message : err);
        sendResponse({ ok: false, error: err && err.message ? err.message : String(err) });
      });
    return true;
  }
  if (reqType === "CONTEXT_REQUEST") {
    const side = (request.hemisphere || "").toUpperCase();
    if (!briefWaiters[side]) {
      sendResponse({ text: "" });
      return false;
    }
    const waiter = { respond: sendResponse, timer: null };
    waiter.timer = setTimeout(() => {
      briefWaiters[side] = briefWaiters[side].filter((w) => w !== waiter);
      sendResponse({ text: "" });
    }, BRIEF_TIMEOUT_MS);
    briefWaiters[side].push(waiter);
    sendToMediator({ type: "CONTEXT_REQUEST", hemisphere: side });
    return true;
  }
  if (reqType === "GET_STATUS") {
    sendToMediator({ type: "GET_STATUS" });
    sendResponse(statusSnapshot());
  } else if (reqType === "MANUAL_FORWARD") {
    manualForward((request.source || "LEFT").toUpperCase(), sendResponse);
    return true;
  } else if (reqType === "SET_MAX_TURNS") {
    sendToMediator({ type: "SET_MAX_TURNS", max_turns: request.max_turns });
  } else if (reqType === "OPEN_DATA_FOLDER" || reqType === "OPEN_LATEST_LOG") {
    sendToMediator({ type: reqType });
  } else if (reqType === "PAIR_TAB" || reqType === "HOOK_TAB") {
    const slotId = (request.side || request.slotId || "LEFT").toUpperCase();
    const adapterType = request.adapterType || (slotId === "LEFT" ? "chatgpt" : "grok");

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs || tabs.length === 0) return;
      const tab = tabs[0];
      slotRegistry[slotId] = { adapter: adapterType, tabId: tab.id };
      persistSession();
      assignTab(tab.id, slotId, adapterType, (resp) => {
        sendToMediator({
          type: "HOOK_SLOT",
          slot_id: slotId,
          adapter_type: adapterType,
          tab_id: tab.id,
        });
        broadcastStatus();
        sendResponse({ success: true, slotId: slotId, tabId: tab.id });
      });
    });
    return true;
  } else if (reqType === "START") {
    const left = slotRegistry.LEFT;
    if (!left || !left.tabId) {
      signInMessage = null;
      lastError = "Pair the ChatGPT tab as LEFT before starting.";
      broadcastStatus();
      sendResponse({ ok: false, error: lastError });
      return true;
    }
    signInMessage = "Checking the ChatGPT sign-in...";
    lastError = null;
    broadcastStatus();
    ensureChatGptLogin(left.tabId, (result) => {
      if (!result.ok) {
        signInMessage = null;
        lastError = result.error;
        broadcastStatus();
        sendResponse(result);
        return;
      }
      signInMessage = null;
      lastError = null;
      sendToMediator({ type: "START", initial_hemisphere: request.initial_hemisphere || "LEFT" });
      broadcastStatus();
      sendResponse({ ok: true });
    });
    return true;
  } else if (reqType === "PAUSE") {
    sendToMediator({ type: "PAUSE", reason: "User paused from extension popup" });
  } else if (reqType === "RESUME") {
    sendToMediator({ type: "RESUME" });
  } else if (reqType === "STOP") {
    loginWaitGeneration += 1;
    signInMessage = null;
    sendToMediator({ type: "STOP" });
  } else if (reqType === "RESPONSE_CAPTURED" || reqType === "SUBMISSION_CONFIRMED" || reqType === "INJECTION_ERROR" || reqType === "SUBMISSION_STALLED") {
    sendToMediator(request);
  }
  return true;
});

chrome.storage.session.get(
  ["slotRegistry", "currentMediatorState", "currentTurnCount", "lastMessageId", "genesisText", "contentSettings"],
  (data) => {
    if (data && data.slotRegistry) {
      if (data.slotRegistry.LEFT) slotRegistry.LEFT = data.slotRegistry.LEFT;
      if (data.slotRegistry.RIGHT) slotRegistry.RIGHT = data.slotRegistry.RIGHT;
    }
    if (data && typeof data.genesisText === "string") genesisText = data.genesisText;
    if (data && data.contentSettings && typeof data.contentSettings === "object") contentSettings = data.contentSettings;
    if (data && data.currentMediatorState) currentMediatorState = data.currentMediatorState;
    if (data && typeof data.currentTurnCount === "number") currentTurnCount = data.currentTurnCount;
    if (data && data.lastMessageId) lastMessageId = data.lastMessageId;
    connectNative();
  }
);
