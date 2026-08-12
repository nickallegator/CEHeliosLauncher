@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo Node.js is required to run the AG Launcher Community showroom.
    echo Install Node.js 22 and try again.
    pause
    exit /b 1
)

if not exist "node_modules\electron\dist\electron.exe" (
    echo Launcher dependencies are missing.
    echo Run npm install in this directory, then try again.
    pause
    exit /b 1
)

node "scripts\run-community-showroom.js" %*
set "SHOWROOM_EXIT=%ERRORLEVEL%"
if not "%SHOWROOM_EXIT%"=="0" pause
exit /b %SHOWROOM_EXIT%
