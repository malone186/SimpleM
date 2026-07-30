"""시스템 프롬프트 템플릿과 format 인자가 어긋나지 않는지 검증

배경(실제 사고): _MAIN_PROMPT에 {untrusted_rule}을 넣었으나 format 호출에 그 인자를
빠뜨려, 모든 대화가 KeyError로 즉시 실패했다. 예외는 generate_response가 삼켜
"앗! 답변을 준비하다가 문제가 생겼어요"만 나갔고, 헬스체크(/chatbot/agents)는
api_key_set·langsmith_enabled를 true로 보고해 정상처럼 보였다 — 챗봇이 통째로 죽어도
아무 신호가 없었다.

그래서 자리표시자 이름을 여기 하드코딩하지 않고, 런타임이 실제로 쓰는
render_main_prompt / render_sub_prompt를 그대로 호출한다. 프롬프트를 손볼 때
인자를 빠뜨리면 이 테스트가 KeyError로 먼저 넘어진다.
"""
import pytest

from app.services.ai.agents.main_agent import render_main_prompt, render_sub_prompt

# render_sub_prompt가 읽는 도메인 dict의 최소 형태
FAKE_DOMAIN = {"title": "재고 전문가", "extra": "재고 관련 추가 지침"}


def test_main_prompt_renders():
    """메인 오케스트레이터 프롬프트가 KeyError 없이 채워진다."""
    out = render_main_prompt(experts="- inventory_expert (재고 전문가)", store_id="s@gmail.com")
    assert out.strip()


def test_sub_prompt_renders():
    """서브에이전트(전문가) 프롬프트도 같은 규칙."""
    out = render_sub_prompt(FAKE_DOMAIN, store_id="s@gmail.com")
    assert out.strip()


def test_no_unfilled_placeholders_remain():
    """채워지지 않고 남은 {자리표시자}가 없어야 한다.

    format은 인자가 남는 것은 조용히 넘기므로, 렌더 결과에 중괄호가 남아 있으면
    프롬프트에 오타(예: {store id})가 있다는 뜻이다.
    """
    for label, out in (
        ("main", render_main_prompt(experts="- x (y)", store_id="s@gmail.com")),
        ("sub", render_sub_prompt(FAKE_DOMAIN, store_id="s@gmail.com")),
    ):
        # 이스케이프된 중괄호({{ }})는 정상 — 제거한 뒤 남은 것만 본다
        stripped = out.replace("{{", "").replace("}}", "")
        assert "{" not in stripped and "}" not in stripped, (
            f"{label} 프롬프트에 채워지지 않은 자리표시자가 남아 있다"
        )


def test_store_id_reaches_both_prompts():
    """매장 식별자가 프롬프트에 실제로 박히는지 — 빠지면 남의 매장 데이터를 답할 수 있다."""
    store = "verify-store@example.com"
    assert store in render_main_prompt(experts="- x (y)", store_id=store)
    assert store in render_sub_prompt(FAKE_DOMAIN, store_id=store)


def test_untrusted_rule_reaches_both_prompts():
    """외부 텍스트 인용 규칙(프롬프트 인젝션 방어)이 두 프롬프트 모두에 들어가야 한다."""
    from app.services.ai.untrusted import UNTRUSTED_PROMPT_RULE

    marker = UNTRUSTED_PROMPT_RULE.strip().splitlines()[0]
    assert marker in render_main_prompt(experts="- x (y)", store_id="s@gmail.com")
    assert marker in render_sub_prompt(FAKE_DOMAIN, store_id="s@gmail.com")
