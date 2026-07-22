@echo off
rem SimpleM 백엔드 운영 실행 (출시용 — --reload 없음)
rem 시작프로그램 등록: Win+R → shell:startup → 이 파일의 바로가기 넣기
rem 공개 주소는 Tailscale Funnel(https://brewnote.tailc1719a.ts.net)이 localhost:8000으로 연결한다
cd /d C:\Users\USER\Desktop\final\backend
C:\Users\USER\miniforge3\Scripts\uvicorn.exe app.main:app --port 8000
