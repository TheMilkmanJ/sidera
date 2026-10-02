/**
 * Claude (claude.ai) DOM adapter.
 * Selectors are tried in priority order.
 *
 * Observed on claude.ai:
 * - The composer is [data-testid="chat-input"] (a ProseMirror field).
 * - Submit is button[aria-label="Send message"] (also "Send Message").
 * - While a reply streams, that control becomes a stop button
 *   (aria-label "Stop response").
 * - User turns are [data-testid="user-message"].
 * - The finished answer is .font-claude-response, with the prose in
 *   .standard-markdown when that wrapper is present.
 */
const ClaudeAdapter = {
  id: "claude",
  name: "Claude",
  selectors: {
    userMessage: [
      '[data-testid="user-message"]',
      ".font-user-message",
      '[data-testid="human-message"]',
    ],
    newChatControl: [
      'a[aria-label="New chat"]',
      'button[aria-label="New chat"]',
      'a[href="/new"]',
    ],
    assistantMessage: [
      ".font-claude-response",
      ".font-claude-message",
      '[data-testid="assistant-message"]',
      '[data-testid="ai-message"]',
    ],
    messageContent: [
      ".standard-markdown",
      ".progressive-markdown",
      ".markdown",
      ".prose",
      '[class*="markdown"]',
    ],
    stopButton: [
      'button[aria-label="Stop response"]',
      'button[aria-label="Stop generating"]',
      'button[aria-label="Stop Message"]',
      'button[aria-label="Stop"]',
      'button[data-testid="stop-button"]',
      'button[aria-label*="Stop"]',
    ],
    sendButton: [
      'button[aria-label="Send message"]',
      'button[aria-label="Send Message"]',
      'button[aria-label="Send"]',
      'button[data-testid="send-button"]',
    ],
    composerTextarea: [
      '[data-testid="chat-input"]',
      'div.ProseMirror[contenteditable="true"]',
      '[aria-label="Write a prompt to Claude"][contenteditable="true"]',
      '[aria-label="Message Claude"][contenteditable="true"]',
      '[aria-label="Reply to Claude"][contenteditable="true"]',
      'fieldset div[contenteditable="true"]',
    ],
  },
  identifyTab() {
    const host = (window.location.hostname || "").toLowerCase();
    return host === "claude.ai" || host.endsWith(".claude.ai");
  },
  isGenerating() {
    const stopBtn = SideraDom.queryFirst(this.selectors.stopButton, { visible: true });
    return stopBtn !== null && !stopBtn.disabled;
  },
  getLatestUserMessage() {
    for (const sel of this.selectors.userMessage) {
      let nodes = [];
      try {
        nodes = document.querySelectorAll(sel);
      } catch (err) {
        continue;
      }
      for (let i = nodes.length - 1; i >= 0; i--) {
        const text = (nodes[i].textContent || "").trim();
        if (text) return { element: nodes[i], text: text };
      }
    }
    return null;
  },
  waitForCompletedAssistantMessage(options) {
    return SideraDom.waitForCompletedAssistantMessage(this, options);
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
    if (!composer) throw new Error("Claude composer not found.");
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

globalThis.ClaudeAdapter = ClaudeAdapter;
