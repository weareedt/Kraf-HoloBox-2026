@echo off
REM ===================================================================
REM  KRAF kiosk lock-down: turns off Windows edge swipes for this PC
REM  (notification centre, Widgets / Task View, taskbar).
REM  The app does this itself on its first run, with one permission prompt;
REM  use this file if that prompt was declined, or to undo it.
REM
REM    kiosk-setup.bat          lock (asks for admin)
REM    kiosk-setup.bat undo     unlock (asks for admin)
REM    kiosk-setup.bat status   show the current state (no admin needed)
REM
REM  Takes effect after the next sign-in or restart. See electron/kiosk-lock.cjs.
REM ===================================================================
setlocal
set KEY=HKLM\SOFTWARE\Policies\Microsoft\Windows\EdgeUI

if /i "%~1"=="status" goto status

net session >nul 2>&1
if errorlevel 1 (
  echo Asking Windows for admin permission...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -ArgumentList '%~1' -Verb RunAs"
  exit /b
)

if /i "%~1"=="undo" (
  reg delete "%KEY%" /v AllowEdgeSwipe /f
  echo Edge swipes are back on after the next sign-in or restart.
) else (
  reg add "%KEY%" /v AllowEdgeSwipe /t REG_DWORD /d 0 /f
  echo Edge swipes are OFF after the next sign-in or restart.
)
pause
exit /b

:status
reg query "%KEY%" /v AllowEdgeSwipe 2>nul | find "0x0" >nul
if errorlevel 1 (echo Edge swipes: ON ^(not locked^)) else (echo Edge swipes: OFF ^(locked^))
pause
