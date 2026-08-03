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
    """재설정(상호명 본인확인) 후 새 비밀번호로 로그인되고, 옛 비번은 막힌다."""
    _signup(db, email="owner@test.com", pw="oldpw1", store="포슬카페")
    auth_api.reset_password(
        ResetPasswordRequest(email="owner@test.com", verify="포슬카페", new_password="newpw123"), db)

    tok = auth_api.login(UserLogin(email="owner@test.com", password="newpw123"), db)
    assert tok["access_token"]
    with pytest.raises(HTTPException) as ei:
        auth_api.login(UserLogin(email="owner@test.com", password="oldpw1"), db)
    assert ei.value.status_code == 401


def test_reset_then_login_case_insensitive(db):
    """재설정은 소문자 이메일로, 로그인은 대문자 이메일로 해도 일치한다 (규칙 통일 확인)."""
    _signup(db, email="Shop@Test.com", pw="oldpw1", store="가게")
    auth_api.reset_password(
        ResetPasswordRequest(email="shop@test.com", verify="가게", new_password="newpw123"), db)
    tok = auth_api.login(UserLogin(email="SHOP@test.com", password="newpw123"), db)
    assert tok["access_token"]


def test_duplicate_email_case_insensitive(db):
    """대소문자만 다른 중복 가입은 막힌다."""
    _signup(db, email="dup@test.com")
    with pytest.raises(HTTPException) as ei:
        _signup(db, email="DUP@Test.com")
    assert ei.value.status_code == 400
