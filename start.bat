@echo off
REM ===================================================================
REM  KRAF - Muzium Kraf Kuala Lumpur kiosk
REM  Double-click this file. Nothing else.
REM
REM  Runs the Electron app when installed (preferred: Chromium is bundled and
REM  version-pinned, there is no browser UI at all, and nothing can auto-update
REM  mid-exhibition). Falls back to Google Chrome if it is not.
REM
REM  F11 toggles fullscreen <-> 608x1080 portrait window.
REM  Alt+F4 exits.
REM ===================================================================

setlocal
set KRAF_PORT=8765
set KRAF_URL=http://127.0.0.1:%KRAF_PORT%
REM Browser profile lives OUTSIDE _source (it is a cache, not an asset) and is
REM versioned: bumping the suffix guarantees a clean cache if one ever goes stale.
set KRAF_PROFILE=%~dp0.cache\chrome-profile-v2

REM Some hosts (notably VS Code) export this, which silently makes Electron run as
REM plain Node so the window never opens. Clear it for our own child processes.
set ELECTRON_RUN_AS_NODE=

cd /d "%~dp0"

REM --- locate node ---------------------------------------------------
where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo   ERROR: Node.js not found on PATH.
  echo   Install it from https://nodejs.org and run this again.
  echo.
  pause
  exit /b 1
)

REM --- preferred path: the bundled Electron app -----------------------
REM  Electron starts the server itself, so nothing else is needed here.
if exist "%~dp0node_modules\electron\dist\electron.exe" (
  echo Starting KRAF ...
  start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
  exit /b 0
)

echo Electron not installed - falling back to Google Chrome.
echo   ^(run "npm install" once to use the bundled runtime instead^)
echo.

REM --- fallback: locate chrome ---------------------------------------
set CHROME=
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe
if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe
if not defined CHROME (
  echo.
  echo   ERROR: neither Electron nor Google Chrome was found.
  echo.
  pause
  exit /b 1
)

REM --- start the server in its own window -----------------------------
echo Starting KRAF server on %KRAF_URL% ...
start "KRAF server" /min cmd /c "node "%~dp0server\server.js""

REM --- wait for the port to answer before launching the browser -------
set /a TRIES=0
:waitloop
set /a TRIES+=1
powershell -NoProfile -Command "try{(New-Object Net.Sockets.TcpClient('127.0.0.1',%KRAF_PORT%)).Close();exit 0}catch{exit 1}" >nul 2>&1
if not errorlevel 1 goto ready
if %TRIES% GEQ 40 (
  echo   ERROR: server did not start after 20 seconds.
  pause
  exit /b 1
)
ping -n 1 -w 500 127.0.0.1 >nul
goto waitloop

:ready
echo Server up. Launching kiosk...

REM  --start-fullscreen     : fullscreen on launch, but F11 still works. (--kiosk would
REM                           lock fullscreen and swallow F11, so it is NOT used.)
REM  --window-size          : the size Chrome restores to when fullscreen is exited,
REM                           i.e. the 608x1080 portrait window. Matches the 9:16 canvas.
REM  --autoplay-policy      : profile/step videos carry audio and must start unattended
REM  --user-data-dir        : dedicated profile, so no stale session or restore bubble
REM  --disable-pinch        : pinch must zoom the 3D model, never the page
REM  --check-for-update...  : stop Chrome updating itself mid-exhibition
start "" "%CHROME%" ^
  --start-fullscreen "--app=%KRAF_URL%" ^
  --window-size=608,1080 ^
  --window-position=80,20 ^
  "--user-data-dir=%KRAF_PROFILE%" ^
  --autoplay-policy=no-user-gesture-required ^
  --disable-pinch ^
  --overscroll-history-navigation=0 ^
  --noerrdialogs ^
  --disable-session-crashed-bubble ^
  --disable-infobars ^
  --disable-features=Translate,TranslateUI,HardwareMediaKeyHandling ^
  --check-for-update-interval=31536000

endlocal
