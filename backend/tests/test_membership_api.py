# c:\Users\USER\Documents\본 프로젝트\SimpleM\backend\tests\test_membership_api.py
"""
[한글 주석] HTTP 계약을 고정한다 — 단위 테스트가 못 잡는 영역.

단위 테스트는 함수가 맞게 계산하는지 본다.
그런데 오늘 난 버그 중 몇 개는 '계산은 맞는데 화면에 다르게 보이는' 종류였다.

  · 환불에서 amount의 의미를 '잔액 차감분'으로 바꿨는데
    손님 화면은 그걸 계속 '받은 돈'으로 표시했다.
    16,667원을 드리고 화면엔 20,000원이라고 떴다.
  · 프런트가 토큰을 안 붙여 401이 났는데 타입체크는 통과했다.

둘 다 함수 단위로는 정상이다. 사이가 어긋난 것이라
그 사이를 지나는 테스트가 없으면 못 잡는다.

실제 서버 없이 돌도록 앱을 테스트용으로 조립하고 DB만 SQLite로 바꾼다.
인증·미들웨어는 진짜를 쓴다 — 그게 검증 대상이기 때문이다.
"""
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.public_balance import router as public_router
from app.api.v1.membership import router as membership_router
from app.api.v1.staff_account import router as staff_router
from app.core.auth import create_access_token, get_password_hash
from app.core.database import Base, get_db
from app.core.staff_guard import staff_scope_middleware
# [한글 주석] 모델을 전부 등록해야 create_all이 테이블을 만든다.
# balance_transactions는 menus를, sales는 customers를 외래키로 참조해서
# 일부만 등록하면 테이블이 통째로 안 생긴다.
import app.models  # noqa: F401
from app.models.user import User

# [한글 주석] StaticPool이 반드시 필요하다.
#   TestClient는 요청을 별도 스레드에서 처리하는데, SQLite 메모리 DB는
#   기본 풀에서 스레드마다 새 연결(=새 빈 DB)을 준다.
#   그래서 테이블을 만들어 놓고도 요청 안에서는 "no such table: customers"가 난다.
#   StaticPool은 연결 하나를 모두가 공유하게 해 같은 DB를 보게 만든다.
engine = create_engine(
    "sqlite:///:memory:",
    connect_args={"check_same_thread": False},
    poolclass=StaticPool,
)
TestingSession = sessionmaker(autocommit=False, autoflush=False, bind=engine)

OWNER = "owner@test.com"


@pytest.fixture()
def client():
    Base.metadata.create_all(bind=engine)
    session = TestingSession()

    # 사장님 계정 (get_current_user가 이걸 찾는다)
    session.add(User(email=OWNER, name="사장님", store_name="테스트카페",
                     hashed_password=get_password_hash("pw")))
    session.commit()

    app = FastAPI()
    # 미들웨어도 진짜를 건다 — 권한 차단이 검증 대상이다
    app.middleware("http")(staff_scope_middleware)
    app.include_router(membership_router, prefix="/api/v1")
    app.include_router(staff_router, prefix="/api/v1")
    app.include_router(public_router)

    # 직원이 접근하면 안 되는 경로가 하나는 있어야 차단을 검증할 수 있다
    @app.get("/api/v1/secret-report")
    def _secret():
        return {"매출": 1234567}

    app.dependency_overrides[get_db] = lambda: session
    with TestClient(app) as c:
        c.owner_token = create_access_token({"sub": OWNER})
        yield c

    session.close()
    Base.metadata.drop_all(bind=engine)


def _auth(token):
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture()
def owner(client):
    return _auth(client.owner_token)


# --- 회원 · 충전 ---

def test_회원_등록부터_차감까지_한_흐름(client, owner):
    r = client.post("/api/v1/membership/customers",
                    json={"phone": "01012345678", "name": "김손님"}, headers=owner)
    assert r.status_code == 200, r.text
    cid = r.json()["id"]
    assert r.json()["phone_masked"] == "010-****-5678", "목록에 원본 번호를 그대로 쓰면 안 된다"

    r = client.post("/api/v1/membership/plans",
                    json={"pay_amount": 50000, "credit_amount": 60000}, headers=owner)
    assert r.json()["discount_rate"] == 16.7, "적립액 기준 할인율"
    plan_id = r.json()["id"]

    r = client.post(f"/api/v1/membership/customers/{cid}/charge",
                    json={"charge_plan_id": plan_id}, headers=owner)
    assert r.status_code == 200
    assert r.json()["balance"] == 60000
    assert "/b/" in r.json()["balance_url"]

    r = client.post(f"/api/v1/membership/customers/{cid}/use",
                    json={"amount": 4500, "memo": "아메리카노"}, headers=owner)
    assert r.json()["balance"] == 55500


def test_잔액보다_많이_쓰면_400(client, owner):
    cid = client.post("/api/v1/membership/customers",
                      json={"phone": "01012345678"}, headers=owner).json()["id"]
    client.post(f"/api/v1/membership/customers/{cid}/charge",
                json={"pay_amount": 3000, "credit_amount": 3000}, headers=owner)
    r = client.post(f"/api/v1/membership/customers/{cid}/use",
                    json={"amount": 9999}, headers=owner)
    assert r.status_code == 400


# --- 환불: 잔액 차감분 vs 실제 건넨 현금 ---

def test_환불_응답은_손님이_받은_현금을_알려준다(client, owner):
    """[핵심] 여기가 어긋나서 손님 화면이 20,000원이라고 거짓말했다.

    잔액 20,000원을 지우고 현금 16,667원을 건네는데,
    화면이 amount(-20,000)를 그대로 쓰면 손님은 20,000원을 받았다고 읽는다.
    """
    cid = client.post("/api/v1/membership/customers",
                      json={"phone": "01012345678"}, headers=owner).json()["id"]
    plan = client.post("/api/v1/membership/plans",
                       json={"pay_amount": 50000, "credit_amount": 60000},
                       headers=owner).json()
    client.post(f"/api/v1/membership/customers/{cid}/charge",
                json={"charge_plan_id": plan["id"]}, headers=owner)

    r = client.post(f"/api/v1/membership/customers/{cid}/refund",
                    json={"amount": 20000, "memo": "고객 요청"}, headers=owner)
    assert r.status_code == 200, r.text
    tx = r.json()["transaction"]

    assert tx["amount"] == -20000, "잔액에서 뺀 금액"
    assert tx["paid_amount"] == 16667, "실제로 건넨 현금 = 20,000 × (50/60)"
    assert tx["display_amount"] == 16667, "화면에 보여줄 금액은 받은 현금이어야 한다"
    assert r.json()["balance"] == 40000


def test_손님_페이지에_받은_현금이_표시된다(client, owner):
    cid = client.post("/api/v1/membership/customers",
                      json={"phone": "01012345678"}, headers=owner).json()["id"]
    plan = client.post("/api/v1/membership/plans",
                       json={"pay_amount": 50000, "credit_amount": 60000},
                       headers=owner).json()
    res = client.post(f"/api/v1/membership/customers/{cid}/charge",
                      json={"charge_plan_id": plan["id"]}, headers=owner).json()
    client.post(f"/api/v1/membership/customers/{cid}/refund",
                json={"amount": 20000}, headers=owner)

    token = res["balance_url"].rstrip("/").split("/")[-1]
    page = client.get(f"/b/{token}").text

    assert "16,667원" in page, "받은 현금이 보여야 한다"
    assert "잔액 20,000원 차감" in page, "잔액이 얼마나 줄었는지도 알려야 한다"


# --- 손님 페이지 ---

def test_손님_페이지는_인증_없이_열리고_전화번호를_노출하지_않는다(client, owner):
    cid = client.post("/api/v1/membership/customers",
                      json={"phone": "01012345678", "name": "김손님"},
                      headers=owner).json()["id"]
    res = client.post(f"/api/v1/membership/customers/{cid}/charge",
                      json={"pay_amount": 10000, "credit_amount": 10000},
                      headers=owner).json()
    token = res["balance_url"].rstrip("/").split("/")[-1]

    page = client.get(f"/b/{token}")           # 토큰만, 인증 헤더 없음
    assert page.status_code == 200
    assert "10,000원" in page.text
    assert "01012345678" not in page.text, "전화번호 원본이 새면 안 된다"
    assert "010-1234-5678" not in page.text
    assert "알아두실 점" in page.text, "사용처·환불 기준 고지"


def test_틀린_토큰은_404(client):
    assert client.get("/b/wrongtoken").status_code == 404


# --- 직원 권한 (미들웨어 + require_owner) ---

@pytest.fixture()
def staff(client, owner):
    r = client.post("/api/v1/staff-accounts",
                    json={"name": "박알바", "login_id": "alba01"}, headers=owner)
    assert r.status_code == 200, r.text
    pw = r.json()["initial_password"]
    login = client.post("/api/v1/staff-accounts/login",
                        json={"login_id": "alba01", "password": pw})
    assert login.status_code == 200, login.text
    return _auth(login.json()["access_token"])


def test_직원_토큰은_매장을_사장님_것으로_인식한다(client, staff):
    """[핵심] 여기가 어긋나면 기존 API 150여 군데가 조용히 빈 데이터를 낸다."""
    r = client.get("/api/v1/staff-accounts/me", headers=staff)
    assert r.json()["store_id"] == OWNER
    assert r.json()["is_owner"] is False


def test_직원은_허용_목록_밖을_못_부른다(client, staff, owner):
    assert client.get("/api/v1/secret-report", headers=staff).status_code == 403
    assert client.get("/api/v1/secret-report", headers=owner).status_code == 200


def test_직원은_돈이_나가는_일을_못_한다(client, staff, owner):
    cid = client.post("/api/v1/membership/customers",
                      json={"phone": "01012345678"}, headers=owner).json()["id"]
    client.post(f"/api/v1/membership/customers/{cid}/charge",
                json={"pay_amount": 10000, "credit_amount": 10000}, headers=owner)

    assert client.post(f"/api/v1/membership/customers/{cid}/refund",
                       json={"amount": 1000}, headers=staff).status_code == 403
    assert client.post(f"/api/v1/membership/customers/{cid}/adjust",
                       json={"amount": 1000, "memo": "x"}, headers=staff).status_code == 403
    assert client.get("/api/v1/membership/summary", headers=staff).status_code == 403


def test_직원도_차감은_할_수_있다(client, staff, owner):
    """계산대 업무 자체는 막으면 안 된다 — 막으면 기능이 존재할 이유가 없다."""
    cid = client.post("/api/v1/membership/customers",
                      json={"phone": "01012345678"}, headers=owner).json()["id"]
    client.post(f"/api/v1/membership/customers/{cid}/charge",
                json={"pay_amount": 10000, "credit_amount": 10000}, headers=owner)

    r = client.post(f"/api/v1/membership/customers/{cid}/use",
                    json={"amount": 3000, "memo": "아메리카노"}, headers=staff)
    assert r.status_code == 200
    assert r.json()["balance"] == 7000


def test_중지된_직원은_로그인할_수_없다(client, owner):
    r = client.post("/api/v1/staff-accounts",
                    json={"name": "퇴사자", "login_id": "quit01"}, headers=owner)
    sid, pw = r.json()["id"], r.json()["initial_password"]
    client.post(f"/api/v1/staff-accounts/{sid}/deactivate", headers=owner)

    r = client.post("/api/v1/staff-accounts/login",
                    json={"login_id": "quit01", "password": pw})
    assert r.status_code == 401


def test_인증_없이는_401(client):
    assert client.get("/api/v1/membership/customers").status_code == 401
