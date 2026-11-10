@echo off
chcp 65001 >nul
cd /d "%~dp0"
call npm.cmd --prefix backend ci --no-audit --no-fund
if errorlevel 1 exit /b 1
call npm.cmd --prefix frontend ci --no-audit --no-fund
if errorlevel 1 exit /b 1
call npm.cmd --prefix frontend run build
if errorlevel 1 exit /b 1
echo 安装完成，请运行 start.bat。
pause
