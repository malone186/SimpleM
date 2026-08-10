"""광고 충전 검증 회귀 테스트 (백엔드 B)

예전엔 앱이 "광고 다 봤어요"라고 POST 한 번 때리면 그대로 충전됐다. 앱을 뜯으면 광고
없이 그 엔드포인트만 반복해도 되고, 그 턴은 실제 Gemini 호출 비용이다. 지금은
  1) 충전 1건이 원장(ad_reward_grants)에 남아 같은 거래가 두 번 충전되지 않고,
  2) 구글이 서명해 보내는 SSV 콜백을 검증해 그걸 근거로 충전할 수 있으며,
  3) CHAT_AD_SSV_REQUIRED=1이면 앱 보고 경로가 아예 막힌다.
이 세 가지 배선을 잠근다.
"""
import base64
import time

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401 — create_all 전에 모든 모델을 Base.metadata에 등록
from app.core import database as core_db
from app.core.database import Base
from app.services.ai import admob_ssv
from app.services.ai import chat_quota_service as Q

STORE = "ad@test.com"


@pytest.fixture(autouse=True)
def _db(monkeypatch):
    # StaticPool — 서비스가 자기 세션을 새로 열기 때문에, 커넥션마다 다른 DB가 되면
    # 방금 만든 테이블이 안 보인다 (인메모리 sqlite의 기본 동작).
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    Base.metadata.create_all(bind=engine)
    monkeypatch.setattr(core_db, "SessionLocal", sessionmaker(bind=engine, expire_on_commit=False))
    monkeypatch.setattr(Q, "SSV_REQUIRED", False)
    yield
    engine.dispose()


# ── 원장 기반 중복 방지 ────────────────────────────────────────────────────

def test_same_transaction_grants_only_once():
    """같은 거래 id로 두 번 들어와도 충전은 한 번뿐이다 (콜백 재전송·중복 호출 대비)."""
    first = Q.grant_from_ad(STORE, source="ssv", transaction_id="ssv:abc123")
    second = Q.grant_from_ad(STORE, source="ssv", transaction_id="ssv:abc123")

    assert first["granted"] == Q.TURNS_PER_AD
    assert second["granted"] == Q.TURNS_PER_AD  # 두 번째는 그대로
    assert second["ads_watched"] == 1


def test_distinct_transactions_stack_up_to_daily_cap():
    """서로 다른 시청 건은 쌓이되, 하루 상한을 넘지 않는다."""
    for i in range(Q.MAX_ADS_PER_DAY):
        Q.grant_from_ad(STORE, source="ssv", transaction_id=f"ssv:{i}")

    with pytest.raises(Q.AdLimitReached):
        Q.grant_from_ad(STORE, source="ssv", transaction_id="ssv:overflow")


def test_grant_is_recorded_with_its_source():
    """무엇을 근거로 충전했는지 원장에 남는다 — 운영자가 SSV 경로가 살아 있는지 본다."""
    from app.models.ai import AdRewardGrant

    Q.grant_from_ad(STORE, source="ssv", transaction_id="ssv:zz")
    Q.grant_from_ad(STORE)  # 앱 보고 경로 — 거래 id를 서버가 만든다

    with core_db.SessionLocal() as db:
        rows = db.query(AdRewardGrant).order_by(AdRewardGrant.source).all()
    assert [r.source for r in rows] == ["client", "ssv"]
    assert all(r.turns == Q.TURNS_PER_AD and r.store_id == STORE for r in rows)
    assert next(r for r in rows if r.source == "client").transaction_id.startswith("client:")


# ── SSV 강제 모드 ──────────────────────────────────────────────────────────

def test_client_report_is_refused_when_ssv_required(monkeypatch):
    """강제 모드에서는 앱 보고로 충전되지 않는다 — 구글 콜백만 인정한다."""
    monkeypatch.setattr(Q, "SSV_REQUIRED", True)

    with pytest.raises(Q.AdVerificationPending) as e:
        Q.grant_from_ad(STORE)
    assert e.value.args[0]["granted"] == 0  # 한 턴도 늘지 않았다

    # 같은 상황에서 구글 콜백은 통과한다
    assert Q.grant_from_ssv({"user_id": STORE, "transaction_id": "t1"})["granted"] == Q.TURNS_PER_AD


def test_ssv_callback_without_user_id_is_rejected():
    """누구에게 줄지 없는 콜백은 처리하지 않는다 (데모 계정으로 흘러들면 안 된다)."""
    with pytest.raises(ValueError):
        Q.grant_from_ssv({"transaction_id": "t2"})
    with pytest.raises(ValueError):
        Q.grant_from_ssv({"user_id": STORE})


# ── 서명 검증 ──────────────────────────────────────────────────────────────

def _now_ms() -> int:
    """방금 발생한 콜백의 timestamp — 오래된 콜백은 검증에서 거절된다(재생 방어)."""
    return int(time.time() * 1000)


def _signed_query(payload: str, key_id: str = "1111") -> str:
    """테스트용 EC 키로 서명한 콜백 쿼리스트링을 만든다 (구글이 보내는 형식과 동일)."""
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

    private = ec.generate_private_key(ec.SECP256R1())
    signature = private.sign(payload.encode("utf-8"), ec.ECDSA(hashes.SHA256()))
    pem = private.public_key().public_bytes(Encoding.PEM, PublicFormat.SubjectPublicKeyInfo)

    # 구글은 패딩 없는 웹세이프 base64로 보낸다
    encoded = base64.urlsafe_b64encode(signature).decode().rstrip("=")
    admob_ssv._cache.update({"fetched_at": float("inf"), "keys": {key_id: pem.decode()}})
    return f"{payload}&signature={encoded}&key_id={key_id}"


def test_valid_signature_passes_and_returns_params():
    query = _signed_query(
        "ad_network=5450213213286189855&ad_unit=1234&reward_amount=1"
        f"&reward_item=turns&timestamp={_now_ms()}&transaction_id=abc&user_id=ad%40test.com"
    )
    params = admob_ssv.verify(query)
    assert params["transaction_id"] == "abc"
    assert params["user_id"] == "ad@test.com"  # 디코딩된 값으로 돌려준다


def test_tampered_payload_fails_verification():
    """서명 대상 원문을 한 글자라도 바꾸면 검증에 실패한다 (보상량 조작 방어)."""
    query = _signed_query(f"reward_amount=1&timestamp={_now_ms()}&transaction_id=abc&user_id=x")
    tampered = query.replace("reward_amount=1", "reward_amount=9")

    with pytest.raises(admob_ssv.SsvInvalid):
        admob_ssv.verify(tampered)


def test_unknown_key_id_fails_without_network(monkeypatch):
    """모르는 key_id면 키를 다시 받아 보고, 그래도 없으면 거절한다."""
    query = _signed_query(f"transaction_id=abc&user_id=x&timestamp={_now_ms()}")
    monkeypatch.setattr(admob_ssv, "_fetch_keys", lambda: {})  # 네트워크를 타지 않는다

    with pytest.raises(admob_ssv.SsvInvalid):
        admob_ssv.verify(query.replace("key_id=1111", "key_id=9999"))


def test_missing_signature_is_rejected():
    with pytest.raises(admob_ssv.SsvInvalid):
        admob_ssv.verify("transaction_id=abc&user_id=x")


# ── 콜백 엔드포인트 배선 ───────────────────────────────────────────────────

def test_ssv_endpoint_grants_on_valid_signature():
    """구글이 호출하는 경로 그대로 — 서명이 맞으면 그 계정에 충전된다.

    엔드포인트가 request.url.query(원문)를 넘기는지까지 여기서 잠근다. 파싱된
    query_params로 다시 조립하면 순서·인코딩이 달라져 서명이 깨진다.
    """
    from fastapi.testclient import TestClient

    from app.main import app

    query = _signed_query(
        f"ad_network=54502&reward_amount=1&reward_item=turns&timestamp={_now_ms()}"
        "&transaction_id=tx-777&user_id=ad%40test.com"
    )
    res = TestClient(app).get(f"/api/v1/chatbot/quota/ad-ssv?{query}")

    assert res.status_code == 200, res.text
    assert Q.get_quota(STORE)["granted"] == Q.TURNS_PER_AD


def test_ssv_endpoint_rejects_forged_callback():
    """서명 없이 URL만 흉내 낸 호출은 403이고, 충전도 없다."""
    from fastapi.testclient import TestClient

    from app.main import app

    res = TestClient(app).get(
        "/api/v1/chatbot/quota/ad-ssv?transaction_id=tx-forged&user_id=ad%40test.com"
    )

    assert res.status_code == 403
    assert Q.get_quota(STORE)["granted"] == 0
