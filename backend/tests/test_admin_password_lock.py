"""관리자 자격증명 고정 정책 검증

배경(7/31): 콘솔 로그인만 하면 누구든 비밀번호를 바꿀 수 있어, 사용자가 자격증명을
고정하기로 결정했다. 변경 엔드포인트는 기본 잠금(403)이고 콘솔의 변경 버튼도 제거됐다.
ADMIN_PASSWORD_LOCK=0일 때만 열린다.
"""
from fastapi.testclient import TestClient

from app.api.v1 import admin as admin_module
from app.core.auth import get_current_admin
from app.main import app
from app.models.user import User

client = TestClient(app)


def test_password_change_locked_even_for_valid_admin():
    """정상 관리자 토큰이 있어도 변경은 403 — 잠금이 인증보다 우선한다."""
    fake_admin = User(email="admin@simplem.com", hashed_password="x", name="관리자")
    app.dependency_overrides[get_current_admin] = lambda: fake_admin
    try:
        res = client.post(
            "/api/v1/admin/password",
            json={"current_password": "whatever", "new_password": "long-enough-pw"},
        )
        assert res.status_code == 403
        assert "고정" in res.json()["detail"]
    finally:
        app.dependency_overrides.pop(get_current_admin, None)


def test_lock_flag_defaults_on():
    """환경변수 미설정이면 잠금이 기본값 — 배포에서 깜빡해도 잠겨 있어야 한다."""
    assert admin_module.ADMIN_PASSWORD_LOCKED is True


def test_console_has_no_password_change_button():
    """콘솔 화면에도 변경 입구가 없어야 한다 (버튼 부활 = 잠금 정책 위반)."""
    html = client.get("/console").text
    assert 'id="change-pw-btn"' not in html
