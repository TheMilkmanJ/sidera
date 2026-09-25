# Sidera Dual-Hemisphere Mediator

Local turn-taking mediator between a ChatGPT tab (LEFT) and a Gemini tab (RIGHT). It uses the signed-in Chrome sessions you already have. There is no paid API and no localhost port. Chrome talks to the Python host through native messaging (stdin/stdout).

The state machine runs `WAIT_LEFT` → `PROCESS` → `SEND_RIGHT` → `WAIT_RIGHT` → `PROCESS` → `SEND_LEFT`, and stops itself after 50 autonomous turns so a burn-in has a fixed ceiling.

## Run the tests

```bash
python3 -m unittest discover tests
```

Python 3.10 or newer is required.

## Install on Windows 10/11

Download the folder, double-click `INSTALL.bat`, answer one question about a desktop icon. That is the whole install.

What the installer does:

1. Finds Python 3.10+ if it is already there (`py -3`, `python`, or `python3`) and leaves it alone; otherwise installs Python silently.
2. Copies the files to `C:\Sidera`.
3. Points `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.sidera.mediator` at `C:\Sidera\com.sidera.mediator.json`.
4. Adds **Sidera Mediator** to the Start menu, and to the desktop if you say yes (the default). Run `INSTALL.bat -DesktopIcon Yes` or `-DesktopIcon No` to skip the question.

Then double-click **Sidera Mediator**. It runs `wscript.exe //B launch_silent.vbs`, so there is no console window. Chrome opens ChatGPT and Gemini with the Sidera extension already loaded from `C:\Sidera\chrome-extension`; nothing needs to be loaded by hand. The manifest key pins the extension id to `pekgjaanmdkkpclhlobpcggibbkgjbgd`, which is the origin allowed by the native host.

In the extension popup: pair the ChatGPT tab as LEFT, the Gemini tab as RIGHT, and press Start. The mediator then runs the Genesis Protocol (below) with both AIs before waiting for your opening message in the ChatGPT tab.

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

Very long single chats are where ChatGPT and Gemini start hanging or answering with canned errors, so the extension protects the loop:

- A reply that shows no new text for 6 minutes while the site still says it is generating is stopped and the message is resent once.
- A canned error reply ("I encountered an error…", "Something went wrong…") is not forwarded; the message is resent once.
- If the same message fails twice, or after 50 pastes into one chat, the side opens a fresh chat, re-teaches the Genesis Protocol, and continues there.
- Only an exact repeat of a side's most recent reply is treated as a duplicate; a reply that genuinely repeats the previous one is still forwarded.
- Gemini only submits on trusted input, so the extension presses its Send button through Chrome's debugger API when a paste is still sitting in the composer (the launcher passes `--silent-debugger-extension-api`, so there is no infobar).
- If a site keeps refusing a message (for example Gemini's "Something went wrong (1095)" after a usage limit), the mediator pauses and shows the site's own notice in the popup and log. Press Resume once the site accepts messages again; the pending message is pasted again automatically.
