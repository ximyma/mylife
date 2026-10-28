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
if not defined NODE_MAJOR goto :portscan
if !NODE_MAJOR! LSS 22 echo  [WARN] Node 22.5 or newer is required. If it crashes, upgrade Node first.

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
echo  [WARN] Port 4321 is busy - another window may still be running.
echo         This test will listen on !P! instead.
echo.

:backup
if not "!OFF!"=="0" goto :info
if not exist "data\backup" mkdir "data\backup"
if exist "data\users\1\archive.db" (
  powershell -NoProfile -Command "$d=Get-Date -Format 'yyyyMMdd-HHmmss'; Copy-Item -LiteralPath 'data\users\1\archive.db' -Destination ('data\backup\archive-'+$d+'.db') -Force; Get-ChildItem -LiteralPath 'data\backup' -Filter 'archive-*.db' | Sort-Object LastWriteTime -Descending | Select-Object -Skip 20 | Remove-Item -Force" >nul 2>nul
  echo  Backup  : data\backup\  (newest 20 snapshots kept)
)

:info
echo  Data    : %CD%\data
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

:nonode
echo  [ERROR] Node.js 22.5 or newer not found.
echo          Install it from https://nodejs.org
echo          or put node.exe into PATH and run again.
echo.
pause
exit /b 1
