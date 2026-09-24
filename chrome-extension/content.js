(function () {
  let isPaired = false;
  let hemisphere = null;
  let observer = null;
  let debounceTimer = null;
  let lastCompletedText = "";
  let sawStop = false;
  const DEBOUNCE_MS = 2500;

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

  function startObserver() {
    if (observer) observer.disconnect();
    observer = new MutationObserver(() => {
      if (!isPaired) return;
      const site = adapter();
      if (site && site.isGenerating()) rememberStop();
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(checkCompletion, DEBOUNCE_MS);
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true });
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(checkCompletion, DEBOUNCE_MS);
    console.log(`[Sidera ${hemisphere}] DOM observer initialized (${DEBOUNCE_MS}ms quiescence).`);
  }

  function injectAndSubmit(text, messageId) {
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
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(checkCompletion, DEBOUNCE_MS);
  }

  globalThis.__sideraCheck = checkCompletion;
  globalThis.__sideraNote = noteActivity;

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "ASSIGN_HEMISPHERE") {
      hemisphere = msg.hemisphere;
      isPaired = true;
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
