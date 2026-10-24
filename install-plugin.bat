@echo off
chcp 65001 >nul
rem Installs / updates the ST-Background-Reply server plugin. Run it again after reinstalling SillyTavern.
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found in PATH. Start this from the same environment you use to run SillyTavern.
  pause
  exit /b 1
)
node "%~dp0installer\install.mjs" %*
pause
