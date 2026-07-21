@echo off
chcp 65001 >nul
rem [한글 주석] SimpleM 관리자 콘솔을 http://localhost:3000 으로 띄웁니다.
cd /d "%~dp0"
python serve.py
pause
