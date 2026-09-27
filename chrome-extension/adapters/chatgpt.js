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
    userMessage: [
      '[data-message-author-role="user"]',
      'article[data-turn="user"]',
    ],
    newChatControl: [
      'a[data-testid="create-new-chat-button"]',
      'a[aria-label="New chat"]',
      'button[aria-label="New chat"]',
    ],
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
    const turns = [...document.querySelectorAll('ol[aria-label="Conversation"] > li')];
    // Scan from the newest turn backwards; reading every heading's innerText
    // forces layout per turn and stalls long conversations.
    let lastLabeled = null;
    for (let i = turns.length - 1; i >= 0; i--) {
      const heading = turns[i].querySelector("h4, h3, h2");
      if (heading && /^chatgpt said\b/i.test((heading.textContent || "").trim())) {
        lastLabeled = turns[i];
        break;
      }
    }
    if (lastLabeled) {
      const text = (lastLabeled.innerText || "").trim().replace(/^chatgpt said:\s*/i, "").trim();
      if (text) return { element: lastLabeled, text: text };
    }
    // ChatGPT appends empty assistant nodes (ad slots, pending follow-ups)
    // after the real answer, so take the newest assistant node with text.
    for (const sel of this.selectors.assistantMessage.slice(0, 4)) {
      let nodes = [];
      try {
        nodes = document.querySelectorAll(sel);
      } catch (err) {
        continue;
      }
      for (let i = nodes.length - 1; i >= 0; i--) {
        const textSource = this._contentWithin(nodes[i]) || nodes[i];
        const text = (textSource.innerText || "").trim();
        if (text) return { element: nodes[i], text: text };
      }
    }
    return null;
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
      authUrl: SideraSession.isAuthUrl(window.location.href),
      hasComposer: this.isComposerReady(),
      loginControlVisible: this.loginControl() !== null,
    });
  },
  // Opens the site's own sign-in. Chrome's saved login or password manager
  // fills the account; Sidera never sees the password.
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
    if (!SideraSession.isAuthUrl(window.location.href)) {
      window.location.assign("https://chatgpt.com/auth/login");
      return "navigate";
    }
    return "waiting";
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
