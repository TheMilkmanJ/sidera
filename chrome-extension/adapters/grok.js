/**
 * Grok (grok.com and x.com/i/grok) DOM adapter.
 * Selectors are tried in priority order so a hidden duplicate control
 * (common on grok.com) is skipped in favor of the visible one.
 *
 * Measured on live grok.com:
 * - The visible composer is textarea[aria-label="Ask Grok anything"].
 *   TipTap (.tiptap.ProseMirror) remains a fallback for older builds.
 * - The visible submit control is button[aria-label="Submit"]
 *   with data-testid="chat-submit".
 * - Assistant bubbles use data-testid="assistant-message". User bubbles
 *   use data-testid="user-message" and are not captured.
 * - While a reply streams, the submit control becomes button[aria-label="Stop model response"].
 *   The finished reply is [data-testid="assistant-message"] inside [id^="response-"].
 */
const GrokAdapter = {
  name: "Grok",
  selectors: {
    userMessage: [
      '[data-testid="user-message"]',
      '.message-bubble.user',
    ],
    newChatControl: [
      'a[aria-label="New chat"]',
      'button[aria-label="New chat"]',
      'a[href="/"][aria-label*="New"]',
    ],
    assistantMessage: [
      '[data-testid="assistant-message"]',
      '[data-testid="grok-response"]',
      'div[data-testid="message-row-assistant"]',
      '[id^="response-"]',
      'div[class*="grok-response"]',
    ],
    messageContent: [
      ".markdown",
      ".markdown-content",
      ".message-bubble",
      '[data-testid="assistant-message"]',
      'div[dir="auto"]',
    ],
    stopButton: [
      'button[aria-label="Stop model response"]',
      'button[aria-label="Stop"]',
      'button[aria-label="Stop response"]',
      'button[aria-label="Stop generating"]',
      'button[data-testid="stop-generation"]',
      'button[aria-label*="Stop"]',
    ],
    sendButton: [
      'button[aria-label="Submit"]',
      'button[data-testid="chat-submit"]',
      'button[aria-label="Send message"]',
      'button[aria-label="Grok something"]',
      'button[aria-label*="Send"]',
      'button[data-testid="send-button"]',
      'button[data-testid*="submit"]',
      'form button[type="submit"]',
    ],
    composerTextarea: [
      '.tiptap.ProseMirror[contenteditable="true"]',
      'textarea[aria-label="Ask Grok anything"]',
      'textarea[placeholder*="Ask Grok"]',
      'textarea[placeholder*="Ask"]',
      'textarea[data-testid="grok-input"]',
      'textarea[data-testid="grok-compose-input"]',
      'div[contenteditable="true"][data-testid="composer-input"]',
      'div[contenteditable="true"][role="textbox"]',
      'textarea[data-testid="tweetTextarea_0"]',
    ],
  },
  identifyTab() {
    const host = window.location.hostname;
    if (host === "grok.com" || host.endsWith(".grok.com")) return true;
    return (host === "x.com" || host.endsWith(".x.com")) && window.location.pathname.includes("/i/grok");
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
    // Walk from the newest message backwards; reading innerText forces layout,
    // so touching every message in a long chat would freeze the page.
    for (let i = nodes.length - 1; i >= 0; i--) {
      const text = this._textOf(nodes[i]);
      if (text) return { element: nodes[i], text: text };
    }
    return null;
  },
  _textOf(el) {
    for (const sel of this.selectors.messageContent) {
      if (el.matches && el.matches(sel)) return (el.innerText || "").trim();
      const nested = el.querySelector(sel);
      if (nested && (nested.innerText || "").trim()) return nested.innerText.trim();
    }
    return (el.innerText || "").trim();
  },
  isComposerReady() {
    const composer = SideraDom.queryFirst(this.selectors.composerTextarea, { visible: true });
    return composer !== null && !composer.disabled && composer.getAttribute("aria-disabled") !== "true" && !this.isGenerating();
  },
  _controlName(el) {
    return el.getAttribute("aria-label") || el.innerText || el.textContent || "";
  },
  loginControl() {
    const nodes = document.querySelectorAll("a, button");
    for (const el of nodes) {
      if (!SideraSession.isLoginLabel(this._controlName(el))) continue;
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") continue;
      return el;
    }
    return null;
  },
  emailField() {
    return document.querySelector('input[type="email"], input[name="email"], input[name="username"], input[autocomplete="username"]');
  },
  isLoggedIn() {
    if (typeof SideraSession === "undefined") return this.isComposerReady();
    return !SideraSession.needsLogin({
      authUrl: SideraSession.isGrokAuthUrl(window.location.href),
      hasComposer: this.isComposerReady(),
      loginControlVisible: this.loginControl() !== null,
    });
  },
  openLogin() {
    const email = this.emailField();
    if (email) {
      email.focus();
      return "focus";
    }
    const control = this.loginControl();
    if (control) {
      SideraDom.clickControl(control);
      return "click";
    }
    if (!SideraSession.isGrokAuthUrl(window.location.href)) {
      window.location.assign("https://accounts.x.ai/sign-in");
      return "navigate";
    }
    return "waiting";
  },
  setComposerText(text) {
    const composer = SideraDom.queryFirst(this.selectors.composerTextarea, { visible: true });
    if (!composer) throw new Error("Grok composer not found.");
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

globalThis.GrokAdapter = GrokAdapter;
