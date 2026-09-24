/**
 * Browser-side measurement for the Sidera content adapters.
 * Uses the installed Chrome. Two passes:
 * 1. Real content.js on a fixture served at the live hostname.
 * 2. Selector inventory against the live chatgpt.com and grok.com documents.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const puppeteer = require("puppeteer-core");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ext = path.join(root, "chrome-extension");
const CHROME = process.env.CHROME_PATH || "/usr/bin/google-chrome-stable";

const files = ["dom_utils.js", "adapters/chatgpt.js", "adapters/grok.js", "content.js"].map((name) =>
  readFileSync(path.join(ext, name), "utf8")
);

function fixture(kind) {
  if (kind === "chatgpt") {
    return `<!doctype html><html><body>
      <article data-testid="conversation-turn-1" data-turn="user">
        <div data-message-author-role="user"><div class="whitespace-pre-wrap">user prompt</div></div>
      </article>
      <article data-testid="conversation-turn-2" data-turn="assistant">
        <div data-message-author-role="assistant" id="assistant"><div class="markdown prose" id="assistant-body">seed reply</div></div>
      </article>
      <button id="stop" data-testid="stop-button" aria-label="Stop generating">Stop</button>
      <div id="prompt-textarea" class="ProseMirror" contenteditable="true" role="textbox"></div>
      <button id="send" data-testid="send-button" aria-label="Send prompt">Send</button>
    </body></html>`;
  }
  return `<!doctype html><html><body>
    <div data-testid="user-message">user prompt</div>
    <div data-testid="assistant-message" id="assistant"><div class="markdown" id="assistant-body">seed reply</div></div>
    <button id="stop" aria-label="Stop">Stop</button>
    <div class="tiptap ProseMirror" id="composer" contenteditable="true" role="textbox"></div>
    <button id="send" aria-label="Submit">Submit</button>
  </body></html>`;
}

async function installScripts(page) {
  await page.evaluate(() => {
    window.__sideraMessages = [];
    window.__clicks = [];
    window.chrome = {
      runtime: {
        sendMessage(message) {
          window.__sideraMessages.push({ at: performance.now(), message });
        },
        onMessage: {
          addListener(fn) {
            window.__sideraListener = fn;
          },
        },
      },
    };
  });
  for (const source of files) {
    await page.evaluate(source);
  }
}

async function measureBehavior(browser, kind) {
  const page = await browser.newPage();
  const origin = kind === "chatgpt" ? "https://chatgpt.com/" : "https://grok.com/";
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    const url = request.url();
    if (url.startsWith(origin) || url === origin.slice(0, -1)) {
      request.respond({
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: fixture(kind),
      });
      return;
    }
    request.abort();
  });
  await page.goto(origin, { waitUntil: "domcontentloaded", timeout: 20000 });
  await installScripts(page);

  const result = await page.evaluate(async (site) => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const send = (message) =>
      new Promise((resolve) => {
        window.chrome.runtime.onMessage._dispatch = window.__sideraListener;
        window.__sideraListener(message, {}, resolve);
      });
    document.getElementById("send").addEventListener("click", () => {
      window.__clicks.push(performance.now());
    });

    const paired = await send({ type: "ASSIGN_HEMISPHERE", hemisphere: site === "chatgpt" ? "LEFT" : "RIGHT" });
    const before = window.__sideraMessages.length;
    document.getElementById("assistant-body").textContent = "still streaming";
    await sleep(3000);
    const duringStop = window.__sideraMessages.slice(before);

    const markedAt = performance.now();
    document.getElementById("stop").remove();
    document.getElementById("assistant-body").textContent = "final answer from " + site;
    let captured = null;
    for (let i = 0; i < 40; i += 1) {
      await sleep(100);
      captured = window.__sideraMessages.find((entry) => entry.message.type === "RESPONSE_CAPTURED");
      if (captured) break;
    }
    const delayMs = captured ? Math.round(captured.at - markedAt) : null;

    const userOnly = document.createElement("article");
    userOnly.setAttribute("data-turn", "user");
    userOnly.innerHTML = '<div data-message-author-role="user"><div class="whitespace-pre-wrap">do not capture me</div></div>';
    document.body.appendChild(userOnly);
    await sleep(3000);
    const capturedUser = window.__sideraMessages.some((entry) => (entry.message.content || "").includes("do not capture me"));

    const beforeInject = window.__sideraMessages.length;
    await send({ type: "INJECT_AND_SUBMIT", text: "mediator forward " + site, message_id: "SIDERA-0000001" });
    await sleep(400);
    const composer = site === "chatgpt"
      ? document.querySelector("#prompt-textarea")
      : document.querySelector(".tiptap.ProseMirror");
    const after = window.__sideraMessages.slice(beforeInject);
    return {
      paired,
      blockedWhileStopVisible: duringStop.length === 0,
      capturedText: captured ? captured.message.content : null,
      capturedSource: captured ? captured.message.source : null,
      debounceMs: delayMs,
      ignoredUserTurn: !capturedUser,
      composerText: composer ? (composer.innerText || composer.textContent || "").trim() : null,
      sendClicked: window.__clicks.length > 0,
      confirmation: after.map((entry) => entry.message.type),
    };
  }, kind);

  await page.close();
  return result;
}

async function inventory(page) {
  return page.evaluate(() => {
    function visible(el) {
      if (!el) return false;
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }
    function describe(el) {
      return {
        tag: el.tagName,
        id: el.id || "",
        testid: el.getAttribute("data-testid") || "",
        role: el.getAttribute("data-message-author-role") || el.getAttribute("role") || "",
        aria: el.getAttribute("aria-label") || "",
        placeholder: el.getAttribute("placeholder") || "",
        editable: el.getAttribute("contenteditable") || "",
        className: String(el.className || "").slice(0, 140),
        visible: visible(el),
      };
    }
    const groups = {
      assistant: [
        '[data-message-author-role="assistant"]',
        'article[data-turn="assistant"]',
        '[data-testid="assistant-message"]',
        '[data-testid="grok-response"]',
      ],
      composer: [
        "#prompt-textarea",
        ".tiptap.ProseMirror",
        "textarea",
        '[contenteditable="true"]',
      ],
      stop: [
        'button[data-testid="stop-button"]',
        'button[aria-label="Stop generating"]',
        'button[aria-label="Stop streaming"]',
        'button[aria-label="Stop"]',
        'button[aria-label*="Stop"]',
      ],
      send: [
        'button[data-testid="send-button"]',
        'button[aria-label="Send prompt"]',
        'button[aria-label="Submit"]',
        'button[aria-label*="Send"]',
      ],
    };
    const counts = {};
    for (const [name, selectors] of Object.entries(groups)) {
      counts[name] = selectors.map((sel) => {
        const nodes = [...document.querySelectorAll(sel)];
        return { sel, count: nodes.length, visible: nodes.filter(visible).length };
      });
    }
    return {
      url: location.href,
      title: document.title,
      bodyChars: (document.body?.innerText || "").length,
      counts,
      editors: [...document.querySelectorAll("textarea, [contenteditable='true']")].slice(0, 12).map(describe),
      buttons: [...document.querySelectorAll("button")].slice(0, 25).map(describe),
    };
  });
}

async function measureLive(browser, url) {
  const page = await browser.newPage();
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
  );
  let error = null;
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await new Promise((resolve) => setTimeout(resolve, 8000));
  } catch (err) {
    error = String(err && err.message ? err.message : err);
  }
  const snap = await inventory(page).catch((err) => ({ inventoryError: String(err) }));
  await page.close();
  return { url, error, snap };
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
});

try {
  const behavior = {
    chatgpt: await measureBehavior(browser, "chatgpt"),
    grok: await measureBehavior(browser, "grok"),
  };
  const live = {
    chatgpt: await measureLive(browser, "https://chatgpt.com/"),
    grok: await measureLive(browser, "https://grok.com/"),
  };
  console.log(JSON.stringify({ behavior, live }, null, 2));
} finally {
  await browser.close();
}
