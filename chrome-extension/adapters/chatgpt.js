/**
 * ChatGPT (chatgpt.com) DOM adapter.
 * Selectors are tried in priority order. A comma-joined querySelector is
 * intentionally avoided: it returns document order, not fallback priority,
 * and a bare conversation-turn match includes user messages.
 *
 * Verified against the live chatgpt.com structure (2026):
 * - Composer is #prompt-textarea, a ProseMirror contenteditable (legacy textarea still exists).
 * - Assistant turns carry data-message-author-role="assistant" and/or data-turn="assistant".
 * - Streaming replaces the send button with button[data-testid="stop-button"]
 *   (aria-label "Stop generating", "Stop streaming", or "Stop response").
 */
const ChatGPTAdapter = {
  name: "ChatGPT",
  selectors: {
    assistantMessage: [
      '[data-message-author-role="assistant"]',
      'article[data-turn="assistant"]',
      '[data-testid^="conversation-turn-"][data-turn="assistant"]',
      '[data-testid^="conversation-turn-"]:has([data-message-author-role="assistant"])',
    ],
    messageContent: [
      ".markdown.prose",
      ".markdown",
      '[class*="markdown"]',
      ".whitespace-pre-wrap",
    ],
    stopButton: [
      'button[data-testid="stop-button"]',
      'button[aria-label="Stop generating"]',
      'button[aria-label="Stop streaming"]',
      'button[aria-label="Stop response"]',
    ],
    sendButton: [
      'button[data-testid="send-button"]',
      'button[aria-label="Send prompt"]',
      'button[aria-label="Send message"]',
    ],
    composerTextarea: [
      '#prompt-textarea.ProseMirror[contenteditable="true"]',
      'div#prompt-textarea[contenteditable="true"]',
      "#prompt-textarea",
      'textarea[name="prompt-textarea"]',
      '[data-testid="prompt-textarea"]',
    ],
  },
  identifyTab() {
    return window.location.hostname === "chatgpt.com" || window.location.hostname.endsWith(".chatgpt.com");
  },
  isGenerating() {
    const stopBtn = SideraDom.queryFirst(this.selectors.stopButton, { visible: true });
    return stopBtn !== null && !stopBtn.disabled;
  },
  getLatestAssistantMessage() {
    const lastTurn = SideraDom.queryLast(this.selectors.assistantMessage);
    if (!lastTurn) return null;
    const textSource = this._contentWithin(lastTurn) || lastTurn;
    return { element: lastTurn, text: (textSource.innerText || "").trim() };
  },
  _contentWithin(root) {
    for (const sel of this.selectors.messageContent) {
      const node = root.querySelector(sel);
      if (node) return node;
    }
    return null;
  },
  isComposerReady() {
    const composer = SideraDom.queryFirst(this.selectors.composerTextarea, { visible: true });
    return composer !== null && !composer.disabled && composer.getAttribute("aria-disabled") !== "true" && !this.isGenerating();
  },
  setComposerText(text) {
    const composer = SideraDom.queryFirst(this.selectors.composerTextarea, { visible: true });
    if (!composer) throw new Error("ChatGPT composer not found.");
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

globalThis.ChatGPTAdapter = ChatGPTAdapter;
