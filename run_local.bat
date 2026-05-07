@echo off
title AnigoStream Local Dev
echo ==========================================
echo    AnigoStream Local Development Server
echo ==========================================
echo.

:: Start Backend API
echo [1/2] Starting Backend API on http://localhost:5002...
start "Anigo API" cmd /k "python api/index.py"

:: Wait a moment for API to warm up
timeout /t 2 >nul

:: Start Frontend Web Server
echo [2/2] Starting Frontend on http://localhost:8000...
echo.
echo TIP: Close the windows to stop the servers.
python -m http.server 8000

pause
