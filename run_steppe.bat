@echo off
title Steppe Meeting
echo ========================================================
echo               Steppe Meeting for Windows
echo ========================================================
echo.

cd /d "%~dp0"

echo Starting local backend server...
start "Steppe Meeting Backend" /min python backend/desktop_server.py

echo Starting Steppe Meeting desktop application...
start "" "Steppe-Meeting.exe"

echo Done! Steppe Meeting is running.
