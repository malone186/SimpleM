"""커스텀 비밀번호 재설정 메일 테스트 (백엔드 B).

설정 유무 판정, 계정 없음 시 조용히 넘어가기, 링크 있으면 발송, 엔드포인트의 503 폴백 신호를
검증한다. 실제 SMTP·Firebase는 타지 않도록 가짜로 갈아끼운다.
"""
import pytest
from fastapi import HTTPException

from app.services import mail_service
from app.api.v1 import auth as auth_api
from app.schemas.user import ResetEmailRequest


def _clear_mail_env(monkeypatch):
    for k in ("FCM_SERVICE_ACCOUNT_JSON", "MAIL_SMTP_HOST", "MAIL_SMTP_USER",
              "MAIL_SMTP_PASSWORD", "MAIL_FROM"):
        monkeypatch.delenv(k, raising=False)


def test_not_available_without_config(monkeypatch):
    _clear_mail_env(monkeypatch)
    assert mail_service.custom_reset_available() is False


def test_smtp_configured_flag(monkeypatch):
    _clear_mail_env(monkeypatch)
    assert mail_service.smtp_configured() is False
    monkeypatch.setenv("MAIL_SMTP_HOST", "smtp-relay.brevo.com")
    monkeypatch.setenv("MAIL_SMTP_USER", "u")
    monkeypatch.setenv("MAIL_SMTP_PASSWORD", "p")
    monkeypatch.setenv("MAIL_FROM", "no-reply@brewnote.app")
    assert mail_service.smtp_configured() is True


def test_endpoint_503_when_unavailable(monkeypatch):
    """미설정이면 503(code=custom_email_unavailable) — 프론트가 Firebase 기본 메일로 폴백."""
    monkeypatch.setattr(mail_service, "custom_reset_available", lambda: False)
    with pytest.raises(HTTPException) as ei:
        auth_api.reset_password_email(ResetEmailRequest(email="a@test.com"))
    assert ei.value.status_code == 503
    assert ei.value.detail.get("code") == "custom_email_unavailable"


def test_send_skips_when_no_firebase_account(monkeypatch):
    """해당 이메일의 Firebase 계정이 없으면(None) 메일을 보내지 않고 False를 돌려준다."""
    sent = {"n": 0}
    monkeypatch.setattr(mail_service, "generate_reset_link", lambda email, continue_url="": None)
    monkeypatch.setattr(mail_service, "_send", lambda msg: sent.__setitem__("n", sent["n"] + 1))
    assert mail_service.send_password_reset("nouser@test.com") is False
    assert sent["n"] == 0


def test_send_builds_and_sends_with_link(monkeypatch):
    """링크가 나오면 그 링크를 담은 메일을 만들어 발송한다."""
    captured = {}
    monkeypatch.setattr(mail_service, "generate_reset_link",
                        lambda email, continue_url="": "https://brewnote.firebaseapp.com/__/auth/action?oobCode=x")
    monkeypatch.setattr(mail_service, "_send",
                        lambda msg: captured.update({"to": msg["To"], "subject": msg["Subject"]}))
    assert mail_service.send_password_reset("user@test.com") is True
    assert captured["to"] == "user@test.com"
    assert "재설정" in captured["subject"]


class _FakeQuery:
    def __init__(self, user):
        self._user = user

    def filter(self, *args, **kwargs):
        return self

    def first(self):
        return self._user


class _FakeDb:
    """User 조회만 흉내 내는 가짜 DB 세션 (재설정 엔드포인트의 프로비저닝 분기용)."""

    def __init__(self, user):
        self._user = user

    def query(self, *args):
        return _FakeQuery(self._user)


def test_endpoint_calls_send_when_available(monkeypatch):
    calls = {"n": 0}
    monkeypatch.setattr(mail_service, "custom_reset_available", lambda: True)
    monkeypatch.setattr(mail_service, "send_password_reset",
                        lambda email, continue_url="": (calls.__setitem__("n", calls["n"] + 1), True)[1])
    auth_api.reset_password_email(ResetEmailRequest(email="a@test.com"), db=_FakeDb(None))  # 204 → None
    assert calls["n"] == 1


def test_endpoint_provisions_firebase_for_db_only_account(monkeypatch):
    """Firebase엔 없지만 백엔드 DB엔 있는 가입자 — 계정을 만들어 준 뒤 다시 발송한다.

    예전엔 이 케이스가 '메일을 보냈어요' 화면 뒤에서 아무것도 안 보내고 204로 끝났다.
    """
    sends = {"n": 0}
    provisioned = {"n": 0}

    def fake_send(email, continue_url=""):
        sends["n"] += 1
        return sends["n"] > 1  # 첫 시도는 계정 없음(False), 프로비저닝 후 재시도는 발송(True)

    monkeypatch.setattr(mail_service, "custom_reset_available", lambda: True)
    monkeypatch.setattr(mail_service, "send_password_reset", fake_send)
    monkeypatch.setattr(mail_service, "provision_firebase_account",
                        lambda email: (provisioned.__setitem__("n", provisioned["n"] + 1), True)[1])
    auth_api.reset_password_email(ResetEmailRequest(email="dbonly@test.com"), db=_FakeDb(object()))
    assert provisioned["n"] == 1
    assert sends["n"] == 2


def test_endpoint_skips_provision_when_not_in_db(monkeypatch):
    """백엔드 DB에도 없는 이메일 — 프로비저닝 없이 조용히 204 (이메일 열거 방지)."""
    provisioned = {"n": 0}
    monkeypatch.setattr(mail_service, "custom_reset_available", lambda: True)
    monkeypatch.setattr(mail_service, "send_password_reset", lambda email, continue_url="": False)
    monkeypatch.setattr(mail_service, "provision_firebase_account",
                        lambda email: (provisioned.__setitem__("n", provisioned["n"] + 1), True)[1])
    auth_api.reset_password_email(ResetEmailRequest(email="ghost@test.com"), db=_FakeDb(None))
    assert provisioned["n"] == 0
