/**
 * Generic adapter for any web page the operator already has open.
 * Dedicated adapters are tried first. This one is the fallback: a visible
 * textarea or contenteditable composer, a send/submit control, and an
 * assistant turn marked with a role attribute or an article after that box.
 * It does not name a product. A page with no chat box fails when pasting.
 */
const BrowserAdapter = {
  id: "browser",
  name: "Browser",
  selectors: {
    userMessage: [
      '[data-message-author-role="user"]',
      '[data-role="user"]',
    ],
    newChatControl: [
      'a[aria-label="New chat"]',
      'button[aria-label="New chat"]',
    ],
    assistantMessage: [
      '[data-message-author-role="assistant"]',
      '[data-role="assistant"]',
      "article",
    ],
    messageContent: [
      ".markdown",
      ".prose",
      '[class*="markdown"]',
    ],
    stopButton: [
      'button[aria-label="Stop" i]',
      'button[aria-label*="Stop" i]',
    ],
    sendButton: [
      'button[aria-label*="Send" i]',
      'button[aria-label*="Submit" i]',
      'button[type="submit"]',
    ],
    composerTextarea: [
      "textarea",
      '[contenteditable="true"][role="textbox"]',
      'div[contenteditable="true"]',
    ],
  },
  identifyTab() {
    const protocol = (window.location.protocol || "").toLowerCase();
    return protocol === "https:" || protocol === "http:";
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
    if (!this._composer()) return null;
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
  _composer() {
    return SideraDom.queryFirst(this.selectors.composerTextarea, { visible: true });
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
    const composer = this._composer();
    return composer !== null && !composer.disabled && composer.getAttribute("aria-disabled") !== "true" && !this.isGenerating();
  },
  setComposerText(text) {
    const composer = this._composer();
    if (!composer) throw new Error("This page has no chat box Sidera can paste into.");
    SideraDom.setComposerText(composer, text);
  },
  submitComposer() {
    const sendBtn = SideraDom.queryFirst(this.selectors.sendButton, { visible: true, enabled: true });
    if (sendBtn) {
      SideraDom.clickControl(sendBtn);
      return true;
    }
    const composer = this._composer();
    if (composer) {
      SideraDom.pressEnter(composer);
      return true;
    }
    return false;
  },
};

globalThis.BrowserAdapter = BrowserAdapter;
