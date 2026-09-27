const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../chrome-extension/session.js"), "utf8");
const context = { URL, globalThis: {} };
context.globalThis = context;
vm.runInNewContext(source, context);
const { isAuthUrl, isLoginLabel, isContinueLabel, needsLogin, nextLoginStep } = context.globalThis.SideraSession;

assert.equal(isAuthUrl("https://auth.openai.com/log-in"), true);
assert.equal(isAuthUrl("https://chatgpt.com/auth/login"), true);
assert.equal(isAuthUrl("https://chatgpt.com/c/abc"), false);
assert.equal(isAuthUrl("https://grok.com/"), false);
assert.equal(context.globalThis.SideraSession.isGrokAuthUrl("https://accounts.x.ai/sign-in"), true);
assert.equal(context.globalThis.SideraSession.isGrokAuthUrl("https://x.com/i/flow/login"), true);
assert.equal(context.globalThis.SideraSession.isGrokAuthUrl("https://grok.com/"), false);
assert.equal(context.globalThis.SideraSession.isServiceAuthUrl("grok", "https://accounts.x.ai/sign-in"), true);
assert.equal(context.globalThis.SideraSession.isServiceAuthUrl("chatgpt", "https://accounts.x.ai/sign-in"), false);
assert.equal(isAuthUrl("not a url"), false);

assert.equal(isLoginLabel("Log in"), true);
assert.equal(isLoginLabel("  Sign up "), true);
assert.equal(isLoginLabel("New chat"), false);

assert.equal(needsLogin({ authUrl: true, hasComposer: true, loginControlVisible: false }), true);
assert.equal(needsLogin({ authUrl: false, hasComposer: true, loginControlVisible: true }), true);
assert.equal(needsLogin({ authUrl: false, hasComposer: false, loginControlVisible: false }), true);
assert.equal(needsLogin({ authUrl: false, hasComposer: true, loginControlVisible: false }), false);

assert.equal(isContinueLabel("Continue"), true);
assert.equal(isContinueLabel("Continue with Google"), false);
assert.equal(nextLoginStep({ emailVisible: true, passwordVisible: false, emailFilled: false, passwordFilled: false }), "email");
assert.equal(nextLoginStep({ emailVisible: true, passwordVisible: false, emailFilled: true, passwordFilled: false }), "wait");
assert.equal(nextLoginStep({ emailVisible: false, passwordVisible: true, emailFilled: true, passwordFilled: false }), "password");
assert.equal(nextLoginStep({ emailVisible: false, passwordVisible: true, emailFilled: true, passwordFilled: true }), "wait");

console.log("session checks passed");
