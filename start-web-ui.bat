@echo off
setlocal
cd /d "%~dp0"

if not exist "core\dist\index.js" (
  echo Building @sql-formatter/core...
  call npm run build -w core
  if errorlevel 1 (
    echo Build failed - see errors above.
    pause
    exit /b 1
  )
)

echo Starting SQL Formatter web UI... (close this window to stop it)
call npm run dev -w web -- --open
