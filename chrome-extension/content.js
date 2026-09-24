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
  let lastInjected = null;
  let generatingSince = 0;
  let generatingLength = -1;
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

    const latest = site.getLatestAssistantMessage();
    const raw = latest && latest.text ? latest.text : "";
    if (!raw || raw === lastCompletedText) return;
    if (SideraCompletion.isInterimStatus(raw)) return;
    const text = SideraCompletion.finishedAnswer(raw);
    if (!text || text === lastCompletedText) return;

    lastCompletedText = text;
    sawStop = false;
    document.documentElement.dataset.sideraLastText = text;
    delete document.documentElement.dataset.sideraSawStop;
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

  function watchStuckGeneration(site) {
    if (!site.isGenerating()) {
      generatingSince = 0;
      generatingLength = -1;
      return;
    }
    const latest = site.getLatestAssistantMessage();
    const length = latest && latest.text ? latest.text.length : 0;
    const now = Date.now();
    if (!generatingSince || length !== generatingLength) {
      generatingSince = now;
      generatingLength = length;
      return;
    }
    if (now - generatingSince < STUCK_MS) return;
    if (!lastInjected || lastInjected.retried || typeof site.stopGenerating !== "function") return;
    lastInjected.retried = true;
    generatingSince = 0;
    console.warn(`[Sidera ${hemisphere}] Reply hung for ${Math.round(STUCK_MS / 60000)} minutes with no new text; stopping and resending ${lastInjected.messageId}.`);
    site.stopGenerating();
    const pending = lastInjected;
    setTimeout(() => injectAndSubmit(pending.text, pending.messageId, { silent: true }), 3000);
  }

  function injectAndSubmit(text, messageId, options) {
    const silent = !!(options && options.silent);
    if (!silent) lastInjected = { text: text, messageId: messageId, retried: false };
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
    try {
      site.setComposerText(text);
    } catch (err) {
      if (silent) return;
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
      if (silent) return;
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
    }
    return true;
  });
})();
