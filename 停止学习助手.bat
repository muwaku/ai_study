@echo off
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*ai-learning-assistant*server.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
echo AI 学习助手已停止。
pause
