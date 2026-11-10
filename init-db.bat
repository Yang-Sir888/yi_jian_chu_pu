@echo off
chcp 65001 >nul
cd /d "%~dp0"
node backend\scripts\setup.mjs
if errorlevel 1 exit /b 1
echo 初始账号文件：%cd%\.lingpu\setup-credentials.json
pause
