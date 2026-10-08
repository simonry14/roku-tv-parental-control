@echo off
rem Roku TV Parental Control - double-click to install, or to update an existing install.
rem It asks Windows for administrator rights, then runs scripts\windows\install.ps1.
setlocal
title Roku TV Parental Control - Install

rem Opened straight from inside the .zip, Windows copies only this one file somewhere temporary.
if not exist "%~dp0scripts\windows\install.ps1" (
  echo.
  echo   Please extract the download first:
  echo   right-click the .zip file, choose "Extract All", then open the new folder
  echo   and double-click Install.cmd there.
  echo.
  pause
  exit /b 1
)

net session >nul 2>&1
if errorlevel 1 (
  echo Asking Windows for permission to install. Choose "Yes" in the window that appears.
  set "RTPC_SELF=%~f0"
  powershell.exe -NoProfile -Command "Start-Process -FilePath $env:RTPC_SELF -Verb RunAs"
  exit /b
)

cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\install.ps1" -Source "%~dp0."
if errorlevel 1 (
  echo.
  echo The installation did not finish. The messages above say why.
)
echo.
pause
