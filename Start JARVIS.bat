@echo off
rem Double-click to run JARVIS on Windows. Installs what it needs the first
rem time, then starts the brain and the face and opens JARVIS in your browser.
title J.A.R.V.I.S.
cd /d "%~dp0"

if not exist "package.json" (
  echo.
  echo  This file was opened from inside the ZIP. Right-click the ZIP, choose
  echo  "Extract All", open the extracted folder ^(it may hold another folder of
  echo  the same name - open that too^) and double-click Start JARVIS.bat there.
  echo.
  pause
  exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Node.js is not installed. Install the LTS version from https://nodejs.org
  echo  then double-click this file again.
  echo.
  start "" https://nodejs.org
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo.
  echo  First run: installing JARVIS. This takes a few minutes...
  echo.
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo  Install failed. Check your internet connection and try again.
    pause
    exit /b 1
  )
)

echo.
echo  Starting JARVIS. It opens in your browser when ready.
echo  Keep this window open while you use JARVIS. Close it to stop.
echo.
call npm start
pause
