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

In the extension popup: pair the ChatGPT tab as LEFT, the Gemini tab as RIGHT, and press Start.

## Burn-in records

While the host runs, a session writes:

- `data/logs/sidera_mediator.log` — state transitions (`STATUS turn=N/50`), acknowledgements, tag errors, injection errors, and `BURN_IN_LIMIT_REACHED` when the 50-turn ceiling stops the next send.
- `data/transcripts/<YYYY-MM-DD>-main.md` — each `SIDERA-XXXXXXX` turn, the status transitions around it, and error signals.

On Windows those paths live under `C:\Sidera\data\`. File tags (`FILE_READ`, `FILE_APPEND`) stay inside `data/files`.

## Control tags

Models can embed blocks the host strips before forwarding:

```text
[[SIDERA: MEMORY_WRITE category="inventions" project="gyrocell"]]
note text
[[/SIDERA]]
[[SIDERA: PAUSE reason="Awaiting verification"]]
[[SIDERA: STOP]]
```
