# Maintenance guide: when ChatGPT, Gemini or Grok change their pages

All site-specific knowledge lives in one file per site under
`chrome-extension/adapters/`: `chatgpt.js`, `gemini.js`, `grok.js`. The mediator
(`mediator/`) never looks at page structure, and `content.js` only talks to adapters
through the interface below, so a site change is fixed by editing one adapter file.

## The adapter interface

| method | purpose |
| --- | --- |
| `identifyTab()` | true when this adapter owns the current hostname |
| `getLatestAssistantMessage()` | `{ element, text }` of the newest assistant reply with text |
| `getLatestUserMessage()` | `{ element, text }` of the newest user message (used to tell a fresh reply from a re-render) |
| `isGenerating()` | true while the site shows its stop control |
| `waitForCompletedAssistantMessage(options)` | promise for the next stable reply (debounce + timeout) |
| `isComposerReady()` / `setComposerText(text)` / `submitComposer()` | composer handling |
| `stopGenerating()` | click the stop control (hang recovery) |
| `startNewChat()` | click the site's New chat control (long-session rotation; the mediator then supplies a catch-up brief from memory) |

Every method reads its selectors from the adapter's `selectors` table. Each entry is a
list tried in order, so add the new selector at the top and leave the old one below it.

## Finding the new selectors

1. Open the site in the browser Sidera launched, press F12, and use the element picker on:
   - the newest assistant reply (`assistantMessage`, `messageContent`)
   - the newest user message (`userMessage`)
   - the composer (`composerTextarea`)
   - the Send button (`sendButton`), the Stop button while a reply streams (`stopButton`)
   - the New chat link (`newChatControl`)
2. Prefer stable attributes: `data-testid`, `aria-label`, `data-message-author-role`,
   custom element names (`model-response`, `user-query`). Avoid generated class names.
3. In the DevTools console, confirm each selector: `document.querySelectorAll('…').length`.
4. Update the adapter and reload the extension (chrome://extensions → reload), or restart
   Sidera from its desktop icon.

## Symptoms and where to look

| symptom | check |
| --- | --- |
| Replies are never captured | `assistantMessage` / `messageContent`; the log shows no `RESPONSE_CAPTURED` |
| Partial replies are forwarded | `stopButton` no longer matches; `isGenerating()` returns false while streaming |
| Nothing is pasted / `INJECTION_ERROR` in the log | `composerTextarea`; the mediator goes to `ERROR` rather than typing blindly |
| Text sits in the composer, `SUBMISSION_STALLED` in the log | `sendButton` (the extension clicks it with a trusted event), or the site is refusing messages (usage limit) |
| Identical replies stall the loop | `userMessage` (freshness relies on document order between the user message and the reply) |
| New-chat rotation stops working | `newChatControl` |

## Completion rules

Site-neutral completion logic is in `chrome-extension/completion.js`
(`isInterimStatus`, `finishedAnswer`, `isErrorReply`). Add new status wordings (for
example a new "Thinking…" label or a new canned error) there, and add a line to
`tests/test_completion.js`.

## Diagnostics

- Content scripts log to the page console with the prefix `[Sidera LEFT]` / `[Sidera RIGHT]`.
- The mediator log (`data/logs/sidera_mediator.log`) records every packet type, state
  transition and error; `docs/data_schema.md` lists the entries.
- The Node harness `scripts/e2e_flow.mjs` drives a live two-tab exchange against a Chrome
  started with `--remote-debugging-port=9333` and is the quickest way to prove an adapter
  fix end to end (`SIDERA_MAX_TURNS=4 node scripts/e2e_flow.mjs`).

## Tests to run after a change

```bash
python3 -m unittest discover tests
node tests/test_completion.js
node tests/test_content_recovery.js
```
