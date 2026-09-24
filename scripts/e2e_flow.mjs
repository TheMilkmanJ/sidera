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
const PROMPT = "Reply with exactly the single word sideraflow and nothing else. Do not search or use tools.";

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
    sendMessage(message) {
      globalThis.__captured = globalThis.__captured || [];
      globalThis.__captured.push(message);
    },
    onMessage: { addListener(fn) { globalThis.__sideraIn = fn; } }
  }};`);
  for (const name of ["dom_utils.js", "completion.js", "adapters/chatgpt.js", "adapters/grok.js", "content.js"]) {
    await evaluate(readFileSync(path.join(root, "chrome-extension", name), "utf8"));
  }
  return {
    async assign(hemisphere) {
      return evaluate(`new Promise((resolve) => globalThis.__sideraIn({ type: "ASSIGN_HEMISPHERE", hemisphere: ${JSON.stringify(hemisphere)} }, {}, resolve))`);
    },
    async inject(text, messageId) {
      return evaluate(`new Promise((resolve) => globalThis.__sideraIn({ type: "INJECT_AND_SUBMIT", text: ${JSON.stringify(text)}, message_id: ${JSON.stringify(messageId)} }, {}, resolve))`);
    },
    async drain() {
      return evaluate(`(() => { const items = globalThis.__captured || []; globalThis.__captured = []; return items; })()`);
    },
    async check() {
      return evaluate(`(() => { if (globalThis.__sideraCheck) globalThis.__sideraCheck(); return true; })()`);
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
  env: { ...process.env, SIDERA_FLOW_ROOT: flowRoot, PYTHONPATH: root },
  stdio: ["pipe", "pipe", "inherit"],
});
const incoming = [];
attachReader(host.stdout, (message) => incoming.push(message));
function send(message) {
  host.stdin.write(frame(message));
}

const browser = await puppeteer.connect({ browserURL: "http://127.0.0.1:9333", defaultViewport: null });
const pages = await browser.pages();
const chatgpt = pages.find((page) => page.url().includes("chatgpt.com"));
const grok = pages.find((page) => page.url().includes("grok.com"));
if (!chatgpt || !grok) throw new Error("ChatGPT or Grok tab is not open");

send({ type: "START", initial_hemisphere: "LEFT" });
const left = await bootPage(chatgpt, "sidera-left-" + Date.now());
const right = await bootPage(grok, "sidera-right-" + Date.now());
await left.assign("LEFT");
await right.assign("RIGHT");

await chatgpt.bringToFront();
const sent = await sendChatGPT(chatgpt);
if (!sent.ok) throw new Error(`ChatGPT send failed: ${sent.error} ${sent.text || ""}`);

const urls = { LEFT: chatgpt.url(), RIGHT: grok.url() };
const bridges = { LEFT: left, RIGHT: right };
async function rebind(which, page) {
  const bridge = await bootPage(page, `sidera-${which}-${Date.now()}`);
  await bridge.assign(which);
  bridges[which] = bridge;
  urls[which] = page.url();
  await page.evaluate(() => {
    document.body.dataset.sideraTick = String(Date.now());
  });
}

const deadline = Date.now() + 180000;
const submits = [];
let error = null;
while (Date.now() < deadline && submits.length < 2) {
  if (chatgpt.url() !== urls.LEFT) await rebind("LEFT", chatgpt);
  if (grok.url() !== urls.RIGHT) await rebind("RIGHT", grok);
  let packets = [];
  try {
    packets = [...(await bridges.LEFT.drain()), ...(await bridges.RIGHT.drain())];
  } catch (err) {
    await rebind("LEFT", chatgpt);
    await rebind("RIGHT", grok);
  }
  for (const packet of packets) {
    send(packet);
  }
  while (incoming.length) {
    const message = incoming.shift();
    if (message.type === "SUBMIT_MESSAGE") {
      submits.push(message);
      const target = bridges[message.destination] || bridges.LEFT;
      await target.inject(message.text, message.message_id);
    }
    if (message.type === "STATE_UPDATE" && message.state === "ERROR") {
      error = message.last_error || "mediator error";
    }
  }
  if (error) break;
  await new Promise((resolve) => setTimeout(resolve, 300));
}

await new Promise((resolve) => setTimeout(resolve, 800));
for (const packet of [...(await bridges.LEFT.drain()), ...(await bridges.RIGHT.drain())]) send(packet);
await new Promise((resolve) => setTimeout(resolve, 500));

const seen = {
  chatgpt: await chatgpt.evaluate(() => (document.body.innerText || "").replace(/\s+/g, " ").slice(0, 1200)),
  grok: await grok.evaluate(() => (document.body.innerText || "").replace(/\s+/g, " ").slice(0, 1200)),
};
host.stdin.end();
await new Promise((resolve) => host.once("exit", resolve));
await browser.disconnect();

const report = {
  flowRoot,
  sent,
  submits: submits.map((message) => ({
    destination: message.destination,
    message_id: message.message_id,
    text: message.text.slice(0, 240),
  })),
  chatgptHasToken: seen.chatgpt.toLowerCase().includes("sideraflow"),
  grokHasToken: seen.grok.toLowerCase().includes("sideraflow"),
  grokReply: submits[1] ? submits[1].text : "",
  grokReplyReachedChatGPT: submits[1]
    ? seen.chatgpt.includes(submits[1].text.replace(/\s+/g, " ").trim().slice(0, 40))
    : false,
  grokReplyIsFinished: submits[1] ? !/^(worked for|working|thinking|ran \d+ searches)/i.test(submits[1].text.trim()) : false,
  error,
};
console.log(JSON.stringify(report, null, 2));
if (error || submits.length < 2 || !report.chatgptHasToken || !report.grokHasToken || !report.grokReplyIsFinished) {
  process.exit(1);
}
