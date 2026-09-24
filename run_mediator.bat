@echo off
setlocal
set PYTHONUNBUFFERED=1
set PYTHONIOENCODING=utf-8
cd /d "%~dp0"
where py >nul 2>&1 && (
  py -3 -u -m mediator.main
  exit /b %ERRORLEVEL%
)
python -u -m mediator.main
