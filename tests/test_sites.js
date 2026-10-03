// Side selection rules: which site a tab URL belongs to, per-side adapter
// defaults, login-service lookup, and the one hard rule of same-site pairing:
// both sides may use the same site, but never the same tab.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../chrome-extension/sites.js"), "utf8");
const context = { URL };
context.globalThis = context;
vm.runInNewContext(source, context);
const Sites = context.globalThis.SideraSites;

// URL -> site, including login hosts and Grok inside X.
assert.equal(Sites.siteForUrl("https://chatgpt.com/"), "chatgpt");
assert.equal(Sites.siteForUrl("https://chatgpt.com/c/abc123"), "chatgpt");
assert.equal(Sites.siteForUrl("https://auth.openai.com/log-in"), "chatgpt");
assert.equal(Sites.siteForUrl("https://grok.com/chat"), "grok");
assert.equal(Sites.siteForUrl("https://accounts.x.ai/sign-in"), "grok");
assert.equal(Sites.siteForUrl("https://x.com/i/grok"), "grok");
assert.equal(Sites.siteForUrl("https://x.com/i/flow/login"), "grok");
assert.equal(Sites.siteForUrl("https://x.com/home"), null, "plain X is not a Sidera site");
assert.equal(Sites.siteForUrl("https://gemini.google.com/app"), "gemini");
assert.equal(Sites.siteForUrl("https://example.com/"), null);
assert.equal(Sites.siteForUrl("http://chatgpt.com/"), null, "only https counts");
assert.equal(Sites.siteForUrl("not a url"), null);
assert.equal(Sites.siteForUrl(""), null);

assert.equal(Sites.urlMatchesAdapter("chatgpt", "https://chatgpt.com/"), true);
assert.equal(Sites.urlMatchesAdapter("grok", "https://chatgpt.com/"), false);

// Any supported site is accepted for either side; defaults match the old
// hard-wired behavior (LEFT ChatGPT, RIGHT Grok); unsupported names fall
// back to the side default instead of inventing a new site.
assert.equal(Sites.normalizeAdapter("chatgpt", "RIGHT"), "chatgpt");
assert.equal(Sites.normalizeAdapter("gemini", "LEFT"), "gemini");
assert.equal(Sites.normalizeAdapter("grok", "LEFT"), "grok");
assert.equal(Sites.normalizeAdapter(undefined, "LEFT"), "chatgpt");
assert.equal(Sites.normalizeAdapter(undefined, "RIGHT"), "grok");
assert.equal(Sites.normalizeAdapter("claude", "RIGHT"), "grok", "unsupported site falls back");
assert.equal(Sites.normalizeAdapter("CHATGPT", "RIGHT"), "chatgpt", "case-insensitive");

assert.equal(Sites.adapterLabel("chatgpt"), "ChatGPT");
assert.equal(Sites.adapterLabel("grok"), "Grok");
assert.equal(Sites.adapterLabel("gemini"), "Gemini");

assert.equal(Sites.loginServiceFor("chatgpt"), "chatgpt");
assert.equal(Sites.loginServiceFor("grok"), "grok");
assert.equal(Sites.loginServiceFor("gemini"), null, "Gemini has no scripted login");

assert.equal(Sites.otherSide("LEFT"), "RIGHT");
assert.equal(Sites.otherSide("RIGHT"), "LEFT");

// Same tab on both sides is rejected; a different tab of the same site is fine.
const registry = { LEFT: { adapter: "chatgpt", tabId: 11 }, RIGHT: { adapter: "chatgpt", tabId: 22 } };
assert.ok(Sites.pairingConflict(registry, "RIGHT", 11), "LEFT's tab cannot also be RIGHT");
assert.ok(Sites.pairingConflict(registry, "LEFT", 22), "RIGHT's tab cannot also be LEFT");
assert.equal(Sites.pairingConflict(registry, "RIGHT", 33), null, "a third tab is fine");
assert.equal(Sites.pairingConflict(registry, "LEFT", 11), null, "re-pairing the same side is fine");
assert.equal(Sites.pairingConflict({ LEFT: { adapter: "chatgpt", tabId: null }, RIGHT: {} }, "RIGHT", 11), null, "unpaired side never conflicts");

console.log("sites checks passed");
