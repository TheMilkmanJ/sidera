# Sidera v1.1 technical rundown (Phase 1)

This describes extension version 1.1.0 (the version shown on the Sidera card
in `chrome://extensions`).

## What it is

Sidera is a local bridge between two AI chats in your browser: a LEFT side and
a RIGHT side. It waits until one side finishes its reply, pastes that reply
into the other side, and keeps alternating. Each side can be ChatGPT, Grok, or
Gemini — in any combination, including the same AI on both sides (for example
ChatGPT talking to ChatGPT in two separate tabs). The defaults match the spec:
ChatGPT as LEFT, Grok as RIGHT. Both AIs run in your own logged-in browser
tabs. There are no paid APIs and no cloud server. Everything runs and stays on
your PC.

One honest note for same-AI runs: two sides signed in to the same account
share that account's message limits, so a ChatGPT-vs-ChatGPT run uses up one
account's allowance twice as fast.

## The two parts

1. **A Chrome extension (Manifest V3).** Its popup is where you pick, for each
   side, the AI and the exact browser tab that holds it (so two tabs of the
   same site can be told apart — the picker shows each tab's window and chat
   title, numbers a site's tabs when more than one is open ("ChatGPT 1",
   "ChatGPT 2"), and suggests an unused tab; an "Open in a new window"
   button opens the chosen AI in a new window of its own). The AI you pick
   for each side is remembered as soon as you pick it. Then Start, Pause,
   Resume, Emergency STOP, and Manual forward in both directions. The popup
   shows live status in plain words ("Waiting for LEFT", "Sending to RIGHT",
   "Not running"), the turn count, the last message's log number, whether
   Sidera is pasting replies, and the last error — also in plain words,
   including when a paired tab is closed mid-run. A site adapter for each AI
   (`chatgpt.js`, `grok.js`, `gemini.js`) watches for when a reply is finished, reads it,
   types it into the other chat's box and submits it. Each side is bound to
   one specific tab, never to a site, so replies can only come from and go to
   the tabs you paired.

2. **A Python mediator (Python 3.11+)** that does the actual work. It starts
   silently with Sidera — no terminal window — and talks to the extension over
   Chrome **native messaging** (a direct pipe between the browser and the
   program; no network port at all, not even a local one). It isn't an AI.
   It's deterministic plumbing:
   - A turn state machine (IDLE, WAIT_LEFT/RIGHT, LEFT/RIGHT_COMPLETE,
     PROCESS, SEND_LEFT/RIGHT, PAUSED, ERROR). It fails closed: if anything
     looks off, it pauses instead of guessing. A max-turns limit (50 by
     default) pauses it automatically, and a restart after a crash comes back
     PAUSED, never mid-send.
   - An idle watchdog: if nothing is detected from a side for 20 minutes
     (configurable), the mediator pauses and says so in plain words, rather
     than waiting forever when a site changes its page layout. A reply that
     is still producing new text counts as progress, so a long answer is not
     mistaken for a stuck one, and the watchdog never fires on top of a pause
     you made yourself.
   - A SQLite message ledger. Every message gets an ID and a content hash so
     the same reply is never forwarded twice — per side, so this also holds
     when both sides are the same AI.
   - A control-tag parser. The AIs can write `[[SIDERA:...]]` tags in their
     replies: MEMORY_WRITE, MEMORY_READ, FILE_APPEND, FILE_WRITE, FILE_READ,
     FILE_LIST, PAUSE, STOP and STATUS. The old `[[MEMORY:X]]` style also
     works. Tags are stripped before the text is forwarded, and results come
     back in a clearly marked Sidera system block.
   - Memory stored as append-only JSONL, organized by category and project,
     with a Markdown copy you can read yourself.
   - A file sandbox. The AIs can only read or write files inside your Sidera
     data folder (`C:\Sidera\data\files`). Any path that tries to escape it is
     rejected.
   - Full transcripts and a log file for every run.

## Long sessions

Very long single chats are where these sites start hanging or answering with
canned errors, so Sidera protects the loop: a hung reply is stopped and
resent once; a canned error reply is never forwarded; after repeated failures
or 50 pastes into one chat, that side opens a fresh chat, is re-taught the
protocol, and is caught up from saved memory and the last few turns before it
continues. The live burn-ins so far (50, 100 and 215 turns) were ChatGPT vs
Gemini, because Grok's free-tier usage limits interrupt multi-hour sessions.
ChatGPT vs ChatGPT has so far been tested only as a simulated 50-turn run in
the automated tests, not live.

## Saved logins (optional, off by default)

Your spec (section 11.3) says Sidera should store no credentials when the
browser sessions already provide the login — and by default it stores none.
There is one **opt-in** convenience on top: in the popup you can save a
ChatGPT or Grok email and password once, and Sidera will type it into that
site's own sign-in form when the site logs you out mid-run. If you use it,
the login is stored only on your PC, encrypted by Windows for your user
account, and never written to logs or transcripts. If you never use it,
nothing is stored. "Forget login" removes a saved one. Codes and captchas
still need you; Sidera never tries to get around them.

## Installing

`INSTALL.bat` copies Sidera to `C:\Sidera`, installs Python if needed (and
finishes in one run — no reboot), and registers the native-messaging
connection for Chrome, Edge, Brave, Vivaldi, Opera and Chromium. On Google
Chrome there is one extra one-time step, because current Chrome no longer
lets a program load an extension automatically: open `chrome://extensions`,
turn on Developer mode, click Load unpacked, and select
`C:\Sidera\chrome-extension`. It takes about a minute and the extension stays
in Chrome afterwards. When the installer finishes it opens the step-by-step
guide (`C:\Sidera\docs\INSTALL.html`) in your web browser. Steps 1, 2 and 6 of
the Chrome stage have real Chrome screenshots. The other steps are clearly
marked "screenshot pending" and give the exact buttons and the exact folder in
text, until real Windows captures are taken. Edge and the other supported
browsers load the extension automatically. The launcher opens each AI in its own window, so
neither side is a hidden background tab that Chrome would slow down.

## Testing so far (honest)

91 automated Python tests plus five Node check suites, all passing. They cover the
tag parser, the file sandbox, ledger deduplication, the state machine,
crash/restart recovery, memory write-once/read-back, logging of a full
50-turn and a 2000-turn simulated run, the new simulated 50-turn ChatGPT vs
ChatGPT run with duplicate-defense checks, the idle watchdog (including
pauses during the opening handshake and long streaming replies), Resume after
an error, reply
completion detection, error-reply recovery, side selection, and the
extension's tab routing — including that a reply can only be accepted from
the exact tab paired to a side, so a third leftover ChatGPT tab can't leak
into the exchange.

What automated tests cannot cover: the live look of chatgpt.com, grok.com and
gemini.google.com on your machine. Those sites change their layout often, so
the element selectors may need a maintenance pass (see
`docs/maintenance_selectors.md`).

To be plain about section 12 of your spec (the acceptance tests): so far they
have passed only in code and simulation. They have not been run live yet on
your Windows PC with Google Chrome. That live run is still to come: a manual
forward each way, a short loop, the 50-turn test, closing and re-pairing a tab
mid-run, and the rest of the section 12 list. Per that section, Phase 1 counts
as done only when those pass on your Windows PC.

## Easiest places to expand in v2 and later

- **More AIs.** Adapters are modular: a Claude or Perplexity tab is a new
  adapter file, not a rewrite. (Gemini is already in.) With some state-machine
  changes it could run three or more AIs in round-robin or moderator mode.
- **A moderator AI** that reads both sides and steers or summarizes. Left out
  of Phase 1 on purpose.
- **Smarter memory:** search (semantic or vector), auto-summaries per project,
  and a memory browser.
- **New tags** such as TASK/TODO, SUMMARIZE, EXPORT or a checkpoint, all
  within the same safety rules.
- **A dashboard:** a live side-by-side transcript, search across past runs,
  and export to Markdown or PDF.
- **Scheduling and topic presets:** start a debate or brainstorm on a set
  topic automatically.
- **API mode** as an option later, if you ever want to run without browser
  tabs.
