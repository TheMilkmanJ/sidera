# Sidera Dual-Hemisphere Mediator

Local turn-taking mediator between two AI chat tabs, a LEFT side and a RIGHT side, built to the Sidera Phase 1 build specification. It uses the signed-in sessions in your default browser. There is no paid API and no localhost port. The browser talks to the Python host through native messaging (stdin/stdout).

Each side can be ChatGPT, Grok, or Gemini — in any combination, including the same AI on both sides (for example ChatGPT vs ChatGPT in two separate tabs). Each side is bound to one specific tab, so same-site pairs route correctly and a reply never bounces back to the tab that wrote it. The defaults match the Phase 1 specification: LEFT is ChatGPT and RIGHT is Grok. The long burn-ins (50, 100 and 215 turns) were run against Gemini because Grok's free-tier usage limits interrupt multi-hour sessions.

The state machine runs `WAIT_LEFT` → `PROCESS` → `SEND_RIGHT` → `WAIT_RIGHT` → `PROCESS` → `SEND_LEFT`, and pauses itself after the configured number of autonomous turns (50 by default) so a burn-in has a fixed ceiling.

Documentation: [tag protocol](docs/tag_protocol.md), [data schema](docs/data_schema.md), [adapter maintenance](docs/maintenance_selectors.md), [disable and uninstall](docs/uninstall_and_disable.md), [third-party software](docs/third_party.md).

## Run the tests

```bash
python3 -m unittest discover tests
node tests/test_completion.js
node tests/test_content_recovery.js
node tests/test_session.js
node tests/test_sites.js
node tests/test_background_routing.js
```

Python 3.11 or newer is required (`config.toml` is read with the standard library's `tomllib`). The installer installs Python 3.12 if no 3.11+ is present.

## Configuration

`config.toml` sits next to the program files (`C:\Sidera\config.toml`; the installer creates it from `config.example.toml` and never overwrites it). Every key is optional:

| key | default | meaning |
| --- | --- | --- |
| `mediator.data_root` | `data` | where the ledger, transcripts, logs, memory and file sandbox live |
| `mediator.max_autonomous_turns` | `50` | pause after this many autonomous turns (also adjustable in the popup) |
| `mediator.autonomous_submissions` | `true` | `false` = monitor and log only, never paste |
| `mediator.rotate_after_pastes` | `50` | move a side to a fresh, caught-up chat after this many pastes into one chat |
| `mediator.idle_timeout_minutes` | `20` | pause with a plain explanation when nothing is detected from a side for this long (`0` disables) |
| `genesis.enabled` | `true` | teach both AIs the tag protocol when Start is pressed |
| `genesis.prompt_file` | `mediator/genesis_protocol.md` | the protocol text |
| `logging.level` | `INFO` | log verbosity |

No personal paths or credentials are stored anywhere; the browser sessions provide authentication.

## Install on Windows 10/11

Download the folder, double-click `INSTALL.bat`, answer one question about a desktop icon. That is the whole install.

What the installer does:

1. Finds Python 3.11+ if it is already there (`py -3`, `python`, or `python3`) and leaves it alone; otherwise installs Python 3.12 silently.
2. Copies the files to `C:\Sidera`.
3. Registers `com.sidera.mediator.json` as a native-messaging host for Chrome, Edge, Brave, Vivaldi, Opera, and Chromium (stable and the Chrome/Edge preview channels).
4. Adds **Sidera Mediator** to the Start menu, and to the desktop if you say yes (the default). Run `INSTALL.bat -DesktopIcon Yes` or `-DesktopIcon No` to skip the question.

Then double-click **Sidera Mediator**. It runs `wscript.exe //B launch_silent.vbs`, so there is no console window. The launcher reads the Windows default browser for `https` and opens ChatGPT and Grok there, each in its own window. The browser matters for how the extension gets loaded:

- **Google Chrome (the normal, current version):** the extension must be loaded by hand once. Chrome 137 (May 2025) removed the `--load-extension` command-line switch from regular Chrome, so no program can load it for you, and a policy-based automatic install of a non-Web-Store extension only works on company (domain-managed) PCs, not on a home PC. The one-time step is free and takes about a minute: open `chrome://extensions`, turn on Developer mode, click **Load unpacked**, and select `C:\Sidera\chrome-extension`. The extension then stays in Chrome permanently. **[docs/INSTALL.md](docs/INSTALL.md) walks through it with a screenshot for every step.**
- **Edge, Brave, Vivaldi, Opera, Chromium:** these still honor `--load-extension`, so the launcher loads the extension automatically — no manual step.
- **Firefox** cannot load this extension. If the default browser is unsupported and a supported browser is installed, Sidera tells you and opens that one instead.

The manifest key pins the extension id to `pekgjaanmdkkpclhlobpcggibbkgjbgd` — also when loaded unpacked — which is the origin allowed by the native host.

In the extension popup: for each side pick the AI (ChatGPT, Grok, or Gemini) and the open tab that should hold that side, pair LEFT and RIGHT, and press Start. The defaults are LEFT ChatGPT and RIGHT Grok. To run the same AI against itself, open two tabs of that site and assign one tab to each side; the tab picker lists every matching open tab, and the same tab can never hold both sides. If ChatGPT or Grok is already signed in, Sidera goes straight on. If either is signed out, Sidera opens that site's own login page. In the popup, under Saved logins, choose ChatGPT or Grok. Save login stores the email and password once. Change password replaces a saved password. Forget login removes it. Each login is stored under `C:\Sidera\data\credentials`, encrypted with Windows for that user account, and reused the next time that site is signed out. Passwords are not written to the transcript or the log. If a site asks for an email code or a captcha, finish that in the browser; Sidera continues as soon as the chat box is back. The Genesis Protocol (below) runs after sign-in, then Sidera waits for your opening message in the LEFT tab.

## Operator controls (extension popup)

- **Pair LEFT / Pair RIGHT**: pick the AI and the tab for each side, then pair. Any site can sit on either side, including the same site twice (one tab per side; two sides on the same account share that account's message limits). **Open another tab** opens a fresh tab of the chosen site in its own window — handy for same-AI runs. Closing a paired tab unpairs that side immediately (and pauses a running exchange with a plain reason). **Start Exchange** (refused with a clear message until both sides are paired), **Pause** (after the current turn) / **Resume**, **Emergency STOP** (nothing more is pasted; state stays on disk).
- **Manual forward** LEFT → RIGHT or RIGHT → LEFT: copies the newest completed reply once, through the same ledger and tag processing.
- **Maximum autonomous turns**: change the ceiling while running; the value is remembered across restarts.
- **Open data folder / Open latest log**.
- Status: state, turn `N / max`, last message ID, mediator connection, mode (autonomous or monitor only) and the last error or pause reason in the site's own words.

## Genesis Protocol

When you press Start, the mediator pastes `mediator/genesis_protocol.md` into the LEFT tab, waits for the AI to answer `READY`, does the same in the RIGHT tab, and only then enters the normal loop. The protocol tells each AI that it is one hemisphere of a two-AI conversation and teaches it the Sidera tags for saving memories and files. `READY` replies are acknowledgements: they are logged in the transcript but never forwarded or counted as turns.

If a side has to start a fresh chat mid-session (see "Long sessions"), the extension pastes the protocol into the new chat first, waits for `READY`, then continues with the pending message.

The prompt is plain text; edit `mediator/genesis_protocol.md` to change the wording. Every tag example in it is checked by the tests against the real parser. Set the environment variable `SIDERA_GENESIS=off` to skip the handshake (used by the pure copy-paste checks).

## What a session saves

Everything lives under `data/` (on Windows, `C:\Sidera\data\`):

- `data/transcripts/<YYYY-MM-DD>-main.md` — every `SIDERA-XXXXXXX` turn with source, destination, SHA-256, turn number, executed tags and the full text; Genesis handshake lines; status transitions and error signals.
- `data/logs/sidera_mediator.log` — state transitions (`STATUS turn=N/50`), acknowledgements, tag errors, injection errors, Genesis events, and `BURN_IN_LIMIT_REACHED` when the 50-turn ceiling stops the next send.
- `data/ledger.sqlite` — the message ledger (ids, hashes, statuses, turns).
- `data/memory/<category>.jsonl` and `data/memory/<category>.md` — one entry (`MEM-000001`, …) per `MEMORY_WRITE`, with project, source and the message it came from. The `.md` file is a readable mirror of the `.jsonl`.
- `data/files/…` — the restricted Sidera folder the AIs read and write with `FILE_WRITE`, `FILE_APPEND`, `FILE_READ` and `FILE_LIST`. Paths are confined to this folder (no `..`, no absolute or UNC paths); only `.md .txt .json .jsonl .csv` are allowed.

## Control tags

An AI embeds tags in a reply; the host executes them and strips them before forwarding, so the other AI never sees them:

```text
[[MEMORY:inventions]]
note text
[[/MEMORY]]

[[SIDERA: MEMORY_WRITE category="inventions" project="gyrocell"]]
note text
[[/SIDERA]]

[[SIDERA: MEMORY_READ category="inventions" project="gyrocell" limit="5"]]
optional search words
[[/SIDERA]]

[[SIDERA: FILE_APPEND path="notes/gyrocell.md"]]
text to append
[[/SIDERA]]

[[SIDERA: FILE_WRITE path="notes/summary.md"]]
whole file content (creates or replaces)
[[/SIDERA]]

[[SIDERA: FILE_READ path="notes/gyrocell.md"]]
[[/SIDERA]]

[[SIDERA: FILE_LIST]]

[[SIDERA: STATUS]]
[[SIDERA: PAUSE reason="Awaiting verification"]]
[[SIDERA: STOP]]
[[SIDERA: READY]]
```

`[[MEMORY:category]]` is the short memory tag from the brief; it saves to the given category under project `default`. `MEMORY_READ`, `FILE_READ` and `FILE_LIST` results are attached to the forwarded reply. The short spellings `SAVE` (a memory, or a file when `path=` is given), `RECALL`, `READ`, `WRITE`, `LIST`, `REMEMBER` and `APPEND` are accepted as aliases.

## Long sessions

Very long single chats are where ChatGPT, Grok and Gemini start hanging or answering with canned errors, so the extension protects the loop:

- A reply that shows no new text for 6 minutes while the site still says it is generating is stopped and the message is resent once.
- A canned error reply ("I encountered an error…", "Something went wrong…") is not forwarded; the message is resent once.
- If the same message fails twice, or after `rotate_after_pastes` pastes into one chat (50 by default), the side opens a fresh chat, is re-taught the Genesis Protocol, and is caught up with a Sidera system block holding the newest saved memories and the last few turns before the pending message is pasted. The new session continues the conversation instead of starting cold; the transcript records each catch-up.
- Only an exact repeat of a side's most recent reply is treated as a duplicate; a reply that genuinely repeats the previous one is still forwarded.
- Some sites (Gemini) only submit on trusted input, so if a paste is still sitting in the composer after the normal submit, the extension presses the site's Send button through the browser's debugger API (the launcher passes `--silent-debugger-extension-api`, so there is no infobar).
- If a site keeps refusing a message (Grok's free-tier usage limit, Gemini's "Something went wrong (1095)"), the mediator pauses and shows the site's own notice in the popup and log. Press Resume once the site accepts messages again; the pending message is pasted again automatically.
- If nothing at all is detected from a side for `idle_timeout_minutes` (20 by default — for example after a site changes its page layout and the reply detector goes blind), the mediator pauses with a plain explanation instead of waiting forever. Nothing is clicked or retried blindly; press Resume after checking the tab.

## Specification acceptance criteria (section 12)

| test | how it is met | where verified |
| --- | --- | --- |
| Tab pairing | popup pairs a chosen tab as LEFT or RIGHT; each side picks its site (ChatGPT, Grok, or Gemini), same site on both sides allowed; messages route by tab id | `tests/test_background_routing.js`, `tests/test_sites.js`, live |
| Response detection | stop-control state plus 2.5 s of stable text; interim status lines and canned errors are never forwarded | `tests/test_completion.js`, live |
| One-way transfer | `SUBMIT_MESSAGE` → adapter paste → trusted Send click when needed → `SUBMISSION_CONFIRMED` | live |
| Autonomous loop ≥ 50 turns | runs of 50, 100 and 215 alternating turns completed; long-session recoveries in place | live burn-ins |
| Duplicate defence | SHA-256 + latest-reply guard; a re-rendered answer is dropped, a genuinely repeated reply is forwarded once | `tests/test_message_ledger.py`, `tests/test_content_recovery.js` |
| Pause/stop survive restart | `runtime_state` table; restart restores PAUSED, or pauses if the last session ended mid-exchange | `tests/test_spec_compliance.py` |
| Memory write exactly once | JSONL + Markdown record; operations recorded per message and never repeated | `tests/test_spec_compliance.py`, `tests/test_memory_store.py` |
| Memory read | bounded results returned to the requesting hemisphere in a Sidera system block | `tests/test_spec_compliance.py` |
| File I/O | create/append/read/list under `data/files`; traversal, absolute and UNC paths, other extensions rejected | `tests/test_file_sandbox.py`, `tests/test_genesis_protocol.py` |
| Persistence | ledger/memory intact after restart, nothing replayed | `tests/test_spec_compliance.py` |
| Logging | every message, tag operation, transition and error in `sidera_mediator.log` and the transcript | `tests/test_burn_in_logging.py` |
| Website failure | missing composer → `INJECTION_ERROR` → safe stop with a plain error; refused paste → PAUSED with the site's notice; silent detection failure → PAUSED by the idle timeout | `tests/test_genesis_protocol.py`, `tests/test_idle_timeout.py` |
