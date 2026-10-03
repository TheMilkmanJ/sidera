importScripts("sites.js");

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
// Held only while a sign-in attempt is in progress. Never written to storage or status.
let chatGptLogin = null;
let loginFetchStarted = false;
let noSavedLogin = false;
const loginStatusWaiters = [];
let loginSecretWaiter = null;
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

// Mediator states during which losing a tab must pause the exchange.
const ACTIVE_STATES = ["WAIT_LEFT", "WAIT_RIGHT", "LEFT_COMPLETE", "RIGHT_COMPLETE", "PROCESS", "SEND_LEFT", "SEND_RIGHT"];

function exchangeActive() {
  return ACTIVE_STATES.includes(currentMediatorState);
}

// Which side a content-script message really belongs to. Inbound messages are
// attributed by the sender's tab id against the registry, never by the side
// label the page claims, so a leftover same-site tab can never speak for a side.
function sideForSender(sender) {
  const tabId = sender && sender.tab && sender.tab.id;
  if (tabId == null) return null;
  for (const slotId of Object.keys(slotRegistry)) {
    const slot = slotRegistry[slotId];
    if (slot && slot.tabId === tabId) return slotId;
  }
  return null;
}

// Tell a tab's content script to stand down (it was re-paired away or was
// never paired). Errors are ignored: the tab may already be gone.
function unassignTab(tabId) {
  if (tabId == null) return;
  chrome.tabs.sendMessage(tabId, { type: "UNASSIGN_HEMISPHERE" }, () => void chrome.runtime.lastError);
}

// The chosen AI for each side survives a browser restart (tab pairings cannot:
// the tabs themselves are gone).
function persistAdapterChoices() {
  chrome.storage.local.set({
    adapterChoices: { LEFT: slotRegistry.LEFT.adapter, RIGHT: slotRegistry.RIGHT.adapter },
  }, () => void chrome.runtime.lastError);
}

// A paired tab that disappears (closed, or swapped out by Chrome) unpairs its
// side immediately so the popup never shows a stale "Paired", and pauses a
// running exchange with a plain reason instead of stalling silently.
function handleTabGone(tabId) {
  for (const slotId of Object.keys(slotRegistry)) {
    const slot = slotRegistry[slotId];
    if (!slot || slot.tabId !== tabId) continue;
    slotRegistry[slotId] = { adapter: slot.adapter, tabId: null };
    persistSession();
    if (exchangeActive()) {
      const label = SideraSites.adapterLabel(slot.adapter);
      sendToMediator({
        type: "PAUSE",
        reason: `The ${slotId} (${label}) tab was closed. Pair a new tab as ${slotId} in the Sidera popup, then press Resume.`,
      });
    }
    broadcastStatus();
  }
}

chrome.tabs.onRemoved.addListener((tabId) => handleTabGone(tabId));
chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => handleTabGone(removedTabId));

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
// gets a fresh content script, so hand it its hemisphere again. A tab that
// has navigated to a DIFFERENT supported site is unpaired instead, so a side
// can never silently become another AI. Unknown hosts (a sign-in page such as
// accounts.google.com) keep the pairing; the tab is re-checked when it returns.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;
  for (const slotId of Object.keys(slotRegistry)) {
    const slot = slotRegistry[slotId];
    if (!slot || slot.tabId !== tabId) continue;
    const siteNow = SideraSites.siteForUrl(tab && tab.url);
    if (siteNow && siteNow !== slot.adapter) {
      slotRegistry[slotId] = { adapter: slot.adapter, tabId: null };
      persistSession();
      if (exchangeActive()) {
        sendToMediator({
          type: "PAUSE",
          reason: `The ${slotId} tab moved from ${SideraSites.adapterLabel(slot.adapter)} to ${SideraSites.adapterLabel(siteNow)}. Pair a ${SideraSites.adapterLabel(slot.adapter)} tab as ${slotId}, then press Resume.`,
        });
      }
      broadcastStatus();
      continue;
    }
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
      // Tell the mediator instead of only logging, so the operator sees a
      // plain error in the popup rather than a silent stall.
      sendToMediator({
        type: "INJECTION_ERROR",
        hemisphere: dest,
        message_id: msg.message_id,
        error: `No tab is paired as ${dest}. Pair one in the Sidera popup, then press Resume.`,
      });
      return;
    }
    chrome.tabs.sendMessage(slot.tabId, {
      type: "INJECT_AND_SUBMIT",
      text: msg.text,
      message_id: msg.message_id,
    }, (response) => {
      if (chrome.runtime.lastError) {
        const label = SideraSites.adapterLabel(slot.adapter);
        sendToMediator({
          type: "INJECTION_ERROR",
          hemisphere: dest,
          message_id: msg.message_id,
          error: `The ${dest} (${label}) tab is not responding. Reload or re-pair that tab, then press Resume.`,
        });
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

const LOGIN_SITES = {
  chatgpt: {
    label: "ChatGPT",
    auth(url) {
      return /https:\/\/auth\.openai\.com\//i.test(url || "") || /https:\/\/([^/]+\.)?chatgpt\.com\/auth/i.test(url || "");
    },
  },
  grok: {
    label: "Grok",
    auth(url) {
      return /https:\/\/accounts\.x\.ai\//i.test(url || "")
        || /https:\/\/([^/]+\.)?grok\.com\/(login|sign-in|auth)/i.test(url || "")
        || /https:\/\/([^/]+\.)?x\.com\/(login|i\/flow\/login)/i.test(url || "");
    },
  },
};

function loginSite(service) {
  return LOGIN_SITES[service] || LOGIN_SITES.chatgpt;
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
    if (chrome.runtime.lastError) {
      sendResponse({ ok: false, error: SideraSites.plainTabError(chrome.runtime.lastError.message, `the ${source} tab`) });
      return;
    }
    if (!reply || !reply.text) {
      sendResponse({ ok: false, error: `No completed reply was found in the ${source} tab.` });
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
    // The side comes from the registry (by the sender's tab id), never from
    // the page's own claim; an unpaired tab gets nothing.
    const side = sideForSender(sender) || (sender && sender.tab ? null : (request.hemisphere || "").toUpperCase());
    if (!side || !briefWaiters[side]) {
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

    const pairTab = (tab) => {
      if (!tab || tab.id == null) {
        sendResponse({ success: false, error: "That tab is no longer open." });
        return;
      }
      // The chosen AI must match the site the tab is actually on. Without an
      // explicit choice (older popups), the site is read from the tab itself.
      const siteOfTab = SideraSites.siteForUrl(tab.url);
      const adapterType = SideraSites.normalizeAdapter(request.adapterType || siteOfTab, slotId);
      if (!siteOfTab) {
        sendResponse({ success: false, error: "That tab is not on a supported site. Open ChatGPT, Grok, or Gemini in it first." });
        return;
      }
      if (siteOfTab !== adapterType) {
        sendResponse({
          success: false,
          error: `That tab is on ${SideraSites.adapterLabel(siteOfTab)}, not ${SideraSites.adapterLabel(adapterType)}. Pick a ${SideraSites.adapterLabel(adapterType)} tab, or change the AI choice for ${slotId}.`,
        });
        return;
      }
      // Same site on both sides is fine; the same tab on both sides is not.
      const conflict = SideraSites.pairingConflict(slotRegistry, slotId, tab.id);
      if (conflict) {
        sendResponse({ success: false, error: conflict });
        return;
      }
      // A tab this side was previously paired to must stand down, or it could
      // keep reporting replies for this side.
      const previous = slotRegistry[slotId];
      if (previous && previous.tabId != null && previous.tabId !== tab.id) {
        unassignTab(previous.tabId);
      }
      slotRegistry[slotId] = { adapter: adapterType, tabId: tab.id };
      persistSession();
      assignTab(tab.id, slotId, adapterType, (resp) => {
        if (chrome.runtime.lastError || !resp) {
          // The tab never acknowledged: its content script is not running
          // (for example the tab was opened before Sidera was installed).
          slotRegistry[slotId] = { adapter: adapterType, tabId: null };
          persistSession();
          broadcastStatus();
          sendResponse({
            success: false,
            error: `Sidera could not attach to that ${SideraSites.adapterLabel(adapterType)} tab. Reload the tab (press F5 in it), then pair it again.`,
          });
          return;
        }
        persistAdapterChoices();
        sendToMediator({
          type: "HOOK_SLOT",
          slot_id: slotId,
          adapter_type: adapterType,
          tab_id: tab.id,
        });
        broadcastStatus();
        sendResponse({ success: true, slotId: slotId, adapterType: adapterType, tabId: tab.id });
      });
    };

    if (typeof request.tabId === "number") {
      chrome.tabs.get(request.tabId, (tab) => {
        if (chrome.runtime.lastError || !tab) {
          sendResponse({ success: false, error: "That tab is no longer open." });
          return;
        }
        pairTab(tab);
      });
    } else {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (!tabs || tabs.length === 0) {
          sendResponse({ success: false, error: "No active tab to pair." });
          return;
        }
        pairTab(tabs[0]);
      });
    }
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
    // Both sides must be paired, or the Genesis handshake would stall
    // silently waiting for a tab that does not exist.
    const missing = ["LEFT", "RIGHT"].filter((slotId) => !slotRegistry[slotId] || !slotRegistry[slotId].tabId);
    if (missing.length) {
      signInMessage = null;
      lastError = missing.length === 2
        ? "Pair a tab as LEFT and a tab as RIGHT before starting."
        : `Pair a tab as ${missing[0]} before starting.`;
      broadcastStatus();
      sendResponse({ ok: false, error: lastError });
      return true;
    }
    lastError = null;
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
    // Check each paired side's own site sign-in, LEFT first. A site with no
    // scripted login flow (Gemini) is skipped, as before.
    const checks = [];
    for (const slotId of ["LEFT", "RIGHT"]) {
      const slot = slotRegistry[slotId];
      if (!slot || !slot.tabId) continue;
      const service = SideraSites.loginServiceFor(slot.adapter);
      if (!service) continue;
      checks.push({ tabId: slot.tabId, service: service, label: SideraSites.adapterLabel(slot.adapter) });
    }
    const runCheck = (index) => {
      if (index >= checks.length) {
        beginExchange();
        return;
      }
      const check = checks[index];
      signInMessage = `Checking the ${check.label} sign-in...`;
      broadcastStatus();
      ensureSiteLogin(check.tabId, check.service, (result) => {
        if (!result.ok) fail(result);
        else runCheck(index + 1);
      });
    };
    runCheck(0);
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
    // Only the currently paired tabs may speak for a side, and the side label
    // comes from the registry, not from the page. A stray tab (re-paired away
    // or never paired) is told to stand down and its message is dropped, so a
    // leftover same-site tab can never inject a reply into the exchange.
    const side = sideForSender(sender);
    if (!side) {
      if (sender && sender.tab && sender.tab.id != null) {
        console.warn(`Dropped ${reqType} from unpaired tab ${sender.tab.id}.`);
        unassignTab(sender.tab.id);
      }
      return false;
    }
    const sideField = reqType === "RESPONSE_CAPTURED" ? "source"
      : reqType === "SUBMISSION_CONFIRMED" ? "destination"
      : "hemisphere";
    sendToMediator({ ...request, [sideField]: side });
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
    // Session storage is cleared when the browser restarts; the chosen AIs
    // come back from local storage so the pickers match the last session.
    chrome.storage.local.get(["adapterChoices"], (local) => {
      const choices = local && local.adapterChoices;
      if (choices) {
        for (const side of ["LEFT", "RIGHT"]) {
          const slot = slotRegistry[side];
          if (choices[side] && (!slot || slot.tabId == null)) {
            slotRegistry[side] = { adapter: SideraSites.normalizeAdapter(choices[side], side), tabId: null };
          }
        }
      }
      connectNative();
    });
  }
);
