@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 未检测到 Node.js。请安装 Node.js 后再启动本地学习助手。
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -WindowStyle Hidden -FilePath 'node' -ArgumentList @('%~dp0ai-learning-assistant\server.js')"
timeout /t 2 /nobreak >nul
start "" "http://127.0.0.1:43117"
