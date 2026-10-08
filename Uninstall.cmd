@echo off
rem Roku TV Parental Control - double-click to remove it from this PC.
rem It asks Windows for administrator rights, then runs scripts\windows\uninstall.ps1.
setlocal
title Roku TV Parental Control - Uninstall

net session >nul 2>&1
if errorlevel 1 (
  echo Asking Windows for permission. Choose "Yes" in the window that appears.
  set "RTPC_SELF=%~f0"
  powershell.exe -NoProfile -Command "Start-Process -FilePath $env:RTPC_SELF -Verb RunAs"
  exit /b
)

cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\uninstall.ps1" -Target "%~dp0."
echo.
pause
