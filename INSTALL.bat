@echo off
setlocal
cd /d "%~dp0"
echo Sidera Dual-Hemisphere Mediator setup
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup_prerequisites.ps1"
if errorlevel 1 (
  echo Setup failed.
  pause
  exit /b 1
)
echo Setup finished.
pause
exit /b 0
