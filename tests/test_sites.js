// Each side is chosen from the tab that is actually open. ChatGPT, Grok,
// Gemini and Claude can sit on either side, including twice, and anything
// else is refused. Two tabs of one site stay two tabs.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..", "chrome-extension");

function same(actual, expected) {
  assert.equal(JSON.stringify(actual), JSON.stringify(expected));
}

function load(filename, href) {
  const url = new URL(href);
  const context = {
    URL,
    window: { location: url },
    document: { querySelectorAll() { return []; }, querySelector() { return null; } },
    globalThis: null,
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(root, filename), "utf8"), context);
  return context;
}

const sites = load("sites.js", "https://chatgpt.com/").SideraSites;
const session = load("session.js", "https://chatgpt.com/").SideraSession;

const ADAPTERS = [
  ["chatgpt.js", "chatgpt"],
  ["grok.js", "grok"],
  ["gemini.js", "gemini"],
  ["claude.js", "claude"],
];

const PAGES = [
  ["https://chatgpt.com/", "chatgpt"],
  ["https://chatgpt.com/c/abc", "chatgpt"],
  ["https://www.chatgpt.com/c/abc", "chatgpt"],
  ["https://chatgpt.com/auth/login", "chatgpt"],
  ["https://auth.openai.com/log-in", null],
  ["https://grok.com/", "grok"],
  ["https://grok.com/login", "grok"],
  ["https://x.com/i/grok", "grok"],
  ["https://x.com/home", null],
  ["https://accounts.x.ai/sign-in", null],
  ["https://gemini.google.com/app", "gemini"],
  ["https://google.com/", null],
  ["https://claude.ai/new", "claude"],
  ["https://claude.ai/chat/abc", "claude"],
  ["https://www.claude.ai/new", "claude"],
  ["https://example.com/", null],
  ["https://notclaude.ai/", null],
  ["https://claude.ai.evil.com/", null],
  ["https://wikipedia.org/", null],
];

for (const [href, expected] of PAGES) {
  const found = sites.classify(href);
  if (expected) {
    assert.equal(found.ok, true, href);
    assert.equal(found.adapter, expected, href);
    assert.equal(found.label, sites.labelFor(expected), href);
  } else {
    assert.equal(found.ok, false, href);
    assert.match(found.error, /ChatGPT, Grok, Gemini, or Claude/);
    assert.equal(sites.adapterForUrl(href), null, href);
  }
  for (const [file, id] of ADAPTERS) {
    const ctx = load("adapters/" + file, href);
    const adapter = ctx.ChatGPTAdapter || ctx.GeminiAdapter || ctx.GrokAdapter || ctx.ClaudeAdapter;
    assert.equal(adapter.identifyTab(), id === expected, `${file} ${href}`);
  }
}

const loginSamples = [
  "https://auth.openai.com/log-in",
  "https://chatgpt.com/auth/login",
  "https://chatgpt.com/c/abc",
  "https://accounts.x.ai/sign-in",
  "https://x.com/i/flow/login",
  "https://grok.com/",
  "https://grok.com/login",
  "https://claude.ai/login",
  "https://gemini.google.com/app",
  "not a url",
];
for (const href of loginSamples) {
  assert.equal(sites.isLoginUrlFor("chatgpt", href), session.isAuthUrl(href), href);
  assert.equal(sites.isLoginUrlFor("grok", href), session.isGrokAuthUrl(href), href);
}
assert.equal(sites.isLoginUrlFor("chatgpt", "https://auth.openai.com/log-in"), true);
assert.equal(sites.adapterForUrl("https://auth.openai.com/log-in"), null);
assert.equal(sites.isLoginUrlFor("grok", "https://accounts.x.ai/sign-in"), true);
assert.equal(sites.adapterForUrl("https://accounts.x.ai/sign-in"), null);

const options = ["chatgpt", "grok", "gemini", "claude"];
for (const left of options) {
  for (const right of options) {
    const registry = sites.assignSlot(
      sites.assignSlot(sites.emptyRegistry(), "LEFT", 10, left).registry,
      "RIGHT",
      20,
      right
    );
    assert.equal(registry.ok, true);
    assert.equal(registry.displaced, null);
    assert.equal(registry.registry.LEFT.adapter, left);
    assert.equal(registry.registry.LEFT.tabId, 10);
    assert.equal(registry.registry.RIGHT.adapter, right);
    assert.equal(registry.registry.RIGHT.tabId, 20);
  }
}

// The same site on both sides keeps two tab ids.
{
  const paired = sites.assignSlot(
    sites.assignSlot(sites.emptyRegistry(), "LEFT", 7, "chatgpt").registry,
    "RIGHT",
    8,
    "chatgpt"
  );
  assert.equal(paired.registry.LEFT.tabId, 7);
  assert.equal(paired.registry.RIGHT.tabId, 8);
  assert.notEqual(paired.registry.LEFT.tabId, paired.registry.RIGHT.tabId);
  const claude = sites.assignSlot(
    sites.assignSlot(sites.emptyRegistry(), "LEFT", 3, "claude").registry,
    "RIGHT",
    4,
    "claude"
  );
  assert.equal(claude.registry.LEFT.adapter, "claude");
  assert.equal(claude.registry.RIGHT.adapter, "claude");
  assert.equal(claude.registry.LEFT.tabId, 3);
  assert.equal(claude.registry.RIGHT.tabId, 4);
}

// One tab cannot occupy both sides.
{
  const moved = sites.assignSlot(
    sites.assignSlot(sites.emptyRegistry(), "LEFT", 7, "claude").registry,
    "RIGHT",
    7,
    "claude"
  );
  assert.equal(moved.displaced, "LEFT");
  assert.equal(moved.registry.LEFT.tabId, null);
  assert.equal(moved.registry.RIGHT.tabId, 7);
  assert.equal(moved.registry.RIGHT.adapter, "claude");
}

// ChatGPT on the left and Grok on the right still checks those two logins, in that order.
{
  const classic = sites.assignSlot(
    sites.assignSlot(sites.emptyRegistry(), "LEFT", 1, "chatgpt").registry,
    "RIGHT",
    2,
    "grok"
  ).registry;
  const queue = sites.loginQueue(classic);
  same(queue.map((item) => item.service), ["chatgpt", "grok"]);
  same(queue.map((item) => item.label), ["ChatGPT", "Grok"]);
  same(queue.map((item) => item.slotId), ["LEFT", "RIGHT"]);
}

// Gemini and Claude have no saved login, on either side. Grok on the left still does.
{
  const bothClaude = sites.assignSlot(
    sites.assignSlot(sites.emptyRegistry(), "LEFT", 3, "claude").registry,
    "RIGHT",
    4,
    "gemini"
  ).registry;
  same(sites.loginQueue(bothClaude), []);

  const swapped = sites.assignSlot(
    sites.assignSlot(sites.emptyRegistry(), "LEFT", 5, "grok").registry,
    "RIGHT",
    6,
    "chatgpt"
  ).registry;
  same(sites.loginQueue(swapped).map((item) => [item.slotId, item.service]), [
    ["LEFT", "grok"],
    ["RIGHT", "chatgpt"],
  ]);

  const chatgptAndGemini = sites.assignSlot(
    sites.assignSlot(sites.emptyRegistry(), "LEFT", 1, "chatgpt").registry,
    "RIGHT",
    2,
    "gemini"
  ).registry;
  same(sites.loginQueue(chatgptAndGemini).map((item) => item.service), ["chatgpt"]);
}

{
  const refused = sites.assignSlot(sites.emptyRegistry(), "LEFT", 1, "wikipedia");
  assert.equal(refused.ok, false);
  assert.match(refused.error, /not a supported AI site/);
  assert.equal(sites.assignSlot(sites.emptyRegistry(), "BOT3", 1, "claude").ok, false);
  assert.match(sites.pairConnectionMessage("Could not establish connection. Receiving end does not exist."), /Reload the page/);
}

// Claude's adapter reads the newest response and refuses a missing composer.
{
  const nodes = [
    { innerText: "older", textContent: "older", matches() { return false; }, querySelector() { return null; } },
    { innerText: "newest claude reply", textContent: "newest claude reply", matches() { return false; }, querySelector() { return null; } },
  ];
  const ctx = {
    URL,
    window: { location: new URL("https://claude.ai/new") },
    document: {
      querySelectorAll(sel) {
        return sel === ".font-claude-response" ? nodes : [];
      },
      querySelector() { return null; },
    },
    SideraDom: { queryFirst() { return null; } },
    globalThis: null,
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(root, "adapters/claude.js"), "utf8"), ctx);
  const latest = ctx.ClaudeAdapter.getLatestAssistantMessage();
  assert.equal(latest.text, "newest claude reply");
  assert.equal(ctx.ClaudeAdapter.id, "claude");
  assert.throws(() => ctx.ClaudeAdapter.setComposerText("hello"), /Claude composer not found/);
}

console.log("site pairing checks passed");
