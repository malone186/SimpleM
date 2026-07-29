"""1대1 문의 왕복 + 관리자 회원 관리 실연동 테스트 — sqlite 인메모리 + get_db 오버라이드

확인하는 것:
  1. 앱에서 보낸 문의가 관리자 화면(GET /admin/cs)에 실제로 나온다 (같은 DB, 같은 id)
  2. 관리자가 단 답변이 사장님 앱(GET /inquiries)으로 돌아온다
  3. 남의 문의는 내 목록에 안 섞이고, 이메일을 알아도 훔쳐볼 수 없다
  4. 관리자 화면 값(계정 상태·메모·OCR/재고 건수)이 지어낸 값이 아니라 DB에서 온다
"""
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.auth import (
    get_current_admin,
    get_current_user,
    get_current_user_optional,
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
        with TestSession() as db:
            return db.query(User).filter(User.email == _signed_in["email"]).first()

    app.dependency_overrides[get_db] = override_get_db
    # 관리자 인증은 이 테스트의 관심사가 아니다 (test_admin_login.py가 따로 검증한다)
    app.dependency_overrides[get_current_admin] = lambda: User(id=99, email="admin@simplem.com")
    app.dependency_overrides[get_current_user] = current_user
    # 문의 등록은 선택적 인증을 쓴다 (구버전 앱 호환) — 로그인 상태를 흉내 내려면 이쪽도 덮어야 한다.
    # _signed_in["email"]을 None으로 두면 '토큰 없는 구버전 앱'을 재현할 수 있다.
    app.dependency_overrides[get_current_user_optional] = lambda: (
        current_user() if _signed_in["email"] else None
    )
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


def test_legacy_app_without_token_can_still_submit(client):
    """토큰 없이 보내는 구버전 앱도 문의를 접수할 수 있다.

    인증을 필수로 걸었더니 OTA를 아직 못 받은 앱에서 접수가 통째로 막혔다(401).
    등록은 남의 데이터를 읽는 경로가 아니라서 본문 이메일 폴백을 열어 둔다.
    조회(GET)는 여전히 토큰이 필요하다 — 그쪽이 실제 유출 경로였다.
    """
    c, _ = client
    _signed_in["email"] = None  # 토큰 없음 = 구버전 앱
    res = c.post("/api/v1/inquiries", json={
        "user_email": OWNER, "category": "❓ 사용 문의",
        "title": "구버전 앱에서 보낸 문의", "content": "...",
    })
    assert res.status_code == 200, res.text
    assert res.json()["user_email"] == OWNER

    # 관리자 화면에는 정상적으로 뜬다
    assert any(x["title"] == "구버전 앱에서 보낸 문의" for x in c.get("/api/v1/admin/cs").json())


def test_no_token_and_no_email_is_rejected(client):
    """토큰도 이메일도 없으면 누가 보냈는지 알 수 없으므로 거절한다."""
    c, _ = client
    _signed_in["email"] = None
    res = c.post("/api/v1/inquiries", json={"category": "문의", "title": "무기명", "content": "..."})
    assert res.status_code == 422
