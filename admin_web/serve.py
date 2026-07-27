"""SimpleM 관리자 콘솔 정적 서버 — http://localhost:3000

사용법:  python admin_web/serve.py   (또는 admin_web 폴더에서 python serve.py)
사장님 앱에서 제출한 1대1 문의는 백엔드(8000)를 거쳐 이 페이지 CS 탭에 3초 내 자동 표시된다.
"""
import functools
import http.server
import os
import webbrowser

import sys

PORT = 3000
ROOT = os.path.dirname(os.path.abspath(__file__))


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    """[한글 주석] 개발 중 수정사항이 새로고침만으로 바로 반영되도록 캐시를 끈다."""

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self):
        # favicon이 없어 매 접속마다 404 로그가 찍히던 것을 빈 응답으로 조용히 처리
        if self.path == "/favicon.ico":
            self.send_response(204)
            self.end_headers()
            return
        super().do_GET()


def main() -> None:
    # [한글 주석] 윈도우 콘솔에서 유니코드 출력 시 cp949 인코딩 에러가 발생하지 않도록 UTF-8로 지정
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')

    handler = functools.partial(NoCacheHandler, directory=ROOT)
    server = http.server.ThreadingHTTPServer(("0.0.0.0", PORT), handler)
    url = f"http://localhost:{PORT}"
    print(f"[SimpleM] 관리자 콘솔 실행 중: {url}  (종료: Ctrl+C)")
    try:
        webbrowser.open(url)
    except Exception:
        pass
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        # Ctrl+C 종료는 정상 동작 — 트레이스백 없이 조용히 닫는다
        print("\n[SimpleM] 관리자 콘솔을 종료합니다.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
