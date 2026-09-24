// Exercises content.js against a fake page: a reply that stays blank while the
// site keeps "generating" must be stopped and resent exactly once, and a
// finished reply must be captured once the page has been quiet.
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..", "chrome-extension");

function makeContext() {
  let now = 1_000_000;
  const sent = [];
  const timers = [];
  const fakeSite = {
    generating: false,
    latest: "",
    stops: 0,
    composer: "",
    submits: 0,
    identifyTab: () => true,
    isGenerating() { return this.generating; },
    getLatestAssistantMessage() { return this.latest ? { element: {}, text: this.latest } : null; },
    stopGenerating() { this.stops += 1; this.generating = false; return true; },
    setComposerText(text) { this.composer = text; },
    submitComposer() { this.submits += 1; return true; },
  };
  const ctx = {
    console: { log() {}, warn() {} },
    Date: { now: () => now },
    Math,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout() {},
    setInterval: () => 1,
    clearInterval() {},
    MutationObserver: class { observe() {} disconnect() {} },
    document: { documentElement: { dataset: {} }, body: {} },
    window: { location: { hostname: "chatgpt.com" } },
    chrome: { runtime: { sendMessage: (m) => sent.push(m), onMessage: { addListener(fn) { ctx.__in = fn; } } } },
    ChatGPTAdapter: fakeSite,
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(root, "completion.js"), "utf8"), ctx);
  vm.runInContext(fs.readFileSync(path.join(root, "content.js"), "utf8"), ctx);
  return {
    ctx,
    site: fakeSite,
    sent,
    timers,
    advance(ms) { now += ms; },
    flushTimers() { const pending = timers.splice(0); pending.forEach((t) => t.fn()); },
  };
}

// Hung reply: stop and resend once.
{
  const t = makeContext();
  t.ctx.__in({ type: "ASSIGN_HEMISPHERE", hemisphere: "LEFT" }, {}, () => {});
  t.ctx.__in({ type: "INJECT_AND_SUBMIT", text: "hello from the other side", message_id: "SIDERA-0000001" }, {}, () => {});
  t.flushTimers();
  assert.strictEqual(t.site.submits, 1);
  assert.ok(t.sent.some((m) => m.type === "SUBMISSION_CONFIRMED"));

  t.site.generating = true;
  t.ctx.__sideraHeartbeat();
  t.advance(5 * 60 * 1000);
  t.ctx.__sideraHeartbeat();
  assert.strictEqual(t.site.stops, 0, "must not give up before the stuck window");

  t.advance(2 * 60 * 1000);
  t.ctx.__sideraHeartbeat();
  assert.strictEqual(t.site.stops, 1, "hung reply should be stopped");
  t.flushTimers();
  t.flushTimers();
  assert.strictEqual(t.site.composer, "hello from the other side");
  assert.strictEqual(t.site.submits, 2, "message should be resent once");
  assert.strictEqual(t.sent.filter((m) => m.type === "SUBMISSION_CONFIRMED").length, 1, "resend is silent");

  t.site.generating = true;
  t.ctx.__sideraHeartbeat();
  t.advance(10 * 60 * 1000);
  t.ctx.__sideraHeartbeat();
  assert.strictEqual(t.site.stops, 1, "only one retry per message");
}

// Streaming reply that keeps growing is never interrupted.
{
  const t = makeContext();
  t.ctx.__in({ type: "ASSIGN_HEMISPHERE", hemisphere: "LEFT" }, {}, () => {});
  t.ctx.__in({ type: "INJECT_AND_SUBMIT", text: "q", message_id: "SIDERA-0000002" }, {}, () => {});
  t.flushTimers();
  t.site.generating = true;
  for (let i = 0; i < 10; i++) {
    t.site.latest += "more words ";
    t.advance(4 * 60 * 1000);
    t.ctx.__sideraHeartbeat();
  }
  assert.strictEqual(t.site.stops, 0);
}

// Finished reply is captured by the heartbeat once the page is quiet.
{
  const t = makeContext();
  t.ctx.__in({ type: "ASSIGN_HEMISPHERE", hemisphere: "RIGHT" }, {}, () => {});
  t.site.latest = "A finished answer that ends with a question?";
  t.advance(3000);
  t.ctx.__sideraHeartbeat();
  const captured = t.sent.filter((m) => m.type === "RESPONSE_CAPTURED");
  assert.strictEqual(captured.length, 1);
  assert.strictEqual(captured[0].source, "RIGHT");
  assert.strictEqual(captured[0].content, t.site.latest);
  t.ctx.__sideraHeartbeat();
  assert.strictEqual(t.sent.filter((m) => m.type === "RESPONSE_CAPTURED").length, 1, "no duplicate capture");
}

// A canned error is resent once instead of being forwarded; a second
// failure is forwarded so the conversation never hangs on it.
{
  const t = makeContext();
  t.ctx.__in({ type: "ASSIGN_HEMISPHERE", hemisphere: "RIGHT" }, {}, () => {});
  t.ctx.__in({ type: "INJECT_AND_SUBMIT", text: "a real question?", message_id: "SIDERA-0000003" }, {}, () => {});
  t.flushTimers();
  t.site.latest = "I'm having a hard time fulfilling your request. Can I help you with something else instead?";
  t.advance(3000);
  t.ctx.__sideraHeartbeat();
  assert.strictEqual(t.sent.filter((m) => m.type === "RESPONSE_CAPTURED").length, 0, "error text is not forwarded");
  t.flushTimers();
  t.flushTimers();
  assert.strictEqual(t.site.submits, 2, "message resent after error");
  assert.strictEqual(t.site.composer, "a real question?");

  t.advance(20000);
  t.site.latest = "A proper answer after the retry. Would you agree?";
  t.ctx.__sideraHeartbeat();
  const captured = t.sent.filter((m) => m.type === "RESPONSE_CAPTURED");
  assert.strictEqual(captured.length, 1);
  assert.strictEqual(captured[0].content, t.site.latest);
}

{
  const t = makeContext();
  t.ctx.__in({ type: "ASSIGN_HEMISPHERE", hemisphere: "RIGHT" }, {}, () => {});
  t.ctx.__in({ type: "INJECT_AND_SUBMIT", text: "q", message_id: "SIDERA-0000004" }, {}, () => {});
  t.flushTimers();
  t.site.latest = "Something went wrong. Please try again.";
  t.advance(3000);
  t.ctx.__sideraHeartbeat();
  t.flushTimers();
  t.flushTimers();
  assert.strictEqual(t.site.submits, 2);
  t.advance(20000);
  t.site.latest = "Something went wrong. Please try again later.";
  t.ctx.__sideraHeartbeat();
  assert.strictEqual(t.sent.filter((m) => m.type === "RESPONSE_CAPTURED").length, 1, "second failure is forwarded rather than hanging");
}

// A re-paired copy can still retry the message the previous copy pasted.
{
  const t = makeContext();
  t.ctx.__in({ type: "ASSIGN_HEMISPHERE", hemisphere: "RIGHT" }, {}, () => {});
  t.ctx.document.documentElement.dataset.sideraInjected = JSON.stringify({ text: "from before", messageId: "SIDERA-0000005", retried: false });
  t.site.latest = "An error occurred.";
  t.advance(3000);
  t.ctx.__sideraHeartbeat();
  t.flushTimers();
  t.flushTimers();
  assert.strictEqual(t.site.composer, "from before");
  assert.strictEqual(t.site.submits, 1);
}

// A newer paired copy retires the older one.
{
  const t = makeContext();
  t.ctx.__in({ type: "ASSIGN_HEMISPHERE", hemisphere: "RIGHT" }, {}, () => {});
  t.ctx.document.documentElement.dataset.sideraInstance = "someone-newer";
  t.site.latest = "New text";
  t.advance(3000);
  t.ctx.__sideraHeartbeat();
  assert.strictEqual(t.sent.filter((m) => m.type === "RESPONSE_CAPTURED").length, 0, "retired copy stays silent");
}

console.log("content recovery ok");
