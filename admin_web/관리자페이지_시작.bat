@echo off
chcp 65001 >nul
rem [한글 주석] 브루노트 관리자 콘솔을 http://localhost:8000/console 로 띄웁니다 (FastAPI가 서빙).
cd /d "%~dp0"
python serve.py
pause
