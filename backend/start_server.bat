@echo off
rem SimpleM 백엔드 운영 실행
cd /d %~dp0
.venv\Scripts\uvicorn.exe app.main:app --host 0.0.0.0 --port 8000 --reload

