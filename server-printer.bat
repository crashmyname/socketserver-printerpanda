@echo off
title PRINTER SERVER - Koperasi Stanley
color 0A
cd /d "%~dp0"

:MENU
cls
echo ========================================
echo    PRINTER SERVER KOPERASI STANLEY
echo ========================================
echo.
echo  [1] START Server (Background)
echo  [2] STOP Server
echo  [3] STATUS Server
echo  [4] TEST Print
echo  [5] EXIT
echo.
set /p pilih="Pilih (1-5): "

if "%pilih%"=="1" goto START
if "%pilih%"=="2" goto STOP
if "%pilih%"=="3" goto STATUS
if "%pilih%"=="4" goto TEST
if "%pilih%"=="5" exit
goto MENU

:START
cls
echo Starting server...
start /min node server.js
timeout /t 2 /nobreak >nul
echo Server started!
pause
goto MENU

:STOP
cls
echo Stopping server...
taskkill /f /im node.exe >nul 2>nul
echo Server stopped!
pause
goto MENU

:STATUS
cls
tasklist | find "node.exe" >nul
if %errorlevel% equ 0 (
    echo [RUNNING] Server aktif
) else (
    echo [STOPPED] Server tidak jalan
)
pause
goto MENU

:TEST
cls
curl -X POST http://localhost:3000/test
echo.
pause
goto MENU