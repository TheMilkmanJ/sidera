@echo off
setlocal
cd /d "%~dp0"
echo.
echo  Sidera Mediator - one-step install
echo  ----------------------------------
echo  This copies Sidera to C:\Sidera, connects it to your default browser,
echo  and offers a desktop icon. Nothing else to configure.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup_prerequisites.ps1" %*
if errorlevel 1 (
  echo.
  echo  Setup did not finish. Read the message above, then run INSTALL.bat again.
  pause
  exit /b 1
)
echo.
echo  Setup finished. Double-click the Sidera Mediator icon to start.
pause
exit /b 0
