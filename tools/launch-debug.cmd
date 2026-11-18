@echo off
rem Debug launcher: keeps the console so startup errors stay visible.
rem Normal use: double-click 启动赛博鱼缸.vbs in the project root.
setlocal
cd /d "%~dp0.."
if not exist "runtime\electron.exe" (
  echo Electron runtime not found: %CD%\runtime\electron.exe
  echo Put Electron into runtime\ (you should see runtime\electron.exe).
  pause
  exit /b 1
)
start "" "%CD%\runtime\electron.exe" "%CD%\cyber-aquarium"