/**
 * Shared registry of the three supported AI chat sites.
 * Used by the popup (per-side site and tab pickers) and the background
 * (pairing and the Start sign-in checks). Either side may use any site,
 * including the same site on both sides: a slot is bound to one tab id,
 * never to a site or URL match, so messages always reach the tab that was
 * paired and never bounce back to the sender.
 */
const SideraSites = {
  ADAPTERS: {
    chatgpt: { label: "ChatGPT", loginService: "chatgpt" },
    grok: { label: "Grok", loginService: "grok" },
    // Gemini has no scripted login flow; its sign-in check is skipped.
    gemini: { label: "Gemini", loginService: null },
  },

  // Longstanding defaults: LEFT is ChatGPT, RIGHT is Grok.
  DEFAULTS: { LEFT: "chatgpt", RIGHT: "grok" },

  // A known adapter name, or the side's default when the value is missing
  // or names an unsupported site.
  normalizeAdapter(type, side) {
    const name = String(type || "").toLowerCase();
    if (this.ADAPTERS[name]) return name;
    return this.DEFAULTS[String(side || "").toUpperCase()] || "chatgpt";
  },

  adapterLabel(type) {
    const site = this.ADAPTERS[String(type || "").toLowerCase()];
    return site ? site.label : String(type || "");
  },

  loginServiceFor(type) {
    const site = this.ADAPTERS[String(type || "").toLowerCase()];
    return site ? site.loginService : null;
  },

  // Which supported site a tab URL belongs to, or null. Each site's login
  // hosts count too: a tab parked on a sign-in page can be paired and is
  // polled until the chat composer is back.
  siteForUrl(url) {
    let parsed;
    try {
      parsed = new URL(String(url || ""));
    } catch (err) {
      return null;
    }
    if (parsed.protocol !== "https:") return null;
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname.toLowerCase();
    const on = (name) => host === name || host.endsWith("." + name);
    if (on("chatgpt.com") || on("auth.openai.com")) return "chatgpt";
    if (on("grok.com") || on("accounts.x.ai")) return "grok";
    if (on("x.com")) {
      // Grok inside X, or X's login wall on the way to it.
      if (path.startsWith("/i/grok") || path.startsWith("/login") || path.startsWith("/i/flow/login")) return "grok";
      return null;
    }
    if (on("gemini.google.com")) return "gemini";
    return null;
  },

  urlMatchesAdapter(type, url) {
    return this.siteForUrl(url) === String(type || "").toLowerCase();
  },

  otherSide(side) {
    return String(side || "").toUpperCase() === "LEFT" ? "RIGHT" : "LEFT";
  },

  // Error text when the tab is already held by the other side, else null.
  // Both sides may use the same site, but never the same tab.
  pairingConflict(slotRegistry, side, tabId) {
    const other = this.otherSide(side);
    const slot = slotRegistry && slotRegistry[other];
    if (slot && slot.tabId != null && slot.tabId === tabId) {
      return `That tab is already paired as ${other}. Both sides can use the same site, but each side needs its own tab.`;
    }
    return null;
  },
};

if (typeof globalThis !== "undefined") globalThis.SideraSites = SideraSites;
