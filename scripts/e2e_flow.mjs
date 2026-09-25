/**
 * Live end-to-end flow: ChatGPT reply -> mediator -> Grok -> mediator -> ChatGPT.
 * Uses the real content scripts, the real mediator, and the signed-in Chrome windows.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(process.env.PUPPETEER_REQUIRE || import.meta.url);
const puppeteer = require("puppeteer-core");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const flowRoot = `/tmp/sidera-flow-${Date.now()}`;
const PROMPT = process.env.SIDERA_PROMPT || "Reply with only this sentence: The copy loop works.";
const TOKEN = (process.env.SIDERA_TOKEN || "the copy loop works").toLowerCase();
const TURN_GOAL = Number(process.env.SIDERA_MAX_TURNS || 2);
const DEADLINE_MS = Number(process.env.SIDERA_DEADLINE_MS || 180000);

function frame(message) {
  const body = Buffer.from(JSON.stringify(message));
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  return Buffer.concat([head, body]);
}

function attachReader(stream, onMessage) {
  let buffer = Buffer.alloc(0);
  stream.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0);
      if (buffer.length < 4 + length) return;
      const payload = buffer.subarray(4, 4 + length).toString("utf8");
      buffer = buffer.subarray(4 + length);
      onMessage(JSON.parse(payload));
    }
  });
}

async function bootPage(page, worldName) {
  const client = await page.createCDPSession();
  const { frameTree } = await client.send("Page.getFrameTree");
  const { executionContextId } = await client.send("Page.createIsolatedWorld", {
    frameId: frameTree.frame.id,
    worldName,
    grantUniveralAccess: true,
  });
  async function evaluate(expression) {
    const result = await client.send("Runtime.evaluate", {
      contextId: executionContextId,
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception && result.exceptionDetails.exception.description;
      throw new Error(detail || result.exceptionDetails.text || "page eval failed");
    }
    return result.result.value;
  }
  await evaluate(`globalThis.chrome = { runtime: {
    sendMessage(message, callback) {
      globalThis.__captured = globalThis.__captured || [];
      globalThis.__captured.push(message);
      if (typeof callback === "function") {
        globalThis.__callbacks = globalThis.__callbacks || {};
        (globalThis.__callbacks[message.type] = globalThis.__callbacks[message.type] || []).push(callback);
      }
    },
    onMessage: { addListener(fn) { globalThis.__sideraIn = fn; } }
  }};`);
  for (const name of ["dom_utils.js", "completion.js", "adapters/chatgpt.js", "adapters/gemini.js", "adapters/grok.js", "content.js"]) {
    await evaluate(readFileSync(path.join(root, "chrome-extension", name), "utf8"));
  }
  return {
    async assign(hemisphere, baseline = true) {
      return evaluate(`new Promise((resolve) => globalThis.__sideraIn({ type: "ASSIGN_HEMISPHERE", hemisphere: ${JSON.stringify(hemisphere)}, baseline: ${baseline}, genesis: ${JSON.stringify(genesisTextForTabs)}, settings: ${JSON.stringify(settingsForTabs)} }, {}, resolve))`);
    },
    async inject(text, messageId) {
      return evaluate(`new Promise((resolve) => globalThis.__sideraIn({ type: "INJECT_AND_SUBMIT", text: ${JSON.stringify(text)}, message_id: ${JSON.stringify(messageId)} }, {}, resolve))`);
    },
    async drain() {
      return evaluate(`(() => { const items = globalThis.__captured || []; globalThis.__captured = []; return items; })()`);
    },
    async note() {
      return evaluate(`(() => { if (globalThis.__sideraNote) globalThis.__sideraNote(); return true; })()`);
    },
    // Answer a chrome.runtime.sendMessage callback the content script is waiting on.
    async deliver(type, payload) {
      return evaluate(`(() => { const list = (globalThis.__callbacks && globalThis.__callbacks[${JSON.stringify(type)}]) || []; const taken = list.splice(0); taken.forEach((cb) => { try { cb(${JSON.stringify(payload)}); } catch (err) {} }); return taken.length; })()`);
    },
  };
}

async function sendChatGPT(page) {
  const typed = await page.evaluate((prompt) => {
    const candidates = [...document.querySelectorAll("#prompt-textarea, textarea#mobile-composer-prompt, textarea[aria-label='Chat with ChatGPT']")];
    const composer = candidates.find((el) => el.getBoundingClientRect().height > 0);
    if (!composer) return { ok: false, error: "composer missing", text: (document.body.innerText || "").slice(0, 180) };
    composer.focus();
    if (composer.tagName === "TEXTAREA") {
      const desc = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value");
      desc.set.call(composer, prompt);
      composer.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: prompt }));
    } else {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(composer);
      selection.removeAllRanges();
      selection.addRange(range);
      document.execCommand("insertText", false, prompt);
    }
    return { ok: true, composer: composer.id || composer.getAttribute("aria-label") };
  }, PROMPT);
  if (!typed.ok) return typed;
  await new Promise((resolve) => setTimeout(resolve, 400));
  try {
    const clicked = await page.evaluate(() => {
      const send = [...document.querySelectorAll("button")].find((button) => {
        const label = (button.getAttribute("aria-label") || "") + " " + (button.getAttribute("data-testid") || "");
        return /send (message|prompt)|send-button/i.test(label) && button.getBoundingClientRect().height > 0 && !button.disabled;
      });
      if (!send) return { ok: false };
      send.click();
      return { ok: true };
    });
    return { ok: true, via: clicked.ok ? "click" : "typed", composer: typed.composer };
  } catch (err) {
    return { ok: true, via: "navigation", composer: typed.composer };
  }
}

const host = spawn("python3", ["-u", path.join(root, "scripts/e2e_host.py")], {
  cwd: root,
  env: { ...process.env, SIDERA_FLOW_ROOT: flowRoot, SIDERA_MAX_TURNS: String(TURN_GOAL), PYTHONPATH: root },
  stdio: ["pipe", "pipe", "inherit"],
});
const incoming = [];
let genesisTextForTabs = "";
let settingsForTabs = {};
attachReader(host.stdout, (message) => {
  if (message.type === "GENESIS_TEXT") genesisTextForTabs = message.text || "";
  if (message.type === "SETTINGS") {
    const { type: _ignored, ...settings } = message;
    settingsForTabs = settings;
  }
  incoming.push(message);
});
function send(message) {
  host.stdin.write(frame(message));
}

const browser = await puppeteer.connect({ browserURL: "http://127.0.0.1:9333", defaultViewport: null });
// SIDERA_TABS=new opens dedicated tabs (and closes them at the end) so a check
// can run alongside another session in the same Chrome.
const ownTabs = (process.env.SIDERA_TABS || "").toLowerCase() === "new";
const pages = await browser.pages();
const chatgpt = ownTabs ? await browser.newPage() : pages.find((page) => page.url().includes("chatgpt.com"));
// SIDERA_RIGHT=grok runs ChatGPT <-> Grok; the default is Gemini.
const RIGHT_SITE = (process.env.SIDERA_RIGHT || "gemini").toLowerCase();
const RIGHT = RIGHT_SITE === "grok"
  ? { name: "Grok", host: "grok.com", url: "https://grok.com/", composer: ".tiptap.ProseMirror[contenteditable='true'], textarea[aria-label='Ask Grok anything']", send: "button[aria-label='Submit'], button[aria-label*='Send']" }
  : { name: "Gemini", host: "gemini.google.com", url: "https://gemini.google.com/app", composer: ".ql-editor[aria-label='Enter a prompt for Gemini']", send: "button[aria-label='Send message']" };
const gemini = ownTabs ? await browser.newPage() : pages.find((page) => page.url().includes(RIGHT.host));
if (!chatgpt || !gemini) throw new Error(`ChatGPT or ${RIGHT.name} tab is not open`);

await chatgpt.goto("https://chatgpt.com/", { waitUntil: "domcontentloaded", timeout: 60000 });
await gemini.goto(RIGHT.url, { waitUntil: "domcontentloaded", timeout: 60000 });
await new Promise((resolve) => setTimeout(resolve, 2500));

const left = await bootPage(chatgpt, "sidera-left-" + Date.now());
const right = await bootPage(gemini, "sidera-right-" + Date.now());
await left.assign("LEFT");
await right.assign("RIGHT");

const urls = { LEFT: chatgpt.url(), RIGHT: gemini.url() };
const bridges = { LEFT: left, RIGHT: right };
// A replaced script copy may still queue packets (a paste it scheduled
// before being replaced), so recent copies keep being drained for a while.
const retiredBridges = { LEFT: [], RIGHT: [] };
const RETIRED_KEEP = 4;

const GENESIS_PREFIX = "GENESIS-";
const genesisDelivered = [];

// Gemini only submits on trusted input; its newest input UI also stopped
// treating Enter as send, so click the Send button when text is pending.
async function pressGeminiEnterIfPending() {
  const box = await gemini.evaluate((sel) => {
    const el = document.querySelector(sel.composer);
    const text = el ? (el.tagName === "TEXTAREA" ? el.value : el.innerText) : "";
    if (!el || !(text || "").trim()) return null;
    const send = document.querySelector(sel.send);
    const editor = el.getBoundingClientRect();
    if (send && send.getBoundingClientRect().width) {
      const rect = send.getBoundingClientRect();
      return { send: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }, editor: { x: editor.x + 24, y: editor.y + 12 } };
    }
    return { send: null, editor: { x: editor.x + 24, y: editor.y + 12 } };
  }, RIGHT);
  if (!box) return;
  if (box.send) {
    await gemini.mouse.click(box.send.x, box.send.y);
  } else {
    await gemini.mouse.click(box.editor.x, box.editor.y);
    await gemini.keyboard.press("Enter");
  }
}

async function deliver(message) {
  const target = bridges[message.destination] || bridges.LEFT;
  await Promise.race([
    target.inject(message.text, message.message_id),
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ]);
  const shown = message.destination === "RIGHT" ? gemini : chatgpt;
  await shown.bringToFront();
  if (message.destination === "LEFT") {
    const pending = await chatgpt.evaluate(() => {
      const el = document.querySelector("#prompt-textarea");
      return !!(el && (el.innerText || "").trim());
    });
    if (pending) {
      await chatgpt.evaluate(() => {
        const send = [...document.querySelectorAll("button")].find((button) => /send message/i.test(button.getAttribute("aria-label") || "") && !button.disabled && button.getBoundingClientRect().height > 0);
        if (send) send.click();
      });
    }
  }
  if (message.destination === "RIGHT") {
    await pressGeminiEnterIfPending();
  }
}

async function drainRetired() {
  for (const side of ["LEFT", "RIGHT"]) {
    for (const old of retiredBridges[side]) {
      try {
        await routePackets(side, await withTimeout(old.drain(), 1500));
      } catch (err) {
        // A destroyed world simply has nothing left to give.
      }
    }
  }
}

// The content script asks its background for a trusted submit when a site
// ignores synthetic input; here the harness plays the background's part.
async function trustedSubmit(side, point) {
  const page = side === "RIGHT" ? gemini : chatgpt;
  try {
    if (point && Number.isFinite(point.x) && Number.isFinite(point.y)) {
      await page.mouse.click(point.x, point.y);
    } else {
      await page.keyboard.press("Enter");
    }
  } catch (err) {
    console.error(`trusted submit failed for ${side}: ${err.message}`);
  }
}

async function routePackets(side, packets) {
  for (const packet of packets) {
    if (packet.type === "TRUSTED_SUBMIT" || packet.type === "TRUSTED_ENTER") {
      await trustedSubmit(side, packet.point);
    } else {
      send(packet);
    }
  }
}

async function pumpBridges() {
  await routePackets("LEFT", await withTimeout(bridges.LEFT.drain(), 4000));
  await routePackets("RIGHT", await withTimeout(bridges.RIGHT.drain(), 4000));
  await drainRetired();
}

send({ type: "START", initial_hemisphere: "LEFT" });

// With the Genesis Protocol on, the mediator teaches both sides first and
// reports GENESIS_COMPLETE; only then does the opening prompt go in.
const genesisOn = (process.env.SIDERA_GENESIS || "on").toLowerCase() !== "off";
let genesisChatUrl = null;
if (genesisOn) {
  const handshakeDeadline = Date.now() + 240000;
  let complete = false;
  while (!complete && Date.now() < handshakeDeadline) {
    // ChatGPT sometimes reloads to the home page right after the first reply
    // in a new chat; remember the chat the protocol went into so we can return.
    if (/\/c\//.test(chatgpt.url())) genesisChatUrl = chatgpt.url();
    while (incoming.length) {
      const message = incoming.shift();
      if (message.type === "SUBMIT_MESSAGE" && message.message_id.startsWith(GENESIS_PREFIX)) {
        genesisDelivered.push(message.destination);
        console.error(`genesis -> ${message.destination}`);
        await deliver(message);
      } else if (message.type === "GENESIS_COMPLETE") {
        complete = true;
      }
    }
    try {
      await withTimeout(bridges.LEFT.note(), 4000);
      await withTimeout(bridges.RIGHT.note(), 4000);
      await pumpBridges();
    } catch (err) {
      console.error(`genesis pump skipped: ${err.message}`);
    }
    if (!complete) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!complete) throw new Error("Genesis handshake did not complete");
  console.error("genesis complete");
}

await chatgpt.bringToFront();
if (genesisChatUrl && !chatgpt.url().includes("/c/")) {
  console.error(`chatgpt left the protocol chat (${chatgpt.url()}); returning to ${genesisChatUrl}`);
  await chatgpt.goto(genesisChatUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  await new Promise((resolve) => setTimeout(resolve, 2500));
}
let sent = { ok: false };
for (let attempt = 0; attempt < 12 && !sent.ok; attempt++) {
  sent = await sendChatGPT(chatgpt);
  if (!sent.ok) await new Promise((resolve) => setTimeout(resolve, 2500));
}
if (!sent.ok) throw new Error(`ChatGPT send failed: ${sent.error} ${sent.text || ""}`);
async function rebind(which, page, baseline = true) {
  const bridge = await bootPage(page, `sidera-${which}-${Date.now()}`);
  await bridge.assign(which, baseline);
  retiredBridges[which].push(bridges[which]);
  while (retiredBridges[which].length > RETIRED_KEEP) retiredBridges[which].shift();
  bridges[which] = bridge;
  urls[which] = page.url();
  await page.evaluate(() => {
    document.body.dataset.sideraTick = String(Date.now());
  });
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("timed out")), ms)),
  ]);
}

const deadline = Date.now() + DEADLINE_MS;
const submits = [];
let error = null;
let lastLogged = 0;
let lastProgress = Date.now();
while (Date.now() < deadline && submits.length < TURN_GOAL && !error) {
  try {
    if (chatgpt.url() !== urls.LEFT) {
      await withTimeout(rebind("LEFT", chatgpt, !submits.some((message) => message.destination === "LEFT")), 8000);
    }
    if (gemini.url() !== urls.RIGHT) {
      await withTimeout(rebind("RIGHT", gemini, !submits.some((message) => message.destination === "RIGHT")), 8000);
    }
  } catch (err) {
    console.error(`rebind skipped: ${err.message}`);
  }
  try {
    await withTimeout(bridges.LEFT.note(), 4000);
    await withTimeout(bridges.RIGHT.note(), 4000);
    await pumpBridges();
  } catch (err) {
    try {
      await withTimeout(rebind("LEFT", chatgpt, !submits.some((message) => message.destination === "LEFT")), 8000);
      await withTimeout(rebind("RIGHT", gemini, !submits.some((message) => message.destination === "RIGHT")), 8000);
    } catch (rebindErr) {
      console.error(`rebind skipped: ${rebindErr.message}`);
    }
  }
  while (incoming.length) {
    const message = incoming.shift();
    if (message.type === "SUBMIT_MESSAGE") {
      if (!message.message_id.startsWith(GENESIS_PREFIX)) submits.push(message);
      try {
        await deliver(message);
      } catch (err) {
        // The watchdog re-binds and retries; one failed paste must not end the run.
        console.error(`deliver failed for ${message.message_id}: ${err.message}`);
      }
    }
    if (message.type === "CONTEXT_BRIEF") {
      const side = message.hemisphere;
      console.error(`context brief -> ${side} (${(message.text || "").length} chars)`);
      for (const bridge of [bridges[side], ...retiredBridges[side]]) {
        try {
          if (await withTimeout(bridge.deliver("CONTEXT_REQUEST", { text: message.text || "" }), 3000)) break;
        } catch (err) {
          // that copy is gone; try the next
        }
      }
    }
    if (message.type === "STATE_UPDATE" && message.state === "ERROR") {
      error = message.last_error || "mediator error";
      console.error(`mediator error: ${error}`);
    }
    if (message.type === "STATE_UPDATE" && message.state === "PAUSED" && /refused|did not accept/i.test(message.last_error || "")) {
      // A site is turning messages away (usage limit); no point waiting it out here.
      error = message.last_error;
      console.error(`mediator paused: ${error}`);
    }
  }
  if (submits.length !== lastLogged) {
    lastLogged = submits.length;
    lastProgress = Date.now();
    console.error(`forwarded ${submits.length}/${TURN_GOAL} ${submits.at(-1).destination} ${submits.at(-1).message_id}`);
  } else if (Date.now() - lastProgress > 20000) {
    console.error(`still waiting at ${submits.length}/${TURN_GOAL}, checking both chats again`);
    try {
      await withTimeout(rebind("LEFT", chatgpt, false), 8000);
      await withTimeout(rebind("RIGHT", gemini, false), 8000);
      await pressGeminiEnterIfPending();
    } catch (err) {
      console.error(`retry skipped: ${err.message}`);
    }
    lastProgress = Date.now();
  }
  await new Promise((resolve) => setTimeout(resolve, 300));
}

await new Promise((resolve) => setTimeout(resolve, 800));
for (const packet of [...(await bridges.LEFT.drain()), ...(await bridges.RIGHT.drain())]) send(packet);
await new Promise((resolve) => setTimeout(resolve, 500));

const seen = {
  chatgpt: await chatgpt.evaluate(() => (document.body.innerText || "").replace(/\s+/g, " ")),
  gemini: await gemini.evaluate(() => (document.body.innerText || "").replace(/\s+/g, " ")),
};
host.stdin.end();
await new Promise((resolve) => host.once("exit", resolve));
if (ownTabs) {
  await chatgpt.close().catch(() => {});
  await gemini.close().catch(() => {});
}
await browser.disconnect();

const report = {
  flowRoot,
  rightSite: RIGHT.name,
  genesisDelivered,
  sent,
  submits: submits.map((message) => ({
    destination: message.destination,
    message_id: message.message_id,
    text: message.text.slice(0, 800),
  })),
  chatgptHasToken: seen.chatgpt.toLowerCase().includes(TOKEN),
  geminiHasToken: seen.gemini.toLowerCase().includes(TOKEN),
  geminiReply: submits[1] ? submits[1].text : "",
  geminiReplyReachedChatGPT: submits[1]
    ? seen.chatgpt.includes(submits[1].text.replace(/\s+/g, " ").trim().slice(0, 40))
    : false,
  geminiReplyIsFinished: submits[1]
    ? !/^(worked for|working|thinking|ran \d+ searches|opened page)/i.test(submits[1].text.trim())
    : false,
  error,
};
console.log(JSON.stringify(report, null, 2));
const interim = /^(worked for|working|thinking|ran \d+ searches|opened page)/i;
const unfinished = submits.some((message) => interim.test(message.text.trim()));
if (error || submits.length < TURN_GOAL || unfinished || !report.chatgptHasToken || !report.geminiHasToken || !report.geminiReplyIsFinished) {
  process.exit(1);
}
