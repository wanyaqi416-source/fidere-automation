@echo off
chcp 65001 >nul
cd /d "%~dp0"
call npm.cmd run test
if errorlevel 1 (
  echo.
  echo 自动化测试启动器异常退出。
  pause
)
