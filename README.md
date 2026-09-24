# Sidera Dual-Hemisphere Mediator

Local turn-taking mediator between a ChatGPT tab (LEFT) and a Gemini tab (RIGHT). It uses the signed-in Chrome sessions you already have. There is no paid API and no localhost port. Chrome talks to the Python host through native messaging (stdin/stdout).

The state machine runs `WAIT_LEFT` → `PROCESS` → `SEND_RIGHT` → `WAIT_RIGHT` → `PROCESS` → `SEND_LEFT`, and stops itself after 50 autonomous turns so a burn-in has a fixed ceiling.

## Run the tests

```bash
python3 -m unittest discover tests
```

Python 3.10 or newer is required.

## Install on Windows 10/11

1. Double-click `INSTALL.bat`.
2. If Python 3.10+ is already on PATH (`py -3`, `python`, or `python3`), the installer leaves it alone.
3. Files are copied to `C:\Sidera`.
4. `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.sidera.mediator` is set to `C:\Sidera\com.sidera.mediator.json`.
5. A desktop shortcut named **Sidera Mediator** is created. It launches `wscript.exe //B` against `launch_silent.vbs` with `sidera.ico`, so no console window appears. Chrome opens ChatGPT and Gemini.

Then in Chrome, load `C:\Sidera\chrome-extension` as an unpacked extension. The manifest key pins the extension id to `pekgjaanmdkkpclhlobpcggibbkgjbgd`, which is the origin allowed by the native host.

Pair the ChatGPT tab as LEFT and the Gemini tab as RIGHT, then start the exchange.

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
