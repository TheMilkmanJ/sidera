/**
 * Grok (grok.com and x.com/i/grok) DOM adapter.
 * Selectors are tried in priority order so a hidden duplicate control
 * (common on grok.com) is skipped in favor of the visible one.
 *
 * Verified against the live grok.com structure (2026):
 * - Composer is a TipTap/ProseMirror contenteditable (.tiptap.ProseMirror).
 *   Older builds still expose textarea[aria-label="Ask Grok anything"].
 * - Assistant bubbles use data-testid="assistant-message" (user bubbles are
 *   data-testid="user-message" and must not be captured).
 * - Send control is button[aria-label="Submit"] and only enables once the
 *   composer has text. Stop is an aria-label containing "Stop".
 */
const GrokAdapter = {
  name: "Grok",
  selectors: {
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
      'button[aria-label="Stop"]',
      'button[aria-label="Stop response"]',
      'button[aria-label="Stop generating"]',
      'button[data-testid="stop-generation"]',
      'button[aria-label*="Stop"]',
    ],
    sendButton: [
      'button[aria-label="Submit"]',
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
  getLatestAssistantMessage() {
    const lastMsg = SideraDom.queryLast(this.selectors.assistantMessage);
    if (!lastMsg) return null;
    let contentEl = null;
    for (const sel of this.selectors.messageContent) {
      if (lastMsg.matches && lastMsg.matches(sel)) {
        contentEl = lastMsg;
        break;
      }
      const nested = lastMsg.querySelector(sel);
      if (nested) {
        contentEl = nested;
        break;
      }
    }
    const textSource = contentEl || lastMsg;
    return { element: lastMsg, text: (textSource.innerText || "").trim() };
  },
  isComposerReady() {
    const composer = SideraDom.queryFirst(this.selectors.composerTextarea, { visible: true });
    return composer !== null && !composer.disabled && composer.getAttribute("aria-disabled") !== "true" && !this.isGenerating();
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
