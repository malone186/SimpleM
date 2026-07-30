"""관리자 콘솔(/console)이 FastAPI에서 정상 서빙되는지 검증

배경: 예전 별도 정적 서버(admin_web, 포트 3000)를 FastAPI Jinja 템플릿 + static 마운트로
이전했다. 템플릿 자리표시자(url_for·api_base)가 렌더링에서 깨지면 콘솔이 통째로 죽으므로
페이지·정적 파일·주입값을 각각 확인한다.
"""
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_console_page_renders():
    res = client.get("/console")
    assert res.status_code == 200
    assert "text/html" in res.headers["content-type"]
    html = res.text
    # Jinja가 실제로 렌더링됐다면 템플릿 구문이 남아 있으면 안 된다
    assert "{{" not in html and "{%" not in html
    # 같은 origin 상대 경로 주입 — app.js의 DEFAULT_API가 이 값으로 조립된다
    assert 'window.__ADMIN_API_BASE__ = ""' in html
    # 정적 자원이 마운트 경로로 링크되고 캐시 무효화 버전이 붙는다
    assert "/console/static/style.css?v=" in html
    assert "/console/static/app.js?v=" in html


def test_console_static_files_served():
    for path, ctype in (("app.js", "javascript"), ("style.css", "css")):
        res = client.get(f"/console/static/{path}")
        assert res.status_code == 200, f"{path} 응답 {res.status_code}"
        assert ctype in res.headers["content-type"]


def test_console_js_uses_injected_base():
    """app.js가 하드코딩된 배포 주소가 아니라 주입값을 쓰는지 — 회귀 방지."""
    js = client.get("/console/static/app.js").text
    assert "window.__ADMIN_API_BASE__" in js
    # Cloud Run 주소 하드코딩이 되살아나면 로컬 콘솔이 배포 DB를 조용히 바라보게 된다
    assert "run.app/api/v1'" not in js
