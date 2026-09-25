@echo off
setlocal
cd /d "%~dp0"
echo.
echo  Sidera Mediator - uninstall
echo  ---------------------------
echo  Removes the program and its Chrome connection.
echo  Keeps C:\Sidera\data (memory, transcripts, logs) and config.toml.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall.ps1" %*
if errorlevel 1 (
  echo.
  echo  Uninstall did not finish. Read the message above.
  pause
  exit /b 1
)
echo.
pause
exit /b 0
