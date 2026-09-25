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
    newChatControl: [
      'a[aria-label="New chat"][href="/app"]',
      'a[aria-label="New chat"]',
      'button[aria-label="New chat"]',
    ],
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
  countAssistantMessages() {
    // textContent avoids the layout cost of innerText; this only needs to know
    // how many answers with any text are on the page.
    for (const sel of this.selectors.assistantMessage) {
      let nodes = [];
      try {
        nodes = document.querySelectorAll(sel);
      } catch (err) {
        continue;
      }
      if (!nodes.length) continue;
      let count = 0;
      for (const node of nodes) {
        if ((node.textContent || "").trim()) count += 1;
      }
      return count;
    }
    return 0;
  },
  startNewChat() {
    const control = SideraDom.queryFirst(this.selectors.newChatControl, { visible: true });
    if (!control) return false;
    SideraDom.clickControl(control);
    return true;
  },
  stopGenerating() {
    const stopBtn = SideraDom.queryFirst(this.selectors.stopButton, { visible: true });
    if (!stopBtn || stopBtn.disabled) return false;
    SideraDom.clickControl(stopBtn);
    return true;
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
    // Walk from the newest message backwards; reading innerText forces layout,
    // so touching every message in a long chat would freeze the page.
    for (let i = nodes.length - 1; i >= 0; i--) {
      const text = this._textOf(nodes[i]);
      if (text) return { element: nodes[i], text: text };
    }
    return null;
  },
  _read(node) {
    const visible = (node.innerText || "").trim();
    if (visible) return visible;
    return (node.textContent || "").replace(/\s+/g, " ").trim();
  },
  _textOf(el) {
    for (const sel of this.selectors.messageContent) {
      if (el.matches && el.matches(sel)) {
        const text = this._read(el);
        if (text) return text;
      }
      const nested = el.querySelector(sel);
      if (nested) {
        const text = this._read(nested);
        if (text) return text;
      }
    }
    return this._read(el);
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
