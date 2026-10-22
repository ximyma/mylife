@echo off
REM Build MyLife APK. Paths follow the same layout as the foread project.
chcp 65001 >nul
setlocal

set JAVA_HOME=D:\jdk-17.0.19.10-hotspot
set ANDROID_HOME=D:\androidsdk\android-sdk-windows
set ANDROID_SDK_ROOT=D:\androidsdk\android-sdk-windows
set GRADLE_HOME=D:\gradle-8.7
set PATH=%JAVA_HOME%\bin;%ANDROID_HOME%\platform-tools;%GRADLE_HOME%\bin;%PATH%

cd /d "%~dp0"

echo === 1/3 同步前端到 assets ===
node tools\sync.js
if errorlevel 1 (
  echo [FAIL] sync failed
  pause
  exit /b 1
)

echo.
echo === 2/3 清理旧产物 ===
cd android
call "%GRADLE_HOME%\bin\gradle.bat" clean --no-daemon -q
if errorlevel 1 (
  echo [FAIL] clean failed
  pause
  exit /b 1
)

echo.
echo === 3/3 构建 Debug APK ===
call "%GRADLE_HOME%\bin\gradle.bat" assembleDebug --no-daemon
if errorlevel 1 (
  echo [FAIL] build failed
  pause
  exit /b 1
)

echo.
echo === 完成 ===
echo APK: %~dp0android\app\build\outputs\apk\debug\app-debug.apk
dir /b "%~dp0android\app\build\outputs\apk\debug\*.apk"
pause
