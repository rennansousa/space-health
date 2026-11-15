@echo off
rem Space Health: starts the API and the app, then opens the browser.
cd /d "%~dp0"

where py >nul 2>nul || (echo Python not found. Install it from python.org and tick "Add to PATH". & pause & exit /b 1)
where npm >nul 2>nul || (echo Node.js not found. Install it from nodejs.org. & pause & exit /b 1)

if not exist "app\node_modules" (
  echo Installing app dependencies, first run only...
  pushd app
  call npm install || (popd & pause & exit /b 1)
  popd
)

start "Space Health - API (keep open)" cmd /k "cd /d "%~dp0backend" && py -3 server.py"
start "Space Health - App (keep open)" cmd /k "cd /d "%~dp0app" && npm run dev"

echo Waiting for the app to start...
timeout /t 6 /nobreak >nul
start "" "http://localhost:5174"

echo.
echo Ready: http://localhost:5174  (tap a person to sign in, e.g. C003 or Flight Surgeon)
echo To stop, close the two "Space Health" windows.
echo To reset the demo data: cd backend, then py -3 reset_demo.py
timeout /t 8 >nul
