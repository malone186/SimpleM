"""챗봇 쿼터 환불 회귀 테스트 (백엔드 B).

generate_response는 내부에서 예외를 전부 삼켜 정상 dict(사과 문구)로 돌려준다.
그래서 /chat의 바깥 except로는 AI 실패가 안 잡히고, 예전엔 실패한 턴도 쿼터가
차감된 채 환불되지 않았다. 이제 반환 dict의 ok=False를 보고 환불한다 — 그 배선을 잠근다.

DB·Gemini를 타지 않도록 consume/refund와 generate_response를 가짜로 갈아끼운다.
"""
import asyncio

import pytest
from fastapi import HTTPException

from app.api.v1 import chatbot as cb
from app.services.ai.agents import main_agent


def _call(monkeypatch, ok: bool):
    calls = {"consume": 0, "refund": 0}
    monkeypatch.setattr(cb.chat_quota_service, "consume",
                        lambda s: calls.__setitem__("consume", calls["consume"] + 1) or {})
    # refund는 (store_id, day)를 받는다 — 차감된 날짜 행을 짚어 되돌리는 자정 경계 규칙
    monkeypatch.setattr(cb.chat_quota_service, "refund",
                        lambda s, day=None: calls.__setitem__("refund", calls["refund"] + 1))

    async def fake_gen(**kwargs):
        return {"text": "답" if ok else "앗! 문제가 생겼어요", "documents": [], "ok": ok}

    monkeypatch.setattr(cb.main_agent, "generate_response", fake_gen)
    resp = asyncio.run(cb.chat_message(cb.ChatRequest(message="안녕"), store_id="s@test.com"))
    return calls, resp


def test_failed_turn_is_refunded(monkeypatch):
    """ok=False면 차감된 쿼터를 되돌린다 (실패한 턴은 공짜)."""
    calls, resp = _call(monkeypatch, ok=False)
    assert calls["consume"] == 1
    assert calls["refund"] == 1          # 예전엔 여기가 0이라 실패해도 차감됐다
    assert "문제" in resp.response


def test_successful_turn_is_not_refunded(monkeypatch):
    """정상 답변이면 환불하지 않는다 (턴 1회 정상 소비)."""
    calls, resp = _call(monkeypatch, ok=True)
    assert calls["consume"] == 1
    assert calls["refund"] == 0
    assert resp.response == "답"


def test_generate_response_ok_false_without_api_key(monkeypatch):
    """API 키가 없으면 ok=False로 표시해 호출부가 환불할 수 있게 한다."""
    monkeypatch.setattr(main_agent, "GEMINI_API_KEY", "")
    out = asyncio.run(main_agent.generate_response("안녕", "s@test.com"))
    assert out["ok"] is False


def test_unexpected_chat_error_is_refunded_without_leaking_details(monkeypatch):
    """예상 밖 장애도 환불하되 내부 예외 문자열은 API 응답에 노출하지 않는다."""
    refunded = []
    monkeypatch.setattr(cb.chat_quota_service, "consume", lambda _: {"date": "2026-08-18"})
    monkeypatch.setattr(cb.chat_quota_service, "refund", lambda store, day=None: refunded.append((store, day)))

    async def fail(**kwargs):
        raise RuntimeError("postgresql://secret-user:secret-password@private-db/internal")

    monkeypatch.setattr(cb.main_agent, "generate_response", fail)

    with pytest.raises(HTTPException) as caught:
        asyncio.run(cb.chat_message(cb.ChatRequest(message="안녕"), store_id="s@test.com"))

    assert caught.value.status_code == 500
    assert "secret" not in str(caught.value.detail)
    assert refunded == [("s@test.com", "2026-08-18")]
