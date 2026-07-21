"""SimpleM 관리자 콘솔 정적 서버 — http://localhost:3000

사용법:  python admin_web/serve.py   (또는 admin_web 폴더에서 python serve.py)
사장님 앱에서 제출한 1대1 문의는 백엔드(8000)를 거쳐 이 페이지 CS 탭에 3초 내 자동 표시된다.
"""
import functools
import http.server
import os
import webbrowser

PORT = 3000
ROOT = os.path.dirname(os.path.abspath(__file__))


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    """[한글 주석] 개발 중 수정사항이 새로고침만으로 바로 반영되도록 캐시를 끈다."""

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


def main() -> None:
    handler = functools.partial(NoCacheHandler, directory=ROOT)
    server = http.server.ThreadingHTTPServer(("0.0.0.0", PORT), handler)
    url = f"http://localhost:{PORT}"
    print(f"✅ SimpleM 관리자 콘솔 실행 중: {url}  (종료: Ctrl+C)")
    try:
        webbrowser.open(url)
    except Exception:
        pass
    server.serve_forever()


if __name__ == "__main__":
    main()
