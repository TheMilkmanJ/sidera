const NATIVE_HOST_NAME = "com.sidera.mediator";

let nativePort = null;
let currentMediatorState = "IDLE";
let currentTurnCount = 0;
let lastMessageId = null;

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
  }).catch(() => {});
}

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
    lastMessageId = msg.last_message_id || null;
    persistSession();
    broadcastStatus();
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

function broadcastStatus() {
  chrome.runtime.sendMessage({
    type: "POPUP_STATUS_UPDATE",
    state: currentMediatorState,
    turnCount: currentTurnCount,
    lastMessageId: lastMessageId,
    leftPaired: !!slotRegistry.LEFT.tabId,
    rightPaired: !!slotRegistry.RIGHT.tabId,
    slots: slotRegistry,
  }).catch(() => {});
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const reqType = request.type;
  if (reqType === "GET_STATUS") {
    sendResponse({
      state: currentMediatorState,
      turnCount: currentTurnCount,
      lastMessageId: lastMessageId,
      leftPaired: !!slotRegistry.LEFT.tabId,
      rightPaired: !!slotRegistry.RIGHT.tabId,
      slots: slotRegistry,
      connected: !!nativePort,
    });
  } else if (reqType === "PAIR_TAB" || reqType === "HOOK_TAB") {
    const slotId = (request.side || request.slotId || "LEFT").toUpperCase();
    const adapterType = request.adapterType || (slotId === "LEFT" ? "chatgpt" : "grok");

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs || tabs.length === 0) return;
      const tab = tabs[0];
      slotRegistry[slotId] = { adapter: adapterType, tabId: tab.id };
      persistSession();
      chrome.tabs.sendMessage(tab.id, {
        type: "ASSIGN_HEMISPHERE",
        hemisphere: slotId,
        adapterType: adapterType,
      }, (resp) => {
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
    sendToMediator({ type: "START", initial_hemisphere: request.initial_hemisphere || "LEFT" });
  } else if (reqType === "PAUSE") {
    sendToMediator({ type: "PAUSE", reason: "User paused from extension popup" });
  } else if (reqType === "RESUME") {
    sendToMediator({ type: "RESUME" });
  } else if (reqType === "STOP") {
    sendToMediator({ type: "STOP" });
  } else if (reqType === "RESPONSE_CAPTURED" || reqType === "SUBMISSION_CONFIRMED" || reqType === "INJECTION_ERROR") {
    sendToMediator(request);
  }
  return true;
});

chrome.storage.session.get(
  ["slotRegistry", "currentMediatorState", "currentTurnCount", "lastMessageId"],
  (data) => {
    if (data && data.slotRegistry) {
      if (data.slotRegistry.LEFT) slotRegistry.LEFT = data.slotRegistry.LEFT;
      if (data.slotRegistry.RIGHT) slotRegistry.RIGHT = data.slotRegistry.RIGHT;
    }
    if (data && data.currentMediatorState) currentMediatorState = data.currentMediatorState;
    if (data && typeof data.currentTurnCount === "number") currentTurnCount = data.currentTurnCount;
    if (data && data.lastMessageId) lastMessageId = data.lastMessageId;
    connectNative();
  }
);
