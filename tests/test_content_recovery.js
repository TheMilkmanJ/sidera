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

// A re-paired copy inherits the hang timer instead of restarting it.
{
  const t = makeContext();
  t.ctx.__in({ type: "ASSIGN_HEMISPHERE", hemisphere: "LEFT" }, {}, () => {});
  const ds = t.ctx.document.documentElement.dataset;
  ds.sideraInjected = JSON.stringify({ text: "pasted earlier", messageId: "SIDERA-0000006", retried: false });
  ds.sideraGenSince = String(1_000_000 - 5 * 60 * 1000);
  ds.sideraGenLength = "0";
  t.site.generating = true;
  t.ctx.__sideraHeartbeat();
  assert.strictEqual(t.site.stops, 0);
  t.advance(90 * 1000);
  t.ctx.__sideraHeartbeat();
  assert.strictEqual(t.site.stops, 1, "timer continued from the previous copy");
  t.flushTimers();
  t.flushTimers();
  assert.strictEqual(t.site.composer, "pasted earlier");
  assert.strictEqual(ds.sideraGenSince, undefined, "timer cleared after retry");
}

// Second failure of the same message: move to a fresh chat and paste there.
{
  const t = makeContext();
  t.site.newChats = 0;
  t.site.startNewChat = function () { this.newChats += 1; this.latest = ""; return true; };
  t.ctx.__in({ type: "ASSIGN_HEMISPHERE", hemisphere: "RIGHT" }, {}, () => {});
  t.ctx.__in({ type: "INJECT_AND_SUBMIT", text: "keep going?", message_id: "SIDERA-0000007" }, {}, () => {});
  t.flushTimers();
  t.site.latest = "I encountered an error doing what you asked. Could you try again?";
  t.advance(3000);
  t.ctx.__sideraHeartbeat();
  t.flushTimers();
  t.flushTimers();
  assert.strictEqual(t.site.submits, 2, "first failure: plain resend");
  assert.strictEqual(t.site.newChats, 0);

  t.advance(20000);
  t.site.latest = "I encountered an error doing what you asked. Could you try again?";
  t.ctx.__sideraHeartbeat();
  assert.strictEqual(t.site.newChats, 1, "second failure: new chat");
  assert.strictEqual(t.sent.filter((m) => m.type === "RESPONSE_CAPTURED").length, 0, "error still not forwarded");
  t.flushTimers(); // brief request times out (no background in this test)
  t.flushTimers();
  t.flushTimers();
  assert.strictEqual(t.site.submits, 3, "message pasted into the new chat");
  assert.strictEqual(t.site.composer, "keep going?");

  t.advance(20000);
  t.site.latest = "A fresh answer in the new chat. Shall we continue?";
  t.ctx.__sideraHeartbeat();
  const captured = t.sent.filter((m) => m.type === "RESPONSE_CAPTURED");
  assert.strictEqual(captured.length, 1);
  assert.strictEqual(captured[0].content, t.site.latest);

  // A third failure of the same message is forwarded rather than looping.
  t.advance(20000);
  t.site.latest = "Something went wrong. Please try again.";
  t.ctx.__sideraHeartbeat();
  assert.strictEqual(t.site.newChats, 1);
  assert.strictEqual(t.sent.filter((m) => m.type === "RESPONSE_CAPTURED").length, 2);
}

// Proactive rotation after ROTATE_AFTER_PASTES pastes, with confirmation still sent.
{
  const t = makeContext();
  t.site.newChats = 0;
  t.site.startNewChat = function () { this.newChats += 1; return true; };
  t.ctx.__in({ type: "ASSIGN_HEMISPHERE", hemisphere: "LEFT" }, {}, () => {});
  t.ctx.document.documentElement.dataset.sideraPasteCount = "50";
  t.ctx.__in({ type: "INJECT_AND_SUBMIT", text: "the 51st message", message_id: "SIDERA-0000101" }, {}, () => {});
  assert.strictEqual(t.site.newChats, 1, "51st paste opens a new chat first");
  t.flushTimers(); // brief request times out
  t.flushTimers();
  t.flushTimers();
  assert.strictEqual(t.site.composer, "the 51st message");
  assert.strictEqual(t.site.submits, 1);
  assert.strictEqual(t.sent.filter((m) => m.type === "SUBMISSION_CONFIRMED" && m.message_id === "SIDERA-0000101").length, 1);
  assert.strictEqual(t.ctx.document.documentElement.dataset.sideraPasteCount, "1");
}

// With the Genesis Protocol known, a fresh chat is taught first; its READY is
// swallowed, then the queued message goes in and is confirmed to the mediator.
{
  const t = makeContext();
  t.site.newChats = 0;
  t.site.startNewChat = function () { this.newChats += 1; this.latest = ""; return true; };
  const genesis = "[SIDERA GENESIS PROTOCOL]\nUse the tags.\nReply now with exactly one word and nothing else: READY";
  t.ctx.__in({ type: "ASSIGN_HEMISPHERE", hemisphere: "RIGHT", genesis }, {}, () => {});
  t.ctx.document.documentElement.dataset.sideraPasteCount = "50";
  t.ctx.__in({ type: "INJECT_AND_SUBMIT", text: "message fifty-one", message_id: "SIDERA-0000151" }, {}, () => {});
  assert.strictEqual(t.site.newChats, 1);
  t.flushTimers(); // brief request times out
  t.flushTimers();
  t.flushTimers();
  assert.strictEqual(t.site.composer, genesis, "protocol is pasted before the message");
  assert.strictEqual(t.site.submits, 1);

  t.site.latest = "READY";
  t.advance(20000);
  t.ctx.__sideraHeartbeat();
  assert.strictEqual(t.sent.filter((m) => m.type === "RESPONSE_CAPTURED").length, 0, "READY is not sent to the mediator");
  t.flushTimers();
  t.flushTimers();
  assert.strictEqual(t.site.composer, "message fifty-one");
  assert.strictEqual(t.site.submits, 2);
  assert.strictEqual(t.sent.filter((m) => m.type === "SUBMISSION_CONFIRMED").map((m) => m.message_id).join(","), "SIDERA-0000151");

  t.advance(20000);
  t.site.latest = "A real reply in the fresh chat. Agreed?";
  t.ctx.__sideraHeartbeat();
  const captured = t.sent.filter((m) => m.type === "RESPONSE_CAPTURED");
  assert.strictEqual(captured.length, 1);
  assert.strictEqual(captured[0].content, t.site.latest);
}

// A fresh chat asks the mediator for a catch-up brief and pastes it ahead of
// the pending message (after the Genesis READY); without a reply it carries on
// after the timeout with the message alone.
{
  const t = makeContext();
  t.site.newChats = 0;
  t.site.startNewChat = function () { this.newChats += 1; this.latest = ""; return true; };
  const genesis = "[SIDERA GENESIS PROTOCOL]\nReply now with exactly one word and nothing else: READY";
  // Let the fake chrome.runtime answer CONTEXT_REQUEST like the background would.
  t.ctx.chrome.runtime.sendMessage = (m, cb) => { t.sent.push(m); if (m.type === "CONTEXT_REQUEST" && cb) cb({ text: "[SIDERA SYSTEM: Context restored for a fresh chat]\n- [MEM-000001 decisions/default] Use Galinstan." }); };
  t.ctx.__in({ type: "ASSIGN_HEMISPHERE", hemisphere: "RIGHT", genesis }, {}, () => {});
  t.ctx.document.documentElement.dataset.sideraPasteCount = "50";
  t.ctx.__in({ type: "INJECT_AND_SUBMIT", text: "message fifty-one", message_id: "SIDERA-0000151" }, {}, () => {});
  assert.strictEqual(t.site.newChats, 1);
  assert.strictEqual(t.sent.filter((m) => m.type === "CONTEXT_REQUEST" && m.hemisphere === "RIGHT").length, 1, "brief requested for the fresh chat");
  t.flushTimers();
  t.flushTimers();
  assert.strictEqual(t.site.composer, genesis, "protocol first");
  t.site.latest = "READY";
  t.advance(20000);
  t.ctx.__sideraHeartbeat();
  t.flushTimers();
  t.flushTimers();
  assert.ok(t.site.composer.startsWith("[SIDERA SYSTEM: Context restored for a fresh chat]"), t.site.composer);
  assert.ok(t.site.composer.endsWith("\n\nmessage fifty-one"), "pending message follows the brief");
  assert.strictEqual(t.sent.filter((m) => m.type === "SUBMISSION_CONFIRMED" && m.message_id === "SIDERA-0000151").length, 1);
}

{
  const t = makeContext();
  t.site.startNewChat = function () { this.latest = ""; return true; };
  // Background never answers: the timeout fires and the message goes in alone.
  t.ctx.chrome.runtime.sendMessage = (m) => { t.sent.push(m); };
  t.ctx.__in({ type: "ASSIGN_HEMISPHERE", hemisphere: "LEFT" }, {}, () => {});
  t.ctx.document.documentElement.dataset.sideraPasteCount = "50";
  t.ctx.__in({ type: "INJECT_AND_SUBMIT", text: "still going", message_id: "SIDERA-0000152" }, {}, () => {});
  t.flushTimers(); // brief timeout
  t.flushTimers(); // settle -> paste
  t.flushTimers(); // submit
  assert.strictEqual(t.site.composer, "still going");
  assert.strictEqual(t.sent.filter((m) => m.type === "SUBMISSION_CONFIRMED" && m.message_id === "SIDERA-0000152").length, 1);
}

// The rotation threshold follows the settings the mediator sends.
{
  const t = makeContext();
  t.site.newChats = 0;
  t.site.startNewChat = function () { this.newChats += 1; return true; };
  t.ctx.__in({ type: "ASSIGN_HEMISPHERE", hemisphere: "LEFT", settings: { rotate_after_pastes: 2 } }, {}, () => {});
  for (let i = 1; i <= 3; i++) {
    t.ctx.__in({ type: "INJECT_AND_SUBMIT", text: `m${i}`, message_id: `SIDERA-000020${i}` }, {}, () => {});
    for (let k = 0; k < 4; k++) t.flushTimers();
  }
  assert.strictEqual(t.site.newChats, 1, "third paste rotates when the threshold is 2");
  t.ctx.__in({ type: "SET_SETTINGS", settings: { rotate_after_pastes: 100 } }, {}, () => {});
  for (let i = 4; i <= 8; i++) {
    t.ctx.__in({ type: "INJECT_AND_SUBMIT", text: `m${i}`, message_id: `SIDERA-000020${i}` }, {}, () => {});
    for (let k = 0; k < 4; k++) t.flushTimers();
  }
  assert.strictEqual(t.site.newChats, 1, "raised threshold: no further rotation");
}

// READY as the answer to a real message is a failed reply (resend once);
// READY as the answer to the protocol paste itself is captured normally.
{
  const t = makeContext();
  t.ctx.__in({ type: "ASSIGN_HEMISPHERE", hemisphere: "RIGHT" }, {}, () => {});
  t.ctx.__in({ type: "INJECT_AND_SUBMIT", text: "[SIDERA GENESIS PROTOCOL] ... READY", message_id: "GENESIS-RIGHT" }, {}, () => {});
  t.flushTimers();
  t.site.latest = "READY";
  t.advance(3000);
  t.ctx.__sideraHeartbeat();
  assert.strictEqual(t.sent.filter((m) => m.type === "RESPONSE_CAPTURED").length, 1, "READY to the protocol is sent to the mediator");
  assert.strictEqual(t.site.submits, 1, "no resend for the protocol's READY");

  t.ctx.__in({ type: "INJECT_AND_SUBMIT", text: "Acknowledged. Boundary holds. Standing by.", message_id: "SIDERA-0000299" }, {}, () => {});
  t.flushTimers();
  t.site.latest = "READY.";
  t.advance(3000);
  t.ctx.__sideraHeartbeat();
  assert.strictEqual(t.sent.filter((m) => m.type === "RESPONSE_CAPTURED").length, 1, "READY to a real message is not captured yet");
  t.flushTimers();
  t.flushTimers();
  assert.strictEqual(t.site.submits, 3, "the real message is resent once");
  assert.strictEqual(t.site.composer, "Acknowledged. Boundary holds. Standing by.");
}

// SET_GENESIS can arrive after pairing.
{
  const t = makeContext();
  t.ctx.__in({ type: "ASSIGN_HEMISPHERE", hemisphere: "LEFT" }, {}, () => {});
  t.ctx.__in({ type: "SET_GENESIS", genesis: "protocol text" }, {}, () => {});
  assert.strictEqual(t.ctx.document.documentElement.dataset.sideraGenesis, "protocol text");
}

// A reply identical to the previous one is still captured (marked fresh) when
// it sits below the user message holding our paste; the same answer is never
// sent twice, and a stale re-capture above the paste is not fresh.
{
  const t = makeContext();
  // Fake DOM order: each node has a position; "following" means larger position.
  const FOLLOWING = 4;
  const node = (pos) => ({ pos, compareDocumentPosition(other) { return other.pos > pos ? FOLLOWING : 2; } });
  t.site.userNode = null;
  t.site.answerNode = node(1);
  t.site.getLatestAssistantMessage = function () { return this.latest ? { element: this.answerNode, text: this.latest } : null; };
  t.site.getLatestUserMessage = function () { return this.userNode ? { element: this.userNode, text: this.userText } : null; };

  t.ctx.__in({ type: "ASSIGN_HEMISPHERE", hemisphere: "RIGHT" }, {}, () => {});
  t.site.latest = "Acknowledged. GATE: OPEN.";
  t.advance(3000);
  t.ctx.__sideraHeartbeat();
  assert.strictEqual(t.sent.filter((m) => m.type === "RESPONSE_CAPTURED").length, 1);

  // Our paste lands below the old answer; the old answer is above it: not fresh.
  t.ctx.__in({ type: "INJECT_AND_SUBMIT", text: "Acknowledged. GATE: OPEN. Standing by.", message_id: "SIDERA-0000010" }, {}, () => {});
  t.flushTimers();
  t.site.userNode = node(2);
  t.site.userText = "You said Acknowledged. GATE: OPEN. Standing by.";
  t.advance(3000);
  t.ctx.__sideraHeartbeat();
  assert.strictEqual(t.sent.filter((m) => m.type === "RESPONSE_CAPTURED").length, 1, "old answer above the paste is not a reply to it");

  // A new answer below the paste with identical wording: fresh, captured once.
  t.site.answerNode = node(3);
  t.site.latest = "Acknowledged. GATE: OPEN.";
  t.advance(3000);
  t.ctx.__sideraHeartbeat();
  let captured = t.sent.filter((m) => m.type === "RESPONSE_CAPTURED");
  assert.strictEqual(captured.length, 2, "identical wording below the paste: captured");
  assert.strictEqual(captured[1].fresh, true);
  t.advance(3000);
  t.ctx.__sideraHeartbeat();
  assert.strictEqual(t.sent.filter((m) => m.type === "RESPONSE_CAPTURED").length, 2, "not captured a second time");

  // A different answer later is captured as usual, even without a new paste.
  t.site.answerNode = node(4);
  t.site.latest = "A different reply.";
  t.advance(3000);
  t.ctx.__sideraHeartbeat();
  assert.strictEqual(t.sent.filter((m) => m.type === "RESPONSE_CAPTURED").length, 3);
}

// If the composer still holds the text after a submit attempt, the script asks
// the background for a trusted Enter, and stops asking once the text is gone.
{
  const t = makeContext();
  const composer = { tagName: "DIV", innerText: "pasted text", focused: 0, focus() { this.focused += 1; } };
  t.ctx.SideraDom = { queryFirst: () => composer };
  t.site.selectors = { composerTextarea: [".fake-composer"] };
  t.ctx.__in({ type: "ASSIGN_HEMISPHERE", hemisphere: "RIGHT" }, {}, () => {});
  t.ctx.__in({ type: "INJECT_AND_SUBMIT", text: "pasted text", message_id: "SIDERA-0000020" }, {}, () => {});
  t.flushTimers(); // submit
  t.flushTimers(); // first check: text still there
  assert.strictEqual(t.sent.filter((m) => m.type === "TRUSTED_SUBMIT").length, 1);
  assert.strictEqual(composer.focused, 1, "composer focused before the key press");
  composer.innerText = "";
  t.flushTimers(); // re-check: submitted, no further request
  assert.strictEqual(t.sent.filter((m) => m.type === "TRUSTED_SUBMIT").length, 1);
  assert.strictEqual(t.sent.filter((m) => m.type === "SUBMISSION_CONFIRMED").length, 1);
}

// If the site keeps refusing, the script reports a stall with the site's notice.
{
  const t = makeContext();
  const composer = { tagName: "DIV", innerText: "pasted text", focus() {} };
  t.ctx.SideraDom = { queryFirst: () => composer };
  t.site.selectors = { composerTextarea: [".fake-composer"] };
  t.site.name = "Gemini";
  t.ctx.document.body = { innerText: "Ask away\nSomething went wrong (1095)\n" };
  t.ctx.__in({ type: "ASSIGN_HEMISPHERE", hemisphere: "RIGHT" }, {}, () => {});
  t.ctx.__in({ type: "INJECT_AND_SUBMIT", text: "pasted text", message_id: "SIDERA-0000021" }, {}, () => {});
  for (let i = 0; i < 6; i++) t.flushTimers();
  assert.strictEqual(t.sent.filter((m) => m.type === "TRUSTED_SUBMIT").length, 3, "three trusted attempts");
  const stalled = t.sent.filter((m) => m.type === "SUBMISSION_STALLED");
  assert.strictEqual(stalled.length, 1);
  assert.strictEqual(stalled[0].message_id, "SIDERA-0000021");
  assert.ok(/Gemini refused the message: .*Something went wrong \(1095\)/.test(stalled[0].detail), stalled[0].detail);
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

// A page with no adapter is refused and does not capture a reply.
{
  const t = makeContext();
  t.site.identifyTab = () => false;
  let response = null;
  t.ctx.__in({ type: "ASSIGN_HEMISPHERE", hemisphere: "LEFT" }, {}, (resp) => { response = resp; });
  assert.strictEqual(response.status, "rejected");
  assert.ok(/not a browser session/.test(response.error), response.error);
  t.site.latest = "This page should not count as a reply.";
  t.advance(3000);
  t.ctx.__sideraHeartbeat();
  assert.strictEqual(t.sent.filter((m) => m.type === "RESPONSE_CAPTURED").length, 0);
}

// Two tabs of the same site stay distinct: each document reports only its side.
{
  const left = makeContext();
  const right = makeContext();
  left.ctx.__in({ type: "ASSIGN_HEMISPHERE", hemisphere: "LEFT" }, {}, () => {});
  right.ctx.__in({ type: "ASSIGN_HEMISPHERE", hemisphere: "RIGHT" }, {}, () => {});
  left.site.latest = "left reply only";
  right.site.latest = "right reply only";
  left.advance(3000);
  right.advance(3000);
  left.ctx.__sideraHeartbeat();
  right.ctx.__sideraHeartbeat();
  const leftCaptured = left.sent.filter((m) => m.type === "RESPONSE_CAPTURED");
  const rightCaptured = right.sent.filter((m) => m.type === "RESPONSE_CAPTURED");
  assert.strictEqual(leftCaptured.length, 1);
  assert.strictEqual(rightCaptured.length, 1);
  assert.strictEqual(leftCaptured[0].source, "LEFT");
  assert.strictEqual(leftCaptured[0].content, "left reply only");
  assert.strictEqual(rightCaptured[0].source, "RIGHT");
  assert.strictEqual(rightCaptured[0].content, "right reply only");
  assert.ok(!left.sent.some((m) => m.content === "right reply only"));
  assert.ok(!right.sent.some((m) => m.content === "left reply only"));
}

console.log("content recovery ok");
