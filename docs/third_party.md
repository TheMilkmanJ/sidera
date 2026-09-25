# Third-party software and licences

## Runtime (what the client installs)

| component | licence | notes |
| --- | --- | --- |
| Python 3.11+ standard library | PSF License | `sqlite3`, `tomllib`, `hashlib`, `json`, `logging`; nothing installed with pip |
| Google Chrome | Google Chrome Terms of Service | already on the machine; the extension uses standard MV3 APIs (`tabs`, `storage`, `nativeMessaging`, `debugger`) |

The mediator and the extension have **no third-party runtime dependencies**. No paid
model APIs are used; the AIs are reached through the user's own signed-in browser tabs.

## Development and test tooling only (not installed for the client)

| component | licence | use |
| --- | --- | --- |
| Node.js | MIT | runs `tests/*.js` and the live harness `scripts/e2e_flow.mjs` |
| puppeteer-core | Apache-2.0 | live harness only, connects to a Chrome started with `--remote-debugging-port`; installed outside the repository |

## Sidera's own code

All code under `chrome-extension/`, `mediator/`, `scripts/`, `tests/`, the installer
scripts and the documentation was written for Sidera LLC and is delivered with rights to
modify, deploy and extend it.
