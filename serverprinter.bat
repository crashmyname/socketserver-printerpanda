@echo off
title Printer Server - Koperasi Stanley
color 0A

echo ========================================
echo    PRINTER SERVER KOPERASI STANLEY
echo ========================================
echo.

:: Cek apakah Node.js terinstal
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js tidak ditemukan!
    echo.
    echo Silakan install Node.js dari:
    echo https://nodejs.org/
    echo.
    pause
    exit /b 1
)

:: Hapus temporary file lama jika ada
if exist temp rmdir /s /q temp 2>nul
mkdir temp 2>nul
mkdir backup 2>nul

echo [INFO] Menjalankan server printer...
echo [INFO] Buka browser: http://localhost:3000
echo [INFO] Tekan CTRL+C untuk menghentikan server
echo.

:: Jalankan server
node server.js

pause