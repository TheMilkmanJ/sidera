# Disabling or uninstalling Sidera without losing memory

## Stop it right now

- Extension popup → **Emergency STOP**. Nothing more is pasted; state and transcript stay on disk.
- Or close the browser window Sidera opened. The mediator exits with it and starts
  `PAUSED` next time, showing why.

## Disable autonomous pasting but keep watching and logging

Edit `C:\Sidera\config.toml`:

```toml
[mediator]
autonomous_submissions = false
```

Restart Sidera. Replies are still captured, tags still execute, everything is logged,
and the popup shows **Monitor only (no pasting)**. Set it back to `true` to resume normal
operation.

## Uninstall

Double-click `UNINSTALL.bat` (or run `powershell -File uninstall.ps1`). It removes:

- the program files under `C:\Sidera`
- the native-messaging registration for Chrome, Edge, Brave, Vivaldi, Opera, and Chromium (`HKCU\...\NativeMessagingHosts\com.sidera.mediator`)
- the Start menu and desktop shortcuts

It never removes `C:\Sidera\data` (ledger, transcripts, logs, memory, files) or
`config.toml`. Then, in the browser Sidera opened, open its extensions page and remove *Sidera
Dual-Hemisphere Mediator* if it is still listed.

## Reinstall later

Run `INSTALL.bat` again. The installer copies program files only; it skips `data\` and
keeps an existing `config.toml`, so the previous memory and transcripts are picked up
unchanged.
