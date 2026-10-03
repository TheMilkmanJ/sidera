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
    chatgpt: { label: "ChatGPT", loginService: "chatgpt", homeUrl: "https://chatgpt.com/" },
    grok: { label: "Grok", loginService: "grok", homeUrl: "https://grok.com/" },
    // Gemini has no scripted login flow; its sign-in check is skipped.
    gemini: { label: "Gemini", loginService: null, homeUrl: "https://gemini.google.com/app" },
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

  homeUrl(type) {
    const site = this.ADAPTERS[String(type || "").toLowerCase()];
    return site ? site.homeUrl : "";
  },

  // Plain wording for the mediator's internal state names, so the popup
  // never shows the operator strings like "WAIT_LEFT".
  stateLabel(state) {
    const labels = {
      IDLE: "Idle",
      WAIT_LEFT: "Waiting for LEFT",
      WAIT_RIGHT: "Waiting for RIGHT",
      LEFT_COMPLETE: "LEFT replied",
      RIGHT_COMPLETE: "RIGHT replied",
      PROCESS: "Processing",
      SEND_LEFT: "Sending to LEFT",
      SEND_RIGHT: "Sending to RIGHT",
      PAUSED: "Paused",
      ERROR: "Needs attention",
      // Same words as the "Sidera program" row, so the two never disagree.
      DISCONNECTED: "Not running",
    };
    return labels[String(state || "").toUpperCase()] || String(state || "");
  },

  // Plain wording for Chrome's internal messaging errors, so the operator
  // never sees "Receiving end does not exist".
  plainTabError(raw, what) {
    const text = String(raw || "");
    const subject = what || "that tab";
    if (/receiving end does not exist|could not establish connection/i.test(text)) {
      return `Sidera is not attached to ${subject}. Reload the tab (press F5 in it), then pair it again.`;
    }
    if (/no tab with id|tab was closed|no current window/i.test(text)) {
      return `${subject.charAt(0).toUpperCase() + subject.slice(1)} is no longer open. Pair another tab.`;
    }
    return `Sidera could not reach ${subject}. Reload the tab, then pair it again.`;
  },

  // Which tab a side's picker should preselect. The operator's own choice is
  // kept; otherwise the side's paired tab; otherwise a tab the OTHER side is
  // not using, so two same-site pickers never default to the same tab.
  chooseTab(tabs, { pairedTabId = null, avoidTabIds = [], previousValue = null } = {}) {
    if (!tabs || tabs.length === 0) return null;
    const ids = tabs.map((tab) => tab.id);
    if (previousValue != null && ids.includes(previousValue)) return previousValue;
    if (pairedTabId != null && ids.includes(pairedTabId)) return pairedTabId;
    const avoid = new Set(avoidTabIds.filter((id) => id != null));
    const free = tabs.filter((tab) => !avoid.has(tab.id));
    const pool = free.length ? free : tabs;
    const active = pool.find((tab) => tab.active);
    return (active || pool[0]).id;
  },

  // Readable label for a tab in the picker: the window (when there is more
  // than one), a tab number (when one window holds several tabs of the same
  // site, which often all read just "ChatGPT"), plus the chat title, so two
  // same-site tabs can always be told apart.
  // Number the same-site tabs within each window (1, 2, ...) in tab order,
  // but only in windows that hold more than one of them. Returns a Map from
  // tab id to its number; tabs alone in their window get no number.
  tabNumbers(tabs) {
    const byWindow = new Map();
    for (const tab of tabs || []) {
      if (!byWindow.has(tab.windowId)) byWindow.set(tab.windowId, []);
      byWindow.get(tab.windowId).push(tab);
    }
    const numbers = new Map();
    for (const group of byWindow.values()) {
      if (group.length < 2) continue;
      group
        .slice()
        .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
        .forEach((tab, i) => numbers.set(tab.id, i + 1));
    }
    return numbers;
  },

  // The URL a tab is on or about to be on. A tab that was just opened may
  // only have pendingUrl until its first navigation commits.
  tabUrl(tab) {
    return (tab && (tab.url || tab.pendingUrl)) || "";
  },

  describeTab(tab, { windowNumber = 1, multiWindow = false, tabNumber = null, pairedAs = null } = {}) {
    let title = String(tab.title || tab.url || "").trim();
    if (title.length > 40) title = title.slice(0, 39).trimEnd() + "…";
    const parts = [];
    if (multiWindow && tabNumber != null) parts.push(`Window ${windowNumber}, tab ${tabNumber}: `);
    else if (multiWindow) parts.push(`Window ${windowNumber}: `);
    else if (tabNumber != null) parts.push(`Tab ${tabNumber}: `);
    parts.push(title || "(untitled tab)");
    if (pairedAs) parts.push(` — paired as ${pairedAs}`);
    return parts.join("");
  },
};

if (typeof globalThis !== "undefined") globalThis.SideraSites = SideraSites;
