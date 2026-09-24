/**
 * Gemini (gemini.google.com) DOM adapter.
 * Measured on the signed-in Gemini app:
 * - Composer is div.ql-editor[aria-label="Enter a prompt for Gemini"].
 * - Submit is button[aria-label="Send message"].
 * - While a reply streams, that control becomes button[aria-label="Stop response"].
 * - The finished answer is message-content inside model-response.
 */
const GeminiAdapter = {
  name: "Gemini",
  selectors: {
    assistantMessage: [
      "model-response message-content",
      "model-response",
      "message-content",
    ],
    messageContent: [
      ".markdown",
      "message-content",
      ".model-response-text",
    ],
    stopButton: [
      'button[aria-label="Stop response"]',
      'button[aria-label="Stop generating"]',
      'button[aria-label="Stop"]',
      'button[aria-label*="Stop"]',
    ],
    sendButton: [
      'button[aria-label="Send message"]',
      'button[aria-label="Send"]',
      'button[data-testid="send-button"]',
    ],
    composerTextarea: [
      '.ql-editor[aria-label="Enter a prompt for Gemini"]',
      'div.ql-editor.textarea[contenteditable="true"]',
      'div[contenteditable="true"][aria-label*="Gemini"]',
      'rich-textarea [contenteditable="true"]',
      'div[contenteditable="true"][role="textbox"]',
    ],
  },
  identifyTab() {
    const host = window.location.hostname;
    return host === "gemini.google.com" || host.endsWith(".gemini.google.com");
  },
  isGenerating() {
    const stopBtn = SideraDom.queryFirst(this.selectors.stopButton, { visible: true });
    return stopBtn !== null && !stopBtn.disabled;
  },
  getLatestAssistantMessage() {
    let nodes = [];
    for (const sel of this.selectors.assistantMessage) {
      try {
        nodes = [...document.querySelectorAll(sel)];
      } catch (err) {
        continue;
      }
      if (nodes.length) break;
    }
    const filled = nodes.map((el) => ({ element: el, text: this._textOf(el) })).filter((item) => item.text);
    return filled.length ? filled[filled.length - 1] : null;
  },
  _textOf(el) {
    for (const sel of this.selectors.messageContent) {
      if (el.matches && el.matches(sel)) return (el.innerText || "").trim();
      const nested = el.querySelector(sel);
      if (nested && (nested.innerText || "").trim()) return nested.innerText.trim();
    }
    const visible = (el.innerText || "").trim();
    if (visible) return visible;
    return (el.textContent || "").replace(/\s+/g, " ").trim();
  },
  isComposerReady() {
    const composer = SideraDom.queryFirst(this.selectors.composerTextarea, { visible: true });
    return composer !== null && !composer.disabled && composer.getAttribute("aria-disabled") !== "true" && !this.isGenerating();
  },
  setComposerText(text) {
    const composer = SideraDom.queryFirst(this.selectors.composerTextarea, { visible: true });
    if (!composer) throw new Error("Gemini composer not found.");
    SideraDom.setComposerText(composer, text);
  },
  submitComposer() {
    const sendBtn = SideraDom.queryFirst(this.selectors.sendButton, { visible: true, enabled: true });
    if (sendBtn) {
      SideraDom.clickControl(sendBtn);
      return true;
    }
    const composer = SideraDom.queryFirst(this.selectors.composerTextarea, { visible: true });
    if (composer) {
      SideraDom.pressEnter(composer);
      return true;
    }
    return false;
  },
};

globalThis.GeminiAdapter = GeminiAdapter;
