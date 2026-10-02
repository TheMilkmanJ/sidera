importScripts("sites.js");

const NATIVE_HOST_NAME = "com.sidera.mediator";

let nativePort = null;
let currentMediatorState = "IDLE";
let currentTurnCount = 0;
let lastMessageId = null;
let lastError = null;
let maxTurns = null;
let autonomousSubmissions = true;
// Set while Start is waiting for the operator to finish a site sign-in.
let signInMessage = null;
let loginWaitGeneration = 0;
// Held only while a sign-in attempt is in progress. Never written to storage or status.
let chatGptLogin = null;
let loginFetchStarted = false;
let noSavedLogin = false;
const loginStatusWaiters = [];
let loginSecretWaiter = null;
const LOGIN_POLL_MS = 1500;
const LOGIN_WAIT_MS = 10 * 60 * 1000;
// Each side is re-taught only its own role when it opens a fresh chat.
const genesisBySide = { LEFT: "", RIGHT: "" };
// Tuning from config.toml that content scripts need (e.g. rotate_after_pastes).
let contentSettings = {};
// Content scripts waiting for a catch-up brief (CONTEXT_REQUEST -> CONTEXT_BRIEF).
const briefWaiters = { LEFT: [], RIGHT: [] };
const BRIEF_TIMEOUT_MS = 8000;

const slotRegistry = SideraSites.emptyRegistry();

function persistSession() {
  chrome.storage.session.set({
    slotRegistry: slotRegistry,
    currentMediatorState: currentMediatorState,
    currentTurnCount: currentTurnCount,
    lastMessageId: lastMessageId,
    genesisBySide: genesisBySide,
    contentSettings: contentSettings,
  }).catch(() => {});
}

function assignTab(tabId, slotId, adapterType, callback) {
  chrome.tabs.sendMessage(tabId, {
    type: "ASSIGN_HEMISPHERE",
    hemisphere: slotId,
    adapterType: adapterType,
    genesis: genesisBySide[slotId] || "",
    settings: contentSettings,
  }, callback);
}

function releaseSlot(slotId, reason) {
  slotRegistry[slotId] = SideraSites.emptySlot();
  persistSession();
  lastError = reason;
  sendToMediator({ type: "HOOK_SLOT", slot_id: slotId, adapter_type: "", tab_id: null });
  broadcastStatus();
}

function applyGenesisTexts(left, right) {
  if (typeof left === "string") genesisBySide.LEFT = left;
  if (typeof right === "string") genesisBySide.RIGHT = right;
  persistSession();
  for (const slotId of Object.keys(slotRegistry)) {
    const slot = slotRegistry[slotId];
    if (!slot || !slot.tabId) continue;
    chrome.tabs.sendMessage(slot.tabId, { type: "SET_GENESIS", genesis: genesisBySide[slotId] || "" }, () => {
      void chrome.runtime.lastError;
    });
  }
}

function hostOf(url) {
  try {
    return new URL(String(url || "")).hostname;
  } catch (err) {
    return null;
  }
}

// A paired tab that does a full page load (a site's "New chat" or a reload)
// gets a fresh content script, so hand it its hemisphere again. A dedicated
// site's own sign-in page is not a chat, but it must not drop that side.
// Any other web page stays paired as a browser session. Non-web pages drop.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== "complete") return;
  const owned = Object.keys(slotRegistry).filter((slotId) => slotRegistry[slotId] && slotRegistry[slotId].tabId === tabId);
  if (!owned.length) return;
  chrome.tabs.get(tabId, (tab) => {
    if (chrome.runtime.lastError || !tab) return;
    for (const slotId of owned) {
      const slot = slotRegistry[slotId];
      if (!slot || slot.tabId !== tabId) continue;
      const known = SideraSites.knownAdapterForUrl(tab.url);
      if (known) {
        slot.adapter = known;
        slot.host = hostOf(tab.url);
        persistSession();
        assignTab(tabId, slotId, known, (resp) => {
          const runtimeMessage = chrome.runtime.lastError && chrome.runtime.lastError.message;
          if (resp && resp.status === "rejected") {
            releaseSlot(slotId, resp.error || `The ${slotId} tab is not a browser session Sidera can use. Pair that side again.`);
            return;
          }
          if (runtimeMessage) {
            console.warn(`Re-pairing ${slotId} after navigation failed:`, runtimeMessage);
          }
        });
        continue;
      }
      if (slot.adapter && SideraSites.isLoginUrlFor(slot.adapter, tab.url)) continue;
      const found = SideraSites.classify(tab.url);
      if (!found.ok) {
        releaseSlot(slotId, `The ${slotId} tab is not a browser session Sidera can use. Pair that side again.`);
        continue;
      }
      slot.adapter = found.adapter;
      slot.host = found.host;
      persistSession();
      assignTab(tabId, slotId, found.adapter, (resp) => {
        const runtimeMessage = chrome.runtime.lastError && chrome.runtime.lastError.message;
        if (resp && resp.status === "rejected") {
          releaseSlot(slotId, resp.error || `The ${slotId} tab is not a browser session Sidera can use. Pair that side again.`);
          return;
        }
        if (runtimeMessage) {
          console.warn(`Re-pairing ${slotId} after navigation failed:`, runtimeMessage);
        }
      });
    }
  });
});

function connectNative() {
  if (nativePort) return;
  console.log(`Connecting to Native Messaging host: ${NATIVE_HOST_NAME}`);
  try {
    nativePort = chrome.runtime.connectNative(NATIVE_HOST_NAME);
    nativePort.onMessage.addListener((msg) => {
      if (msg && (msg.type === "ACCOUNT_LOGIN" || msg.type === "ACCOUNT_LOGIN_STATUS")) {
        console.log("Received from Python mediator:", msg.type);
      } else {
        console.log("Received from Python mediator:", msg);
      }
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

function settleLoginStatus(msg) {
  const waiters = loginStatusWaiters.splice(0, loginStatusWaiters.length);
  for (const waiter of waiters) waiter(msg);
}

function handleMediatorMessage(msg) {
  const type = msg.type;
  if (type === "ACCOUNT_LOGIN_STATUS") {
    settleLoginStatus(msg);
    return;
  }
  if (type === "ACCOUNT_LOGIN") {
    const waiter = loginSecretWaiter;
    loginSecretWaiter = null;
    if (waiter) waiter(msg);
    return;
  }
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
  } else if (type === "GENESIS_TEXTS") {
    applyGenesisTexts(msg.left, msg.right);
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

function loginSite(service) {
  return SideraSites.loginSite(service) || SideraSites.loginSite("chatgpt");
}

function forgetLoginSecret() {
  chatGptLogin = null;
  loginFetchStarted = false;
  loginSecretWaiter = null;
  noSavedLogin = false;
}

function requestLoginSecret(service, done) {
  loginSecretWaiter = done;
  sendToMediator({ type: "GET_ACCOUNT_LOGIN", service: service });
  setTimeout(() => {
    if (loginSecretWaiter === done) {
      loginSecretWaiter = null;
      done({ saved: false });
    }
  }, 8000);
}

function deliverSavedLogin(tabId, service) {
  const label = loginSite(service).label;
  const fill = (creds) => {
    if (!creds || !creds.saved || !creds.password) return;
    signInMessage = `Signing in to ${label} with the saved login...`;
    broadcastStatus();
    chrome.tabs.sendMessage(tabId, {
      type: "FILL_ACCOUNT_LOGIN",
      service: service,
      email: creds.email,
      password: creds.password,
    }, () => void chrome.runtime.lastError);
  };
  if (noSavedLogin) return;
  if (chatGptLogin && chatGptLogin.service === service) {
    fill(chatGptLogin);
    return;
  }
  if (loginFetchStarted) return;
  loginFetchStarted = true;
  requestLoginSecret(service, (msg) => {
    loginFetchStarted = false;
    if (msg && msg.saved && msg.password && (msg.service || service) === service) {
      chatGptLogin = { saved: true, service: service, email: msg.email, password: msg.password };
      fill(chatGptLogin);
    } else {
      noSavedLogin = true;
    }
  });
}

// If a paired tab is signed out, open its login page and wait until the
// composer is back. A saved login is typed into that site's own form.
function ensureSiteLogin(tabId, service, done) {
  const site = loginSite(service);
  const generation = ++loginWaitGeneration;
  const started = Date.now();
  let focused = false;
  forgetLoginSecret();

  function finish(result) {
    if (generation !== loginWaitGeneration) return;
    forgetLoginSecret();
    done(result);
  }

  function focusTab(tab) {
    if (focused) return;
    focused = true;
    chrome.tabs.update(tabId, { active: true });
    if (tab && tab.windowId) chrome.windows.update(tab.windowId, { focused: true });
  }

  function poll() {
    if (generation !== loginWaitGeneration) return;
    if (Date.now() - started > LOGIN_WAIT_MS) {
      finish({ ok: false, error: `${site.label} is still signed out. Sign in in that tab, then press Start again.` });
      return;
    }
    chrome.tabs.get(tabId, (tab) => {
      if (generation !== loginWaitGeneration) return;
      if (chrome.runtime.lastError || !tab) {
        finish({ ok: false, error: `The ${site.label} tab is no longer open.` });
        return;
      }
      if (tab.status !== "complete") {
        setTimeout(poll, 500);
        return;
      }
      if (site.auth(tab.url)) {
        signInMessage = chatGptLogin && chatGptLogin.service === service
          ? `Signing in to ${site.label} with the saved login...`
          : `Sign in to ${site.label} in the browser. Sidera starts when the chat box is back.`;
        focusTab(tab);
        deliverSavedLogin(tabId, service);
        broadcastStatus();
        setTimeout(poll, LOGIN_POLL_MS);
        return;
      }
      chrome.tabs.sendMessage(tabId, { type: "ENSURE_ACCOUNT_LOGIN", service: service }, (reply) => {
        if (generation !== loginWaitGeneration) return;
        if (chrome.runtime.lastError || !reply) {
          setTimeout(poll, LOGIN_POLL_MS);
          return;
        }
        if (reply.loggedIn) {
          finish({ ok: true });
          return;
        }
        signInMessage = `Sign in to ${site.label} in the browser. Sidera starts when the chat box is back.`;
        focusTab(tab);
        deliverSavedLogin(tabId, service);
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
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs && tabs[0];
      if (!tab || !tab.id) {
        sendResponse({ success: false, error: "No active tab to pair." });
        return;
      }
      const found = SideraSites.classify(tab.url);
      if (!found.ok) {
        sendResponse({ success: false, error: found.error });
        return;
      }
      const decision = SideraSites.assignSlot(slotRegistry, slotId, tab.id, found.adapter, found.host);
      if (!decision.ok) {
        sendResponse({ success: false, error: decision.error });
        return;
      }
      const previous = {
        LEFT: SideraSites._copySlot(slotRegistry.LEFT),
        RIGHT: SideraSites._copySlot(slotRegistry.RIGHT),
      };
      slotRegistry.LEFT = decision.registry.LEFT;
      slotRegistry.RIGHT = decision.registry.RIGHT;
      persistSession();
      assignTab(tab.id, slotId, found.adapter, (resp) => {
        const runtimeMessage = chrome.runtime.lastError && chrome.runtime.lastError.message;
        if (runtimeMessage || !resp || resp.status !== "paired") {
          slotRegistry.LEFT = previous.LEFT;
          slotRegistry.RIGHT = previous.RIGHT;
          persistSession();
          broadcastStatus();
          sendResponse({
            success: false,
            error: (resp && resp.error) || SideraSites.pairConnectionMessage(runtimeMessage),
          });
          return;
        }
        const adapterType = resp.adapter && SideraSites.labelFor(resp.adapter) ? resp.adapter : found.adapter;
        slotRegistry[slotId] = { adapter: adapterType, tabId: tab.id, host: found.host || null };
        persistSession();
        if (decision.displaced) {
          sendToMediator({ type: "HOOK_SLOT", slot_id: decision.displaced, adapter_type: "", tab_id: null });
        }
        sendToMediator({
          type: "HOOK_SLOT",
          slot_id: slotId,
          adapter_type: adapterType,
          tab_id: tab.id,
        });
        broadcastStatus();
        sendResponse({
          success: true,
          slotId: slotId,
          tabId: tab.id,
          adapter: adapterType,
          host: found.host || null,
          label: found.host || SideraSites.labelFor(adapterType),
          displaced: decision.displaced,
        });
      });
    });
    return true;
  } else if (reqType === "SAVE_ACCOUNT_LOGIN" || reqType === "FORGET_ACCOUNT_LOGIN" || reqType === "GET_ACCOUNT_LOGIN_STATUS") {
    loginStatusWaiters.push(sendResponse);
    sendToMediator({
      type: reqType,
      service: request.service,
      email: request.email,
      password: request.password,
    });
    setTimeout(() => {
      const index = loginStatusWaiters.indexOf(sendResponse);
      if (index === -1) return;
      loginStatusWaiters.splice(index, 1);
      sendResponse({ ok: false, saved: false, error: "The mediator is not running. Open Sidera from its icon, then try again." });
    }, 8000);
    return true;
  } else if (reqType === "START") {
    const left = slotRegistry.LEFT;
    if (!left || !left.tabId) {
      signInMessage = null;
      lastError = "Pair a tab as LEFT before starting.";
      broadcastStatus();
      sendResponse({ ok: false, error: lastError });
      return true;
    }
    const queue = SideraSites.loginQueue(slotRegistry);
    const beginExchange = () => {
      signInMessage = null;
      lastError = null;
      sendToMediator({ type: "START", initial_hemisphere: request.initial_hemisphere || "LEFT" });
      broadcastStatus();
      sendResponse({ ok: true });
    };
    const fail = (result) => {
      signInMessage = null;
      lastError = result.error;
      broadcastStatus();
      sendResponse(result);
    };
    let index = 0;
    const step = () => {
      if (index >= queue.length) {
        beginExchange();
        return;
      }
      const item = queue[index];
      index += 1;
      signInMessage = `Checking the ${item.label} sign-in...`;
      lastError = null;
      broadcastStatus();
      ensureSiteLogin(item.tabId, item.service, (result) => {
        if (!result.ok) fail(result);
        else step();
      });
    };
    step();
    return true;
  } else if (reqType === "PAUSE") {
    sendToMediator({ type: "PAUSE", reason: "User paused from extension popup" });
  } else if (reqType === "RESUME") {
    sendToMediator({ type: "RESUME" });
  } else if (reqType === "STOP") {
    loginWaitGeneration += 1;
    forgetLoginSecret();
    signInMessage = null;
    sendToMediator({ type: "STOP" });
  } else if (reqType === "RESPONSE_CAPTURED" || reqType === "SUBMISSION_CONFIRMED" || reqType === "INJECTION_ERROR" || reqType === "SUBMISSION_STALLED") {
    sendToMediator(request);
  }
  return true;
});

chrome.storage.session.get(
  ["slotRegistry", "currentMediatorState", "currentTurnCount", "lastMessageId", "genesisBySide", "contentSettings"],
  (data) => {
    if (data && data.slotRegistry) {
      if (data.slotRegistry.LEFT) slotRegistry.LEFT = data.slotRegistry.LEFT;
      if (data.slotRegistry.RIGHT) slotRegistry.RIGHT = data.slotRegistry.RIGHT;
    }
    if (data && data.genesisBySide && typeof data.genesisBySide === "object") {
      if (typeof data.genesisBySide.LEFT === "string") genesisBySide.LEFT = data.genesisBySide.LEFT;
      if (typeof data.genesisBySide.RIGHT === "string") genesisBySide.RIGHT = data.genesisBySide.RIGHT;
    }
    if (data && data.contentSettings && typeof data.contentSettings === "object") contentSettings = data.contentSettings;
    if (data && data.currentMediatorState) currentMediatorState = data.currentMediatorState;
    if (data && typeof data.currentTurnCount === "number") currentTurnCount = data.currentTurnCount;
    if (data && data.lastMessageId) lastMessageId = data.lastMessageId;
    connectNative();
  }
);
