@echo off
title NETWATCH Local Discovery Agent (Localhost Mode)
echo Starting NETWATCH Local Discovery Agent (localhost-only 127.0.0.1:7779)...
echo Requires Node.js 18+ (https://nodejs.org)
echo.
set NODE_BIN=node
where node >nul 2>nul
if errorlevel 1 (
  if exist "C:\Program Files\nodejs\node.exe" set NODE_BIN="C:\Program Files\nodejs\node.exe"
)
%NODE_BIN% "%~dp0agent.js"
pause
