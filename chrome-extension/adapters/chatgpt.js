/**
 * ChatGPT (chatgpt.com) DOM adapter.
 * Selectors are tried in priority order. A comma-joined querySelector is
 * intentionally avoided: it returns document order, not fallback priority,
 * and a bare conversation-turn match includes user messages.
 *
 * Verified against the live chatgpt.com structure (2026):
 * - Conversation composer is #prompt-textarea (ProseMirror). The logged-in home
 *   composer measured in Chrome is textarea#mobile-composer-prompt
 *   (aria-label "Chat with ChatGPT").
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
      'ol[aria-label="Conversation"] > li',
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
      "textarea#mobile-composer-prompt",
      'textarea[aria-label="Chat with ChatGPT"]',
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
    const turns = [...document.querySelectorAll('ol[aria-label="Conversation"] > li')];
    const labeled = turns.filter((el) => {
      const heading = el.querySelector("h4, h3, h2");
      return heading && /^chatgpt said\b/i.test((heading.innerText || "").trim());
    });
    const lastTurn = labeled[labeled.length - 1] || SideraDom.queryLast(this.selectors.assistantMessage.slice(0, 4));
    if (!lastTurn) return null;
    const heading = lastTurn.querySelector("h4, h3, h2");
    let text = (lastTurn.innerText || "").trim();
    if (heading && /^chatgpt said\b/i.test((heading.innerText || "").trim())) {
      text = text.replace(/^chatgpt said:\s*/i, "").trim();
    } else {
      const textSource = this._contentWithin(lastTurn) || lastTurn;
      text = (textSource.innerText || "").trim();
    }
    return { element: lastTurn, text: text };
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
