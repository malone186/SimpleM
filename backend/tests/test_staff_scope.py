# c:\Users\USER\Documents\본 프로젝트\SimpleM\backend\tests\test_staff_scope.py
"""
[한글 주석] 직원 계정이 볼 수 있는 범위를 고정한다.

권한은 조용히 뚫리는 종류의 버그다. 에러가 나는 게 아니라
'보이면 안 되는 게 보이는' 형태라, 눈으로 확인하지 않으면 모른다.

실제로 이 프로젝트에서 그 일이 있었다. 민감한 엔드포인트마다 하나씩
require_owner를 걸었는데도 재고 원가율·지출·경영 리포트가 뚫려 있었고,
사장님이 화면을 보고서야 발견했다. '막을 것을 세는' 방식은 반드시 빠뜨린다.

그래서 허용 목록으로 뒤집었고, 그 규칙을 여기서 고정한다.
새 기능이 추가돼도 기본이 '닫힘'이어야 한다.
"""
import pytest

from app.core.staff_guard import (
    STAFF_ALLOWED_PREFIXES, STAFF_DENIED_PREFIXES, is_blocked_for_staff,
)


@pytest.mark.parametrize("path,label", [
    ("/api/v1/documents/reports/daily", "경영 리포트"),
    ("/api/v1/operation/expenses", "지출"),
    ("/api/v1/operation/employees", "직원 명부"),
    ("/api/v1/settlement/settings", "카드 정산"),
    ("/api/v1/staff/payroll", "급여"),
    ("/api/v1/roastery/search", "원두 분석"),
    ("/api/v1/pos/status", "POS"),
    ("/api/v1/sensor/latest", "매장 센서"),
    ("/api/v1/store/profile", "매장 프로필"),
    ("/api/v1/admin/users", "관리자"),
])
def test_직원은_경영정보를_볼_수_없다(path, label):
    assert is_blocked_for_staff(path), f"{label}({path})이 직원에게 열려 있다"


def test_챗봇은_막혀야_한다():
    """챗봇은 도구 90개에 매출·정산·급여 조회가 다 들어 있다.
    다른 경로를 아무리 막아도 "이번 달 매출 알려줘" 한 마디로 우회된다."""
    assert is_blocked_for_staff("/api/v1/chatbot/chat")
    assert is_blocked_for_staff("/api/v1/chatbot/sessions")


def test_메뉴_원가율은_재고에_속하지만_막는다():
    """/inventory/menus는 재고 화면에 속하지만 응답에 원가와 원가율이 실려 나온다
    (아메리카노 판매가 3,000원 / 원가율 24.2%). 마진은 알바생이 볼 정보가 아니다.

    차감에 필요한 메뉴 이름·가격은 /membership/quick-menus가 따로 주므로
    막아도 계산대 업무에 지장이 없다."""
    assert is_blocked_for_staff("/api/v1/inventory/menus")


@pytest.mark.parametrize("path,label", [
    ("/api/v1/membership/customers", "회원 조회"),
    ("/api/v1/membership/checkins", "결제 요청 확인"),
    ("/api/v1/membership/quick-menus", "차감용 메뉴"),
    ("/api/v1/membership/customers/1/use", "잔액 차감"),
    ("/api/v1/inventory/ingredients", "재고 확인"),
    ("/api/v1/staff-accounts/me", "내 정보"),
    ("/api/v1/auth/login", "로그인"),
])
def test_직원이_해야_하는_일은_열려_있다(path, label):
    assert not is_blocked_for_staff(path), f"{label}({path})이 막혀 있다"


@pytest.mark.parametrize("path", [
    "/b/abc123",        # 손님 잔액 조회 (문자 링크)
    "/s/store-token",   # 계산대 QR
    "/health",
])
def test_손님용_공개경로는_토큰_없이_열린다(path):
    assert not is_blocked_for_staff(path)


def test_새_기능은_기본이_닫힘이다():
    """[핵심] 이 테스트가 이 파일의 존재 이유다.

    팀원이 새 엔드포인트를 추가해도 화이트리스트에 없으면 직원은 못 본다.
    반대(블랙리스트)였다면 새 기능이 기본 '열림'이라 조용히 새어 나간다.
    """
    assert is_blocked_for_staff("/api/v1/something-new-nobody-told-me-about")
    assert is_blocked_for_staff("/api/v1/future/secret-report")


def test_허용목록에_경영_관련_경로가_섞이지_않았다():
    """화이트리스트에 넓은 접두어를 실수로 넣으면 통째로 열린다.
    예를 들어 '/api/v1'만 넣으면 전부 열린다."""
    for prefix in STAFF_ALLOWED_PREFIXES:
        assert prefix.count("/") >= 3, f"접두어가 너무 넓다: {prefix}"
        assert prefix not in ("/api/v1", "/api/v1/"), "전 경로가 열린다"


def test_차단목록은_허용목록보다_우선한다():
    """/inventory는 허용인데 /inventory/menus는 차단 — 순서가 뒤집히면 뚫린다."""
    assert any(d.startswith(a) for d in STAFF_DENIED_PREFIXES
               for a in STAFF_ALLOWED_PREFIXES), "차단 규칙이 허용 범위 안에 있어야 의미가 있다"
    assert is_blocked_for_staff("/api/v1/inventory/menus")
    assert not is_blocked_for_staff("/api/v1/inventory/ingredients")
