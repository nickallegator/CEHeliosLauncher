@echo off
setlocal EnableExtensions

cd /d "%~dp0"
if errorlevel 1 goto :fail_directory

set "COBBLEPOWER_RELEASE_API=https://cobblepower-access-api.onrender.com"
if not "%~1"=="" set "COBBLEPOWER_RELEASE_API=%~1"

echo.
echo ============================================================
echo  Cobble Power Test Launcher - Verified Windows Release Build
echo ============================================================
echo  API: %COBBLEPOWER_RELEASE_API%
echo.

where node.exe >nul 2>nul
if errorlevel 1 goto :missing_node
where npm.cmd >nul 2>nul
if errorlevel 1 goto :missing_npm
where git.exe >nul 2>nul
if errorlevel 1 goto :missing_git

if not exist "package.json" goto :missing_project

if not exist "node_modules\electron-builder\out\cli\cli.js" (
    echo [1/4] Preparing pinned dependencies...
    node scripts\bootstrap-dependencies.js
    if errorlevel 1 goto :failed
    node scripts\build-file-dependencies.js
    if errorlevel 1 goto :failed
    call npm.cmd ci
    if errorlevel 1 goto :failed
) else (
    echo [1/4] Build dependencies are already installed.
)

echo [2/4] Running launcher smoke tests...
call npm.cmd run test:smoke
if errorlevel 1 goto :failed

echo [3/4] Building the authenticated Cobble Power channel installer...
call npm.cmd run dist:channel -- --api-url "%COBBLEPOWER_RELEASE_API%"
if errorlevel 1 goto :failed

set "COBBLEPOWER_INSTALLER="
for %%F in ("dist\channel-output\Cobble-Power-Test-Channel-setup-*.exe") do set "COBBLEPOWER_INSTALLER=%%~fF"
if not defined COBBLEPOWER_INSTALLER goto :missing_installer
if not exist "%COBBLEPOWER_INSTALLER%" goto :missing_installer

echo [4/4] Release content verified successfully.
echo.
echo Installer:
echo %COBBLEPOWER_INSTALLER%
echo.
echo Launch this installer as Cobble Power Test Launcher. The generic
echo Helios Launcher installer does not include the authenticated channel.
echo.
exit /b 0

:missing_node
echo ERROR: Node.js 22 is not available on PATH.
goto :failed

:missing_npm
echo ERROR: npm.cmd is not available on PATH.
goto :failed

:missing_git
echo ERROR: Git is not available on PATH.
goto :failed

:missing_project
echo ERROR: package.json was not found beside this batch file.
goto :failed

:missing_installer
echo ERROR: The channel build completed without producing an installer.
goto :failed

:fail_directory
echo ERROR: Unable to enter the launcher repository directory.

:failed
echo.
echo RELEASE BUILD FAILED. Review the error above; no installer should be distributed.
exit /b 1
