@echo off
chcp 65001 >nul
rem Removes the ST-Background-Reply server plugin (a backup is kept in SillyTavern\backups).
node "%~dp0installer\install.mjs" --uninstall %*
pause
