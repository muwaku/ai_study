@echo off
chcp 65001 >nul
setlocal

set "PROJECT_ROOT=%~dp0"
set "CODEX_HOME=D:\1AI-Workbench\project\workbench\workspace\runtime\.codex-home-official"
set "CODEX_JS=D:\Node\node_global\node_modules\@openai\codex\bin\codex.js"

cd /d "%PROJECT_ROOT%"

where node >nul 2>nul
if errorlevel 1 (
  echo 未检测到 Node.js。请先安装 Node.js，或检查 node 是否在 PATH 中。
  pause
  exit /b 1
)

if not exist "%CODEX_JS%" (
  echo 未找到 Codex CLI：%CODEX_JS%
  echo 请先确认 Codex CLI 已安装。
  pause
  exit /b 1
)

echo 正在启动 ai_study 项目治理 Agent...
echo 项目目录：%PROJECT_ROOT%
echo.

node "%CODEX_JS%" ^
  --cd "%PROJECT_ROOT%" ^
  --sandbox workspace-write ^
  --ask-for-approval on-request ^
  "请先阅读 PROJECT_GOVERNANCE_AGENT.md，然后作为 ai_study 项目的正式治理 Agent 与我协作。"

echo.
echo Codex 会话已结束。
pause
