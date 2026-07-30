"""SimpleM 관리자 콘솔 런처 — 이제 콘솔은 FastAPI가 직접 서빙한다 (http://localhost:8000/console)

예전에는 이 폴더의 정적 파일(index.html·app.js·style.css)을 포트 3000으로 따로 서빙했지만,
콘솔이 backend/app/admin_console/(Jinja 템플릿 + static)으로 이사해 백엔드와 한 몸이 됐다.
Cloud Run 배포본에서도 같은 경로다: https://brewnote-api-….run.app/console

이 스크립트는 호환용 런처로만 남는다:
  1) 백엔드(uvicorn, 포트 8000)가 안 떠 있으면 띄우고
  2) 브라우저로 /console 을 연다
"""
import os
import socket
import subprocess
import sys
import webbrowser

BACKEND_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "backend")
URL = "http://localhost:8000/console"


def backend_running() -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.5)
        return s.connect_ex(("127.0.0.1", 8000)) == 0


def main() -> None:
    # [한글 주석] 윈도우 콘솔에서 유니코드 출력 시 cp949 인코딩 에러가 발생하지 않도록 UTF-8로 지정
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    if backend_running():
        print(f"[SimpleM] 백엔드가 이미 떠 있습니다 → {URL}")
        webbrowser.open(URL)
        return

    print(f"[SimpleM] 백엔드(uvicorn)를 띄우고 콘솔을 엽니다 → {URL}  (종료: Ctrl+C)")
    try:
        webbrowser.open(URL)
    except Exception:
        pass
    try:
        subprocess.call(
            [sys.executable, "-m", "uvicorn", "app.main:app", "--port", "8000"],
            cwd=os.path.abspath(BACKEND_DIR),
        )
    except KeyboardInterrupt:
        print("\n[SimpleM] 관리자 콘솔을 종료합니다.")


if __name__ == "__main__":
    main()
