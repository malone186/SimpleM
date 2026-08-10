"""로그인/재설정 이메일 정규화 회귀 테스트 (인증) — 인메모리 sqlite.

'비밀번호를 재설정했는데 로그인이 안 된다'의 코드 쪽 원인:
로그인은 이메일 정확 일치, 재설정은 대소문자 무시 일치라 규칙이 어긋났다.
이제 셋(가입 저장·로그인·재설정) 모두 대소문자·공백을 무시하도록 맞춘다 — 그 계약을 잠근다.
(입력칸 자동 대문자화 문제는 프론트에서 별도 수정)
"""
import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

import app.models  # noqa: F401 — 모든 모델을 Base.metadata에 등록
from app.core.database import Base
from app.api.v1 import auth as auth_api
from app.schemas.user import ResetPasswordRequest, UserCreate, UserLogin


@pytest.fixture()
def db():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine, expire_on_commit=False)
    s = Session()
    yield s
    s.close()
    engine.dispose()


def _signup(db, email="owner@test.com", pw="pw1234", store="테스트카페", phone=None):
    return auth_api.signup(
        UserCreate(email=email, password=pw, name="사장", store_name=store, phone=phone), db)


def test_signup_normalizes_email(db):
    """가입 이메일은 소문자·공백제거로 저장된다."""
    u = _signup(db, email="  Owner@Test.COM ")
    assert u.email == "owner@test.com"


def test_login_case_insensitive(db):
    """대소문자가 달라도 로그인된다 (예전엔 정확 일치라 실패)."""
    _signup(db, email="Owner@Test.com", pw="pw1234")
    tok = auth_api.login(UserLogin(email="owner@test.com", password="pw1234"), db)
    assert tok["access_token"] and tok["email"] == "owner@test.com"


def test_reset_then_login_works(db):
    """재설정(휴대폰 본인확인) 후 새 비밀번호로 로그인되고, 옛 비번은 막힌다."""
    _signup(db, email="owner@test.com", pw="oldpw1", store="포슬카페", phone="010-1234-5678")
    auth_api.reset_password(
        ResetPasswordRequest(email="owner@test.com", verify="01012345678", new_password="newpw123"), db)

    tok = auth_api.login(UserLogin(email="owner@test.com", password="newpw123"), db)
    assert tok["access_token"]
    with pytest.raises(HTTPException) as ei:
        auth_api.login(UserLogin(email="owner@test.com", password="oldpw1"), db)
    assert ei.value.status_code == 401


def test_reset_then_login_case_insensitive(db):
    """재설정은 소문자 이메일로, 로그인은 대문자 이메일로 해도 일치한다 (규칙 통일 확인)."""
    _signup(db, email="Shop@Test.com", pw="oldpw1", store="가게", phone="010-2222-3333")
    auth_api.reset_password(
        ResetPasswordRequest(email="shop@test.com", verify="010-2222-3333", new_password="newpw123"), db)
    tok = auth_api.login(UserLogin(email="SHOP@test.com", password="newpw123"), db)
    assert tok["access_token"]


def test_reset_rejects_store_name_verify(db):
    """[보안 회귀] 상호명은 간판에 적힌 공개 정보 — 본인확인 수단으로 인정하지 않는다.

    예전엔 상호명·이름 일치만으로 비밀번호를 바꿀 수 있어, 이메일만 알면 누구나
    남의 계정을 넘겨받을 수 있었다. 휴대폰 미등록 계정도 상호명으로는 못 바꾼다
    (이메일 재설정 링크를 쓰면 된다).
    """
    _signup(db, email="owner@test.com", pw="oldpw1", store="포슬카페", phone="010-1234-5678")
    with pytest.raises(HTTPException) as ei:
        auth_api.reset_password(
            ResetPasswordRequest(email="owner@test.com", verify="포슬카페", new_password="hacked12"), db)
    assert ei.value.status_code == 400

    _signup(db, email="nophone@test.com", pw="oldpw1", store="전화없는카페")
    with pytest.raises(HTTPException) as ei:
        auth_api.reset_password(
            ResetPasswordRequest(email="nophone@test.com", verify="전화없는카페", new_password="hacked12"), db)
    assert ei.value.status_code == 400


def test_signup_blocks_admin_email(db, monkeypatch):
    """[보안 회귀] 관리자 허용목록 이메일로는 회원가입이 안 된다 — get_current_admin이
    이메일만 보므로, 가입을 열어 두면 누구나 관리자 API를 손에 넣는다."""
    import app.core.auth as core_auth
    monkeypatch.setattr(core_auth, "ADMIN_EMAILS", ["admin@simplem.com"])
    with pytest.raises(HTTPException) as ei:
        _signup(db, email="Admin@SimpleM.com")
    assert ei.value.status_code == 400


def test_duplicate_email_case_insensitive(db):
    """대소문자만 다른 중복 가입은 막힌다."""
    _signup(db, email="dup@test.com")
    with pytest.raises(HTTPException) as ei:
        _signup(db, email="DUP@Test.com")
    assert ei.value.status_code == 400
