@echo off
title NETWATCH Local Discovery Agent (Secure LAN Mode)
echo ================================================================
echo  Starting NETWATCH Local Discovery Agent in SECURE LAN MODE
echo  - Requires Node.js 18+ (https://nodejs.org)
echo  - Generates a random Access Token for Wi-Fi / LAN devices
echo  - Restricts all connections and scans to your local subnet
echo ================================================================
echo.
set NODE_BIN=node
where node >nul 2>nul
if errorlevel 1 (
  if exist "C:\Program Files\nodejs\node.exe" set NODE_BIN="C:\Program Files\nodejs\node.exe"
)
%NODE_BIN% "%~dp0agent.js" --lan
pause
