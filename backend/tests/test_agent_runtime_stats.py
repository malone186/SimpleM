"""챗봇 실행 계측 테스트 (백엔드 B)

관리자 콘솔의 'AI 에이전트' 탭은 편성표만으로는 알 수 없는 것 — 실제로 돌고 있는지,
어디서 실패하는지 — 을 이 계측에 의존한다. 그래서 두 가지를 본다.

1. 도구·전문가 호출이 실제로 집계되는가 (Gemini 없이 래퍼만으로 확인)
2. 계측이 대화를 절대 방해하지 않는가 (기록 중 예외가 나도 도구 결과는 그대로)
"""
import asyncio

import pytest

from app.services.ai.agents import main_agent, runtime_stats


@pytest.fixture(autouse=True)
def clean_stats():
    runtime_stats.reset()
    yield
    runtime_stats.reset()


def _tool(name: str, fn=None):
    """테스트용 도구 하나 — args_schema가 있어야 _bind_store가 감싼다."""
    from langchain_core.tools import tool as make_tool

    @make_tool(name)
    def _t(query: str) -> str:
        """테스트 도구."""
        if fn:
            return fn(query)
        return f"결과: {query}"

    return _t


def test_tool_calls_are_counted():
    rec = runtime_stats.TurnRecorder()
    bound = main_agent._bind_store(_tool("demo_tool"), "shop@test.com", [], rec)

    bound.invoke({"query": "안녕"})
    bound.invoke({"query": "또"})

    snap = runtime_stats.snapshot()
    assert {"name": "demo_tool", "calls": 2, "failures": 0} in snap["tools"]
    assert rec.tools == ["demo_tool", "demo_tool"]


def test_failed_tool_is_counted_but_turn_survives():
    """도구가 터져도 대화는 계속돼야 한다 — 실패 횟수만 따로 센다."""
    def boom(_):
        raise RuntimeError("외부 API 죽음")

    rec = runtime_stats.TurnRecorder()
    bound = main_agent._bind_store(_tool("broken_tool", boom), "shop@test.com", [], rec)

    out = bound.invoke({"query": "x"})
    assert "실행 실패" in out  # 예외가 아니라 문자열로 돌아온다

    tool = next(t for t in runtime_stats.snapshot()["tools"] if t["name"] == "broken_tool")
    assert tool["calls"] == 1 and tool["failures"] == 1


def test_recorder_is_optional():
    """계측을 안 넘겨도(기존 호출부·테스트) 도구는 그대로 동작한다."""
    bound = main_agent._bind_store(_tool("plain_tool"), "shop@test.com", [])
    assert "결과" in bound.invoke({"query": "hi"})
    assert runtime_stats.snapshot()["tools"] == []


def test_delegation_is_counted():
    """전문가 위임 한 번 = 호출 한 번. 소요 시간도 함께 남는다."""
    class FakeSub:
        async def ainvoke(self, _payload, config=None):
            class Msg:
                content = "전문가 답변"
            return {"messages": [Msg()]}

    rec = runtime_stats.TurnRecorder()
    domain = {"name": "data_expert", "title": "데이터 전문가", "description": "설명"}
    delegate = main_agent._make_delegate_tool(domain, FakeSub(), rec)

    asyncio.get_event_loop_policy().new_event_loop().run_until_complete(
        delegate.coroutine(task="어제 매출 알려줘")
    )

    expert = next(e for e in runtime_stats.snapshot()["experts"] if e["name"] == "data_expert")
    assert expert["calls"] == 1
    assert expert["failures"] == 0


def test_turn_record_shape():
    """콘솔 표가 읽는 필드들 — 하나라도 빠지면 화면이 빈칸이 된다."""
    rec = runtime_stats.TurnRecorder()
    rec.expert_called("report_expert", 1200.0)
    rec.tool_called("get_daily_report")
    runtime_stats.record_turn("shop@test.com", 3400.0, "ok", rec, "이번 주 리포트 만들어줘")

    snap = runtime_stats.snapshot()
    assert snap["turns"] == 1 and snap["ok"] == 1 and snap["ok_rate"] == 100.0
    assert snap["avg_ms"] == 3400

    row = snap["recent"][0]
    assert row["store_id"] == "shop@test.com"
    assert row["ok"] is True
    assert row["experts"] == ["report_expert"]
    assert row["tool_calls"] == 1
    assert row["question"] == "이번 주 리포트 만들어줘"


def test_failure_reasons_are_separated():
    """조치가 갈리는 실패(한도·DB·코드)는 사유별로 세야 한다."""
    for reason in ("quota", "db", "db", "error"):
        runtime_stats.record_turn("shop@test.com", 100.0, reason)

    snap = runtime_stats.snapshot()
    assert snap["failed"] == 4 and snap["ok_rate"] == 0.0
    counts = {r["reason"]: r["count"] for r in snap["failure_reasons"]}
    assert counts == {"quota": 1, "db": 2, "error": 1}
    assert {r["label"] for r in snap["failure_reasons"]} == {"무료 한도 소진", "DB 연결 실패", "실행 오류"}


def test_long_question_is_truncated():
    """질문 원문을 통째로 들고 있지 않는다 — 목록 표시에 필요한 만큼만."""
    runtime_stats.record_turn("shop@test.com", 10.0, "ok", None, "가" * 200)
    assert len(runtime_stats.snapshot()["recent"][0]["question"]) <= 61


def test_overview_carries_runtime():
    """/chatbot/agents 응답에 실행 현황이 실려야 콘솔이 그린다."""
    runtime_stats.record_turn("shop@test.com", 500.0, "ok")
    overview = main_agent.get_agent_overview()

    assert overview["runtime"]["turns"] == 1
    # 전문가·도구 카드에도 호출 횟수가 붙는다 (편성만 된 것과 실제 쓰이는 것을 구분)
    assert all("calls" in e for e in overview["experts"])
    assert all("calls" in t for e in overview["experts"] for t in e["tools"])
