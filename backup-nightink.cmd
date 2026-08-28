@echo off
cd /d "%~dp0"
node backup-nightink.mjs %*
echo.
pause
