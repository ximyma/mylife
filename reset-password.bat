@echo off
setlocal
title MyLife - reset one account password
cd /d "%~dp0"

set "NODE_EXE="
for /f "delims=" %%N in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%N"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE goto :nonode

set "AUTH=%CD%\dist\data\auth.db"
if not exist "%AUTH%" set "AUTH=%CD%\data\auth.db"
if not exist "%AUTH%" goto :nodata

echo.
echo  ==========================================================
echo    Reset ONE account password
echo    Archive content is NOT touched. Only the login of one phone.
echo    Close the running app window first.
echo  ==========================================================
echo.
echo  Auth DB : %AUTH%
echo.
echo  Existing accounts:
echo.
"%NODE_EXE%" --experimental-sqlite --no-warnings tools\reset-password.js "%AUTH%"
echo.
set "PHONE="
set /p PHONE=Phone number - empty to quit: 
if not defined PHONE goto :done
set "NEWPW="
set /p NEWPW=New password - 6 chars or more: 
if not defined NEWPW goto :done
echo.
"%NODE_EXE%" --experimental-sqlite --no-warnings tools\reset-password.js "%AUTH%" "%PHONE%" "%NEWPW%"

:done
echo.
pause
exit /b 0

:nonode
echo  [ERROR] Node.js 22.5 or newer not found. Install it from https://nodejs.org
echo.
pause
exit /b 1

:nodata
echo  [ERROR] auth.db not found in dist\data or data.
echo.
pause
exit /b 1
