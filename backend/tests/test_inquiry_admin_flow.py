"""1대1 문의 왕복 + 관리자 회원 관리 실연동 테스트 — sqlite 인메모리 + get_db 오버라이드

확인하는 것:
  1. 앱에서 보낸 문의가 관리자 화면(GET /admin/cs)에 실제로 나온다 (같은 DB, 같은 id)
  2. 관리자가 단 답변이 사장님 앱(GET /inquiries?user_email=)으로 돌아온다
  3. 남의 문의는 내 목록에 안 섞인다
  4. 관리자 화면 값(계정 상태·메모·OCR/재고 건수)이 지어낸 값이 아니라 DB에서 온다
"""
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.auth import get_current_admin, get_password_hash
from app.core.database import Base, get_db
from app.main import app
from app.models.inventory import Ingredient
from app.models.user import User

OWNER = "owner-a@cafe.com"
OTHER = "owner-b@cafe.com"


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

    app.dependency_overrides[get_db] = override_get_db
    # 관리자 인증은 이 테스트의 관심사가 아니다 (test_admin_login.py가 따로 검증한다)
    app.dependency_overrides[get_current_admin] = lambda: User(id=99, email="admin@simplem.com")
    yield TestClient(app), TestSession
    app.dependency_overrides.clear()
    engine.dispose()


def _post_inquiry(c, email, title, store_name=None):
    body = {"user_email": email, "category": "❓ 사용 문의", "title": title, "content": f"{title} 상세 내용"}
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

    mine = c.get("/api/v1/inquiries", params={"user_email": OWNER}).json()
    assert len(mine) == 1
    assert mine[0]["status"] == "answered"
    assert mine[0]["answer"] == "카드사별 입금일은 설정에서 바꾸실 수 있어요."


def test_my_list_excludes_other_owners(client):
    """다른 사장님 문의는 내 목록에 안 보인다."""
    c, _ = client
    _post_inquiry(c, OWNER, "내 문의")
    _post_inquiry(c, OTHER, "남의 문의")

    mine = c.get("/api/v1/inquiries", params={"user_email": OWNER}).json()
    assert [x["title"] for x in mine] == ["내 문의"]
    # 관리자에게는 둘 다 보인다
    assert len(c.get("/api/v1/admin/cs").json()) == 2


def test_inquiry_requires_owner_email(client):
    """이메일 없이 온 문의는 거절한다 — 예전엔 데모 계정(owner@cafe.com) 것으로 저장됐다."""
    c, _ = client
    res = c.post("/api/v1/inquiries", json={"category": "❓ 사용 문의", "title": "무기명", "content": "..."})
    assert res.status_code == 422


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
