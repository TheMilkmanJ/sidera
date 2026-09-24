(function () {
  let isPaired = false;
  let hemisphere = null;
  let observer = null;
  let debounceTimer = null;
  let heartbeatTimer = null;
  let lastMeaningfulMutation = 0;
  let lastCompletedText = "";
  let sawStop = false;
  const DEBOUNCE_MS = 2500;
  const HEARTBEAT_MS = 1000;
  // A reply that has shown no new text for this long while the site still
  // claims to be generating is treated as hung: stop it and resend once.
  const STUCK_MS = 6 * 60 * 1000;
  // After a resend, give the site this long to start before judging again.
  const RETRY_GRACE_MS = 15 * 1000;
  let generatingSince = 0;
  let generatingLength = -1;
  let retryIssuedAt = 0;

  // The last message pasted into this page, kept on the document so a
  // re-paired copy of this script can still retry it.
  function loadLastInjected() {
    try {
      const raw = document.documentElement.dataset.sideraInjected;
      return raw ? JSON.parse(raw) : null;
    } catch (err) {
      return null;
    }
  }

  function saveLastInjected(record) {
    document.documentElement.dataset.sideraInjected = JSON.stringify(record);
  }

  function resetFailureTimers() {
    retryIssuedAt = Date.now();
    generatingSince = 0;
    generatingLength = -1;
    saveGenerationWatch();
  }

  function retryLastInjection(reason) {
    const pending = loadLastInjected();
    if (!pending || pending.retried) return false;
    pending.retried = true;
    saveLastInjected(pending);
    resetFailureTimers();
    console.warn(`[Sidera ${hemisphere}] ${reason}; stopping and resending ${pending.messageId} once.`);
    const site = adapter();
    if (site && site.isGenerating() && typeof site.stopGenerating === "function") site.stopGenerating();
    setTimeout(() => injectAndSubmit(pending.text, pending.messageId, { silent: true }), 3000);
    return true;
  }

  // Very long single chats are where the sites start hanging and returning
  // canned errors. A side moves to a fresh chat after this many pastes, and
  // also when the same message has failed twice in the current chat.
  const ROTATE_AFTER_PASTES = 50;
  const NEW_CHAT_SETTLE_MS = 4000;

  function pasteCount() {
    return Number(document.documentElement.dataset.sideraPasteCount || 0);
  }

  function setPasteCount(value) {
    document.documentElement.dataset.sideraPasteCount = String(value);
  }

  function openFreshChat(site, reason) {
    if (typeof site.startNewChat !== "function" || !site.startNewChat()) return false;
    console.warn(`[Sidera ${hemisphere}] ${reason}; starting a new ${site.name} chat.`);
    setPasteCount(0);
    lastCompletedText = "";
    sawStop = false;
    delete document.documentElement.dataset.sideraLastText;
    delete document.documentElement.dataset.sideraSawStop;
    resetFailureTimers();
    return true;
  }

  // A fresh chat has forgotten the Genesis Protocol. When the mediator gave
  // us the protocol text, teach it first; the READY reply is swallowed here
  // and the queued message is pasted once it arrives.
  function genesisText() {
    return document.documentElement.dataset.sideraGenesis || "";
  }

  function queueAfterGenesis(text, messageId, options) {
    document.documentElement.dataset.sideraAfterGenesis = JSON.stringify({ text: text, messageId: messageId, options: options || {} });
    setTimeout(() => injectAndSubmit(genesisText(), `GENESIS-${hemisphere}`, { silent: true }), NEW_CHAT_SETTLE_MS);
  }

  function takeQueuedAfterGenesis() {
    const raw = document.documentElement.dataset.sideraAfterGenesis;
    if (!raw) return null;
    delete document.documentElement.dataset.sideraAfterGenesis;
    try {
      return JSON.parse(raw);
    } catch (err) {
      return null;
    }
  }

  function continueInFreshChat(text, messageId, options) {
    if (genesisText()) {
      queueAfterGenesis(text, messageId, options);
      return;
    }
    setTimeout(() => injectAndSubmit(text, messageId, options), NEW_CHAT_SETTLE_MS);
  }

  function rotateAndResend(reason) {
    const pending = loadLastInjected();
    if (!pending || pending.rotated) return false;
    const site = adapter();
    if (!site || typeof site.startNewChat !== "function") return false;
    if (site.isGenerating() && typeof site.stopGenerating === "function") site.stopGenerating();
    if (!openFreshChat(site, reason)) return false;
    pending.rotated = true;
    saveLastInjected(pending);
    continueInFreshChat(pending.text, pending.messageId, { silent: true });
    return true;
  }

  function recoverFailedReply(reason) {
    return retryLastInjection(reason) || rotateAndResend(`${reason} again`);
  }
  // Only one copy of this script should watch a page. If another copy is
  // paired later (extension reload, re-pairing), the older copy steps aside.
  const instanceId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  function isCurrentInstance() {
    return document.documentElement.dataset.sideraInstance === instanceId;
  }

  function retire() {
    isPaired = false;
    if (observer) observer.disconnect();
    observer = null;
    if (debounceTimer) clearTimeout(debounceTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    debounceTimer = null;
    heartbeatTimer = null;
  }

  function adapter() {
    if (globalThis.ChatGPTAdapter && ChatGPTAdapter.identifyTab()) return ChatGPTAdapter;
    if (globalThis.GeminiAdapter && GeminiAdapter.identifyTab()) return GeminiAdapter;
    if (globalThis.GrokAdapter && GrokAdapter.identifyTab()) return GrokAdapter;
    return null;
  }

  function rememberStop() {
    sawStop = true;
    document.documentElement.dataset.sideraSawStop = "1";
  }

  function currentAnswer() {
    const site = adapter();
    const latest = site && site.getLatestAssistantMessage();
    const raw = latest && latest.text ? latest.text : "";
    return SideraCompletion.finishedAnswer(raw) || raw;
  }

  function restoreTurn() {
    if (document.documentElement.dataset.sideraLastText) {
      lastCompletedText = document.documentElement.dataset.sideraLastText;
    } else {
      lastCompletedText = currentAnswer();
      if (lastCompletedText) document.documentElement.dataset.sideraLastText = lastCompletedText;
    }
    sawStop = document.documentElement.dataset.sideraSawStop === "1";
  }

  function checkCompletion() {
    if (!isPaired) return;
    if (!isCurrentInstance()) {
      retire();
      return;
    }
    const site = adapter();
    if (!site) return;
    if (site.isGenerating()) {
      rememberStop();
      return;
    }

    if (Date.now() - retryIssuedAt < RETRY_GRACE_MS) return;

    const latest = site.getLatestAssistantMessage();
    const raw = latest && latest.text ? latest.text : "";
    if (!raw || raw === lastCompletedText) return;
    if (SideraCompletion.isInterimStatus(raw)) return;
    const text = SideraCompletion.finishedAnswer(raw);
    if (!text || text === lastCompletedText) return;
    if (SideraCompletion.isErrorReply(text) && recoverFailedReply("Site returned an error instead of a reply")) return;

    lastCompletedText = text;
    sawStop = false;
    document.documentElement.dataset.sideraLastText = text;
    delete document.documentElement.dataset.sideraSawStop;

    const queued = takeQueuedAfterGenesis();
    if (queued) {
      console.log(`[Sidera ${hemisphere}] Genesis acknowledged in the new chat (${text.slice(0, 40)}); pasting ${queued.messageId}.`);
      setTimeout(() => injectAndSubmit(queued.text, queued.messageId, queued.options), 1500);
      return;
    }
    console.log(`[Sidera ${hemisphere}] Detected completed response (${text.length} chars). Notifying mediator.`);

    chrome.runtime.sendMessage({
      type: "RESPONSE_CAPTURED",
      source: hemisphere,
      content: text,
    });
  }

  // Spinners and icons animate SVG attributes continuously; that churn must not
  // count as "the page is still changing" or the quiet period never arrives.
  function isDecorativeMutation(record) {
    if (record.type !== "attributes") return false;
    const target = record.target;
    return typeof SVGElement !== "undefined" && target instanceof SVGElement;
  }

  function armDebounce() {
    lastMeaningfulMutation = Date.now();
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(checkCompletion, DEBOUNCE_MS);
  }

  function heartbeat() {
    if (!isPaired) return;
    if (!isCurrentInstance()) {
      retire();
      return;
    }
    const site = adapter();
    if (site) watchStuckGeneration(site);
    if (Date.now() - lastMeaningfulMutation >= DEBOUNCE_MS) checkCompletion();
  }

  function startObserver() {
    if (observer) observer.disconnect();
    observer = new MutationObserver((records) => {
      if (!isPaired) return;
      if (!isCurrentInstance()) {
        retire();
        return;
      }
      const site = adapter();
      if (site && site.isGenerating()) rememberStop();
      if (records.every(isDecorativeMutation)) return;
      armDebounce();
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true });
    armDebounce();
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(heartbeat, HEARTBEAT_MS);
    console.log(`[Sidera ${hemisphere}] DOM observer initialized (${DEBOUNCE_MS}ms quiescence).`);
  }

  // The hang timer lives on the document so a re-paired copy of this script
  // continues counting instead of restarting from zero.
  function loadGenerationWatch() {
    const ds = document.documentElement.dataset;
    generatingSince = Number(ds.sideraGenSince || 0);
    generatingLength = ds.sideraGenLength === undefined ? -1 : Number(ds.sideraGenLength);
  }

  function saveGenerationWatch() {
    const ds = document.documentElement.dataset;
    if (!generatingSince) {
      delete ds.sideraGenSince;
      delete ds.sideraGenLength;
      return;
    }
    ds.sideraGenSince = String(generatingSince);
    ds.sideraGenLength = String(generatingLength);
  }

  function watchStuckGeneration(site) {
    loadGenerationWatch();
    if (!site.isGenerating()) {
      generatingSince = 0;
      generatingLength = -1;
      saveGenerationWatch();
      return;
    }
    const latest = site.getLatestAssistantMessage();
    const length = latest && latest.text ? latest.text.length : 0;
    const now = Date.now();
    if (!generatingSince || length !== generatingLength) {
      generatingSince = now;
      generatingLength = length;
      saveGenerationWatch();
      return;
    }
    if (now - generatingSince < STUCK_MS) return;
    if (typeof site.stopGenerating !== "function") return;
    if (!recoverFailedReply(`Reply hung for ${Math.round(STUCK_MS / 60000)} minutes with no new text`)) {
      generatingSince = now;
      saveGenerationWatch();
    }
  }

  function injectAndSubmit(text, messageId, options) {
    const silent = !!(options && options.silent);
    // A retry stays quiet; a first send that was moved to a fresh chat still
    // has to report its outcome to the mediator.
    const quiet = silent && !(options && options.confirm);
    if (!silent) saveLastInjected({ text: text, messageId: messageId, retried: false, rotated: false });
    const site = adapter();
    if (!site) {
      chrome.runtime.sendMessage({
        type: "INJECTION_ERROR",
        hemisphere: hemisphere,
        message_id: messageId,
        error: "No Sidera adapter matched this tab.",
      });
      return;
    }
    if (!silent) {
      const count = pasteCount() + 1;
      if (count > ROTATE_AFTER_PASTES && openFreshChat(site, `${count - 1} messages pasted into this chat`)) {
        setPasteCount(1);
        continueInFreshChat(text, messageId, { silent: true, confirm: true });
        return;
      }
      setPasteCount(count);
    }
    try {
      site.setComposerText(text);
    } catch (err) {
      if (quiet) return;
      chrome.runtime.sendMessage({
        type: "INJECTION_ERROR",
        hemisphere: hemisphere,
        message_id: messageId,
        error: err && err.message ? err.message : String(err),
      });
      return;
    }

    setTimeout(() => {
      const submitted = site.submitComposer();
      if (quiet) return;
      if (!submitted) {
        chrome.runtime.sendMessage({
          type: "INJECTION_ERROR",
          hemisphere: hemisphere,
          message_id: messageId,
          error: "Composer submit control was not available.",
        });
        return;
      }
      chrome.runtime.sendMessage({
        type: "SUBMISSION_CONFIRMED",
        destination: hemisphere,
        message_id: messageId,
      });
    }, 200);
  }

  function noteActivity() {
    if (!isPaired) return;
    const site = adapter();
    if (!site || !site.isGenerating()) return;
    rememberStop();
    armDebounce();
  }

  globalThis.__sideraCheck = checkCompletion;
  globalThis.__sideraNote = noteActivity;
  globalThis.__sideraHeartbeat = heartbeat;

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "ASSIGN_HEMISPHERE") {
      hemisphere = msg.hemisphere;
      isPaired = true;
      document.documentElement.dataset.sideraInstance = instanceId;
      if (typeof msg.genesis === "string" && msg.genesis) document.documentElement.dataset.sideraGenesis = msg.genesis;
      if (msg.baseline === false) {
        lastCompletedText = "";
        sawStop = false;
      } else {
        restoreTurn();
      }
      startObserver();
      sendResponse({ status: "paired", hemisphere: hemisphere });
    } else if (msg.type === "INJECT_AND_SUBMIT") {
      injectAndSubmit(msg.text, msg.message_id);
      sendResponse({ status: "submitting" });
    } else if (msg.type === "SET_GENESIS") {
      if (typeof msg.genesis === "string") document.documentElement.dataset.sideraGenesis = msg.genesis;
      sendResponse({ status: "ok" });
    }
    return true;
  });
})();
