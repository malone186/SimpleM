"""1대1 문의 왕복 + 관리자 회원 관리 실연동 테스트 — sqlite 인메모리 + get_db 오버라이드

확인하는 것:
  1. 앱에서 보낸 문의가 관리자 화면(GET /admin/cs)에 실제로 나온다 (같은 DB, 같은 id)
  2. 관리자가 단 답변이 사장님 앱(GET /inquiries)으로 돌아온다
  3. 남의 문의는 내 목록에 안 섞이고, 이메일을 알아도 훔쳐볼 수 없다
  4. 관리자 화면 값(계정 상태·메모·OCR/재고 건수)이 지어낸 값이 아니라 DB에서 온다
"""
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from fastapi import HTTPException

from app.core.auth import (
    get_current_admin,
    get_current_user,
    get_password_hash,
)
from app.core.database import Base, get_db
from app.main import app
from app.models.inventory import Ingredient
from app.models.user import User

OWNER = "owner-a@cafe.com"
OTHER = "owner-b@cafe.com"

# 지금 로그인한 사장님 — 테스트마다 이 값을 바꿔 '누가 보냈나'를 흉내 낸다.
# 실제 인증은 test_admin_login.py가 따로 검증한다.
_signed_in = {"email": OWNER}


@pytest.fixture()
def client():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    TestSession = sessionmaker(bind=engine, expire_on_commit=False)

    def override_get_db():
        db = TestSession()
        try:
            yield db
        finally:
            db.close()

    with TestSession() as db:
        db.add_all([
            User(email=OWNER, hashed_password=get_password_hash("x"), name="가사장", store_name="가나다카페"),
            User(email=OTHER, hashed_password=get_password_hash("x"), name="나사장", store_name="라마바커피"),
        ])
        db.commit()

    def current_user():
        # _signed_in["email"]을 None으로 두면 '토큰 없는 요청'을 재현한다 — 진짜
        # get_current_user와 같이 401로 막아야 한다 (None을 돌려주면 500이 나서
        # '거절됐다'는 사실만 맞고 이유가 달라진다).
        if not _signed_in["email"]:
            raise HTTPException(status_code=401, detail="인증이 필요합니다.")
        with TestSession() as db:
            return db.query(User).filter(User.email == _signed_in["email"]).first()

    app.dependency_overrides[get_db] = override_get_db
    # 관리자 인증은 이 테스트의 관심사가 아니다 (test_admin_login.py가 따로 검증한다)
    app.dependency_overrides[get_current_admin] = lambda: User(id=99, email="admin@simplem.com")
    app.dependency_overrides[get_current_user] = current_user
    _signed_in["email"] = OWNER
    yield TestClient(app), TestSession
    app.dependency_overrides.clear()
    engine.dispose()


def _post_inquiry(c, email, title, store_name=None):
    """email 계정으로 로그인한 상태에서 문의를 넣는다 (보낸 사람은 서버가 토큰에서 정한다)."""
    _signed_in["email"] = email
    body = {"category": "❓ 사용 문의", "title": title, "content": f"{title} 상세 내용"}
    if store_name is not None:
        body["store_name"] = store_name
    res = c.post("/api/v1/inquiries", json=body)
    assert res.status_code == 200, res.text
    return res.json()


def test_inquiry_shows_up_in_admin_console(client):
    """사장님이 보낸 문의가 관리자 CS 목록에 같은 id로 나타난다."""
    c, _ = client
    created = _post_inquiry(c, OWNER, "원두 발주 단위 문의")

    cs = c.get("/api/v1/admin/cs").json()
    assert [x["id"] for x in cs] == [created["id"]]
    row = cs[0]
    assert row["title"] == "원두 발주 단위 문의"
    assert row["email"] == OWNER
    assert row["status"] == "답변 대기"
    # 매장명은 users에서 채워진다 — '포슬카페' 같은 고정값이 아니다
    assert row["store"] == "가나다카페"
    # 이름 열은 사장님 이름이다 — 매장명을 그대로 넣으면 "가나다카페 (가나다카페)"가 된다
    assert row["name"] == "가사장"


def test_admin_reply_reaches_the_owner_app(client):
    """관리자가 단 답변이 앱의 '나의 문의 내역'으로 돌아온다."""
    c, _ = client
    created = _post_inquiry(c, OWNER, "정산 입금일 문의")

    res = c.post(f"/api/v1/admin/cs/{created['id']}/reply", json={"reply": "카드사별 입금일은 설정에서 바꾸실 수 있어요."})
    assert res.status_code == 200

    _signed_in["email"] = OWNER
    mine = c.get("/api/v1/inquiries").json()
    assert len(mine) == 1
    assert mine[0]["status"] == "answered"
    assert mine[0]["answer"] == "카드사별 입금일은 설정에서 바꾸실 수 있어요."


def test_my_list_excludes_other_owners(client):
    """다른 사장님 문의는 내 목록에 안 보인다."""
    c, _ = client
    _post_inquiry(c, OWNER, "내 문의")
    _post_inquiry(c, OTHER, "남의 문의")

    _signed_in["email"] = OWNER
    mine = c.get("/api/v1/inquiries").json()
    assert [x["title"] for x in mine] == ["내 문의"]
    # 관리자에게는 둘 다 보인다
    assert len(c.get("/api/v1/admin/cs").json()) == 2


def test_cannot_read_someone_elses_inquiries(client):
    """남의 이메일을 알아도 그 사람 문의는 못 읽는다 — 조회 기준은 토큰이다.

    예전엔 ?user_email=<남의 이메일>만 붙이면 인증 없이 문의 전문과 관리자 답변이 나왔다.
    """
    c, _ = client
    _post_inquiry(c, OTHER, "남의 비밀 문의")

    # OWNER로 로그인한 채 OTHER의 이메일을 넘겨 봐도 내 것(0건)만 나온다
    _signed_in["email"] = OWNER
    assert c.get("/api/v1/inquiries", params={"user_email": OTHER}).json() == []


def test_sender_comes_from_token_not_body(client):
    """본문에 남의 이메일을 실어 보내도 보낸 사람은 로그인 계정으로 기록된다."""
    c, _ = client
    _signed_in["email"] = OWNER
    res = c.post("/api/v1/inquiries", json={
        "user_email": OTHER,  # 사칭 시도
        "category": "❓ 사용 문의", "title": "사칭", "content": "...",
    })
    assert res.status_code == 200
    assert res.json()["user_email"] == OWNER


def test_pending_count_reflects_reality(client):
    """대시보드의 '미답변 문의'는 실제 미답변 건수다."""
    c, _ = client
    a = _post_inquiry(c, OWNER, "문의1")
    _post_inquiry(c, OTHER, "문의2")
    assert c.get("/api/v1/admin/dashboard/stats").json()["pendingInquiries"] == 2

    c.post(f"/api/v1/admin/cs/{a['id']}/reply", json={"reply": "답변드립니다."})
    stats = c.get("/api/v1/admin/dashboard/stats").json()
    assert stats["pendingInquiries"] == 1
    assert stats["totalInquiries"] == 2


def test_user_status_and_memo_persist(client):
    """계정 상태·메모가 DB에 저장돼 다시 조회했을 때 남아 있다 (예전엔 화면에만 있었다)."""
    c, _ = client
    users = c.get("/api/v1/admin/users").json()
    target = next(u for u in users if u["email"] == OWNER)
    # 관리자가 손대기 전 기본값
    assert target["status"] == "활성"
    assert target["memo"] == ""

    assert c.patch(f"/api/v1/admin/users/{target['id']}/status", json={"status": "정지"}).status_code == 200
    assert c.put(f"/api/v1/admin/users/{target['id']}/memo", json={"memo": "환불 문의 3회"}).status_code == 200

    again = next(u for u in c.get("/api/v1/admin/users").json() if u["email"] == OWNER)
    assert again["status"] == "정지"
    assert again["memo"] == "환불 문의 3회"
    # 다른 회원은 영향받지 않는다
    other = next(u for u in c.get("/api/v1/admin/users").json() if u["email"] == OTHER)
    assert other["status"] == "활성"


def test_invalid_status_rejected(client):
    c, _ = client
    uid = c.get("/api/v1/admin/users").json()[0]["id"]
    assert c.patch(f"/api/v1/admin/users/{uid}/status", json={"status": "프리미엄"}).status_code == 422


def test_user_counts_are_counted_not_invented(client):
    """OCR·재고 건수는 실제 행 수다 — 예전엔 0건일 때 (id*3)+2로 부풀렸다."""
    c, _ = client
    with_stock = next(u for u in c.get("/api/v1/admin/users").json() if u["email"] == OWNER)
    assert with_stock["ocrCount"] == 0
    assert with_stock["stockCount"] == 0

    _, TestSession = client
    with TestSession() as db:
        db.add_all([
            Ingredient(store_id=OWNER, name="원두", unit="g", current_price=12000),
            Ingredient(store_id=OWNER, name="우유", unit="ml", current_price=2500),
        ])
        db.commit()

    again = next(u for u in c.get("/api/v1/admin/users").json() if u["email"] == OWNER)
    assert again["stockCount"] == 2
    assert next(u for u in c.get("/api/v1/admin/users").json() if u["email"] == OTHER)["stockCount"] == 0


def test_submitting_without_token_is_rejected(client):
    """토큰 없이 보낸 문의는 본문에 이메일을 실어도 접수되지 않는다.

    구버전 앱 호환으로 열어 뒀던 본문 이메일 폴백을 2026-08-10에 닫았다. 열려 있는 동안은
    서버 주소만 알면 남의 이메일로 문의를 넣을 수 있었고, 그 글은 관리자 답변 대상이 되고
    사장님이 "내 문의 답변 왔어?"라고 물을 때 챗봇 컨텍스트로도 들어갔다.
    """
    c, _ = client
    _signed_in["email"] = None  # 토큰 없음
    res = c.post("/api/v1/inquiries", json={
        "user_email": OWNER,  # 남의 이름으로 넣으려는 시도
        "category": "❓ 사용 문의", "title": "무기명 문의", "content": "...",
    })
    assert res.status_code == 401, res.text

    # 관리자 화면에도 흔적이 남지 않는다
    _signed_in["email"] = OWNER
    assert not any(x["title"] == "무기명 문의" for x in c.get("/api/v1/admin/cs").json())


def test_reception_time_is_shown_in_kst(client):
    """관리자 화면의 '접수 일시'는 사장님이 실제로 보낸 한국 시각이다.

    저장은 UTC(datetime.utcnow)로 하는데 예전엔 화면에도 UTC를 그대로 찍어서,
    낮 12시 40분에 들어온 문의가 03:40으로 보였다. 밤에 들어온 문의는 날짜까지
    하루 앞으로 밀렸다.
    """
    from app.models.inquiry import Inquiry
    from app.utils.datetime_kst import KST

    c, TestSession = client
    created = _post_inquiry(c, OWNER, "접수 시각 확인")

    with TestSession() as db:
        stored = db.query(Inquiry).filter(Inquiry.id == created["id"]).first().created_at

    # 저장은 그대로 UTC — 이미 쌓인 행들과 기준이 같아야 목록 정렬·표시가 안 섞인다
    assert stored.tzinfo is None
    assert abs((stored - datetime.now(timezone.utc).replace(tzinfo=None)).total_seconds()) < 60

    expected = stored.replace(tzinfo=timezone.utc).astimezone(KST)
    row = next(x for x in c.get("/api/v1/admin/cs").json() if x["id"] == created["id"])
    assert row["date"] == expected.strftime("%Y-%m-%d %H:%M")

    # 앱의 '나의 문의 내역'도 같은 기준(KST) — 자정 근처에 날짜가 하루 어긋나면 안 된다
    mine = next(x for x in c.get("/api/v1/inquiries").json() if x["id"] == created["id"])
    assert mine["date"] == expected.strftime("%Y.%m.%d")
    assert created["date"] == mine["date"]  # 접수 응답과 목록이 같은 날짜를 말한다


def test_db_write_failure_still_reaches_both_screens(client, monkeypatch):
    """DB 쓰기가 실패해도 접수는 되고, 사장님 앱과 관리자 화면 양쪽에 같이 뜬다.

    폴백 경로는 평소 안 도는 분기라 여기서만 깨진 적이 있다 — 관리자 사본에 넣던
    시각 변수가 없어져 접수 자체가 500으로 죽었다. 두 화면의 일시도 같이 본다.
    """
    from app.api.v1 import inquiry as inquiry_api
    from app.api.v1.admin import mock_cs_list

    c, _ = client

    def boom(**kwargs):
        raise RuntimeError("DB 다운")

    monkeypatch.setattr(inquiry_api, "Inquiry", boom)
    # 두 리스트 모두 모듈 전역이라 테스트 사이에 남으면 안 된다.
    # GLOBAL_INQUIRIES는 monkeypatch가 되돌려 주고, mock_cs_list는 직접 비운다.
    monkeypatch.setattr(inquiry_api, "GLOBAL_INQUIRIES", [])
    try:
        created = _post_inquiry(c, OWNER, "DB 꺼진 동안 보낸 문의")

        mine = next(x for x in c.get("/api/v1/inquiries").json() if x["id"] == created["id"])
        row = next(x for x in c.get("/api/v1/admin/cs").json() if x["id"] == created["id"])
        assert row["title"] == "DB 꺼진 동안 보낸 문의"
        assert row["status"] == "답변 대기"

        # 두 화면이 같은 접수 시각을 말한다 (관리자는 분까지, 앱은 날짜까지)
        now = datetime.now(timezone(timedelta(hours=9)))
        assert row["date"].startswith(now.strftime("%Y-%m-%d"))
        assert mine["date"] == now.strftime("%Y.%m.%d")
    finally:
        mock_cs_list.clear()


def test_no_token_is_rejected(client):
    """토큰이 없으면 누가 보냈는지 확정할 수 없으므로 거절한다."""
    c, _ = client
    _signed_in["email"] = None
    res = c.post("/api/v1/inquiries", json={"category": "문의", "title": "무기명", "content": "..."})
    assert res.status_code == 401
