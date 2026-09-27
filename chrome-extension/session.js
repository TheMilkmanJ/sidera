/**
 * Decides whether a ChatGPT tab still needs a sign-in before Sidera can paste.
 * The password stays in the browser; this only recognizes the login wall.
 */
const SideraSession = {
  LOGIN_WAIT_MS: 10 * 60 * 1000,

  isAuthUrl(url) {
    let parsed;
    try {
      parsed = new URL(String(url || ""));
    } catch (err) {
      return false;
    }
    const host = parsed.hostname.toLowerCase();
    if (host === "auth.openai.com" || host.endsWith(".auth.openai.com")) return true;
    if (host === "chatgpt.com" || host.endsWith(".chatgpt.com")) {
      return parsed.pathname.toLowerCase().startsWith("/auth");
    }
    return false;
  },

  isGrokAuthUrl(url) {
    let parsed;
    try {
      parsed = new URL(String(url || ""));
    } catch (err) {
      return false;
    }
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname.toLowerCase();
    if (host === "accounts.x.ai" || host.endsWith(".accounts.x.ai")) return true;
    if (host === "grok.com" || host.endsWith(".grok.com")) {
      return path.startsWith("/login") || path.startsWith("/sign-in") || path.startsWith("/auth");
    }
    if (host === "x.com" || host.endsWith(".x.com")) {
      return path.startsWith("/login") || path.startsWith("/i/flow/login");
    }
    return false;
  },

  isServiceAuthUrl(service, url) {
    return service === "grok" ? this.isGrokAuthUrl(url) : this.isAuthUrl(url);
  },

  isLoginLabel(text) {
    const name = String(text || "").replace(/\s+/g, " ").trim().toLowerCase();
    return name === "log in" || name === "login" || name === "sign in" || name === "sign up";
  },

  isContinueLabel(text) {
    const name = String(text || "").replace(/\s+/g, " ").trim().toLowerCase();
    if (name.startsWith("continue with") || name.startsWith("sign in with") || name.startsWith("log in with")) {
      return false;
    }
    return name === "continue" || name === "log in" || name === "login" || name === "sign in";
  },

  // Which saved-login field to fill on this page. "wait" covers 2FA and captchas.
  nextLoginStep({ emailVisible, passwordVisible, emailFilled, passwordFilled }) {
    if (passwordVisible && !passwordFilled) return "password";
    if (emailVisible && !passwordVisible && !emailFilled) return "email";
    return "wait";
  },

  // A usable composer with no login control means the account session is already there.
  needsLogin({ authUrl, hasComposer, loginControlVisible }) {
    if (authUrl) return true;
    if (loginControlVisible) return true;
    return !hasComposer;
  },
};

globalThis.SideraSession = SideraSession;
