@echo off
chcp 65001 >nul
setlocal

cd /d "%~dp0"
title Project 01 - Campus Asset Inspection
set PORT=3101
set URL=http://localhost:%PORT%

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Please install Node.js first, then run this file again.
  echo Download: https://nodejs.org/
  pause
  exit /b 1
)

echo Starting Project 01: Campus Asset Inspection
echo Folder: %cd%
echo URL: %URL%
echo.
start "" "%URL%"
node server.js

echo.
echo Project 01 has stopped.
pause
