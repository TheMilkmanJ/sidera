/**
 * Which browser tabs Sidera can pair, and which saved login each one uses.
 * LEFT and RIGHT are chosen independently from this list. A hostname that is
 * not here does not pair. ChatGPT and Grok still have saved logins; Gemini
 * and Claude use the account already signed in in the browser.
 */
const SideraSites = {
  SITES: [
    { id: "chatgpt", label: "ChatGPT", login: "chatgpt" },
    { id: "grok", label: "Grok", login: "grok" },
    { id: "gemini", label: "Gemini", login: null },
    { id: "claude", label: "Claude", login: null },
  ],

  emptySlot() {
    return { adapter: null, tabId: null };
  },

  emptyRegistry() {
    return { LEFT: this.emptySlot(), RIGHT: this.emptySlot() };
  },

  labelFor(adapter) {
    const site = this.SITES.find((item) => item.id === adapter);
    return site ? site.label : "";
  },

  loginServiceFor(adapter) {
    const site = this.SITES.find((item) => item.id === adapter);
    return site && site.login ? site.login : null;
  },

  unsupportedMessage() {
    return "This page is not a supported AI site. Open ChatGPT, Grok, Gemini, or Claude, then pair that tab.";
  },

  pairConnectionMessage(raw) {
    if (raw && /receiving end does not exist|could not establish connection/i.test(raw)) {
      return "This tab has no Sidera adapter. Reload the page if it is ChatGPT, Grok, Gemini, or Claude, then pair it again.";
    }
    return raw || "This tab did not pair. Reload it and try again.";
  },

  _parsed(url) {
    try {
      return new URL(String(url || ""));
    } catch (err) {
      return null;
    }
  },

  _hostIs(hostname, name) {
    const host = String(hostname || "").toLowerCase();
    return host === name || host.endsWith("." + name);
  },

  // Matches the adapters' identifyTab() rules. Login hosts that are not the
  // chat host (auth.openai.com, accounts.x.ai) are intentionally absent.
  adapterForUrl(url) {
    const loc = this._parsed(url);
    if (!loc) return null;
    const host = loc.hostname.toLowerCase();
    const path = loc.pathname || "";
    if (this._hostIs(host, "chatgpt.com")) return "chatgpt";
    if (this._hostIs(host, "claude.ai")) return "claude";
    if (host === "gemini.google.com" || host.endsWith(".gemini.google.com")) return "gemini";
    if (this._hostIs(host, "grok.com")) return "grok";
    if ((host === "x.com" || host.endsWith(".x.com")) && path.includes("/i/grok")) return "grok";
    return null;
  },

  classify(url) {
    const adapter = this.adapterForUrl(url);
    if (!adapter) return { ok: false, error: this.unsupportedMessage() };
    return { ok: true, adapter: adapter, label: this.labelFor(adapter) };
  },

  // Sign-in pages the chat host redirects to. A paired tab may sit here
  // without being dropped; the page itself is not a chat to pair.
  isLoginUrlFor(adapter, url) {
    const loc = this._parsed(url);
    if (!loc) return false;
    const host = loc.hostname.toLowerCase();
    const path = (loc.pathname || "").toLowerCase();
    if (adapter === "chatgpt") {
      if (this._hostIs(host, "auth.openai.com")) return true;
      if (this._hostIs(host, "chatgpt.com") && path.startsWith("/auth")) return true;
      return false;
    }
    if (adapter === "grok") {
      if (this._hostIs(host, "accounts.x.ai")) return true;
      if (this._hostIs(host, "grok.com") && (path.startsWith("/login") || path.startsWith("/sign-in") || path.startsWith("/auth"))) return true;
      if ((host === "x.com" || host.endsWith(".x.com")) && (path.startsWith("/login") || path.startsWith("/i/flow/login"))) return true;
      return false;
    }
    return false;
  },

  loginSite(service) {
    const known = {
      chatgpt: { label: "ChatGPT" },
      grok: { label: "Grok" },
    };
    const site = known[service];
    if (!site) return null;
    const self = this;
    return {
      label: site.label,
      auth(url) {
        return self.isLoginUrlFor(service, url);
      },
    };
  },

  // Saved-login checks for the paired tabs, LEFT then RIGHT. Gemini and
  // Claude are omitted; they have no saved login.
  loginQueue(registry) {
    const queue = [];
    for (const slotId of ["LEFT", "RIGHT"]) {
      const slot = registry && registry[slotId];
      if (!slot || !slot.tabId) continue;
      const service = this.loginServiceFor(slot.adapter);
      if (!service) continue;
      queue.push({
        slotId: slotId,
        tabId: slot.tabId,
        service: service,
        label: this.labelFor(slot.adapter),
      });
    }
    return queue;
  },

  // One tab occupies one side. Pairing it to the other side removes it from
  // the first so a reply cannot be counted twice.
  assignSlot(registry, slotId, tabId, adapter) {
    const side = String(slotId || "").toUpperCase();
    if (side !== "LEFT" && side !== "RIGHT") {
      return { ok: false, error: "Choose LEFT or RIGHT." };
    }
    if (!tabId || !this.labelFor(adapter)) {
      return { ok: false, error: this.unsupportedMessage() };
    }
    const next = {
      LEFT: this._copySlot(registry && registry.LEFT),
      RIGHT: this._copySlot(registry && registry.RIGHT),
    };
    const other = side === "LEFT" ? "RIGHT" : "LEFT";
    let displaced = null;
    if (next[other].tabId === tabId) {
      next[other] = this.emptySlot();
      displaced = other;
    }
    next[side] = { adapter: adapter, tabId: tabId };
    return { ok: true, registry: next, displaced: displaced };
  },

  _copySlot(slot) {
    if (!slot || !slot.tabId) return this.emptySlot();
    return { adapter: slot.adapter || null, tabId: slot.tabId };
  },
};

globalThis.SideraSites = SideraSites;
