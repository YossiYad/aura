@echo off
cd /d "%~dp0"
start "" http://localhost:8477
where python >nul 2>nul
if %errorlevel%==0 (
  python -m http.server 8477
) else (
  npx --yes serve -l 8477 .
)
