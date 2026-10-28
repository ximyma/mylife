@echo off
setlocal enabledelayedexpansion
title MyLife DEV TEST - run from source
cd /d "%~dp0"

echo.
echo  ==========================================================
echo    The Story of My Life  -  DEV TEST (run from source)
echo    No exe / no apk build. Press Ctrl+C here to stop.
echo  ==========================================================
echo.

set "NODE_EXE="
for /f "delims=" %%N in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%N"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2-6\node.exe" set "NODE_EXE=%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"
if not defined NODE_EXE goto :nonode

set "NODE_VER="
set "NODE_MAJOR="
for /f "delims=" %%V in ('"%NODE_EXE%" -v') do set "NODE_VER=%%V"
if defined NODE_VER for /f "tokens=1 delims=." %%A in ("!NODE_VER:~1!") do set "NODE_MAJOR=%%A"
echo  Node.js : !NODE_VER!   [!NODE_EXE!]
if not defined NODE_MAJOR goto :datadir
if !NODE_MAJOR! LSS 22 echo  [WARN] Node 22.5 or newer is required. If it crashes, upgrade Node first.

:datadir
rem Keep using the SAME data folder as the packaged exe: dist\data
rem Override with: set MYLIFE_DATA=<folder> before running this file
set "DATA_DIR="
if defined MYLIFE_DATA set "DATA_DIR=%MYLIFE_DATA%"
if not defined DATA_DIR if exist "%CD%\dist\data\auth.db" set "DATA_DIR=%CD%\dist\data"
if not defined DATA_DIR set "DATA_DIR=%CD%\data"
if not exist "%DATA_DIR%\auth.db" goto :nodata

:portscan
set "BASE=4321"
set "OFF=0"
:findport
set /a "P=BASE+OFF"
set "BUSY="
for /f "delims=" %%L in ('netstat -ano ^| findstr /r /c:":!P! .*LISTENING"') do set "BUSY=1"
if not defined BUSY goto :gotport
set /a "OFF+=1"
if !OFF! LSS 12 goto :findport
echo.
echo  [ERROR] Ports 4321-4332 are all in use. Close something and run again.
echo.
pause
exit /b 1

:gotport
if "!OFF!"=="0" goto :backup
echo  [WARN] Port 4321 is busy - another instance (maybe the exe) is running.
echo         If it uses the same data folder, close it first to avoid db locks.
echo         This test will listen on !P! instead.
echo.

:backup
if not "!OFF!"=="0" goto :info
powershell -NoProfile -Command "$d=Get-Date -Format 'yyyyMMdd-HHmmss'; $bk=Join-Path 'data\backup' $d; New-Item -ItemType Directory -Force -Path $bk | Out-Null; Copy-Item '%DATA_DIR%\auth.db' $bk -Force -ErrorAction SilentlyContinue; $us=Join-Path '%DATA_DIR%' 'users'; if (Test-Path $us) { Get-ChildItem $us -Directory | ForEach-Object { $f=Join-Path $_.FullName 'archive.db'; if (Test-Path $f) { $t=Join-Path $bk ('users\'+$_.Name); New-Item -ItemType Directory -Force -Path $t | Out-Null; Copy-Item $f $t -Force } } }; Write-Output ('  Backup  : ' + $bk); Get-ChildItem 'data\backup' -Directory | Sort-Object Name -Descending | Select-Object -Skip 10 | Remove-Item -Recurse -Force" 2>nul

:info
echo  Data    : !DATA_DIR!
echo  Accounts: same as before (auth.db is never rewritten by this script)
echo  URL     : http://127.0.0.1:!P!
echo  Stop    : press Ctrl+C in this window
echo.
echo  ----------------------------------------------------------

set "PORT=!P!"
start "" /b powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 3; Start-Process 'http://127.0.0.1:!P!'"

"%NODE_EXE%" --experimental-sqlite --no-warnings server\server.js

echo.
echo  ----------------------------------------------------------
echo  Server stopped.
echo.
pause
exit /b 0

:nodata
echo  [ERROR] auth.db not found in:
echo          %CD%\dist\data
echo          %CD%\data
echo          Set MYLIFE_DATA=folder to point at an existing data folder.
echo.
pause
exit /b 1

:nonode
echo  [ERROR] Node.js 22.5 or newer not found.
echo          Install it from https://nodejs.org
echo          or put node.exe into PATH and run again.
echo.
pause
exit /b 1
