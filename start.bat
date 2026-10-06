@echo off
cd /d "%~dp0"
rem Windows ships a python.exe stub that only opens the Store, so "where python" is not
rem enough: the interpreter has to actually run.
python -c "import sys" >nul 2>nul
if %errorlevel%==0 (
  start /b python -m http.server 8477
) else (
  start /b npx --yes serve -l 8477 .
)
rem The server needs a moment to listen before the browser asks for the page.
timeout /t 2 /nobreak >nul
start "" http://localhost:8477
echo Aura is running at http://localhost:8477 - close this window to stop it.
pause >nul
