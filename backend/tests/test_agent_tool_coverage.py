"""등록된 도구가 전부 어느 전문가에게든 편성돼 있는지 검증 (백엔드 B)

배경(반복된 실제 사고): 도구를 만들고 tool_registry에는 추가했는데
main_agent._DOMAINS 편성에 넣는 걸 잊으면, 도구는 '등록됨'으로 보이지만
챗봇은 영영 부를 수 없다. 이 사각지대가 sensor_tools·pos_tools·
bean_chatbot_tools·membership_tools·briefing_tools에서 네 번 반복됐다.

증상이 조용한 게 문제다 — 에러가 나지 않고, /chatbot/agents 헬스체크도
정상을 보고하며, 사장님만 "그 기능은 지원하지 않아요"를 듣는다.
그래서 이름 목록을 하드코딩하지 않고 런타임과 같은 경로
(tool_registry.get_all_tools / main_agent._module_tools)로 양쪽을 모아 비교한다.
"""
from app.services.ai.agents import main_agent
from app.services.ai.tool_registry import get_all_tools


def _registry_tool_names() -> set[str]:
    return {t.name for t in get_all_tools()}


def _domain_tool_names() -> set[str]:
    names: set[str] = set()
    for domain in main_agent._DOMAINS:
        for module_path in domain["modules"]:
            for t in main_agent._module_tools(module_path):
                names.add(t.name)
    return names


def test_every_registered_tool_is_assigned_to_an_expert():
    """레지스트리에 있는 도구는 반드시 어느 전문가든 하나가 들고 있어야 한다."""
    orphans = _registry_tool_names() - _domain_tool_names()
    assert not orphans, (
        f"챗봇이 부를 수 없는 도구가 있다: {sorted(orphans)} — "
        "main_agent._DOMAINS의 modules에 해당 모듈을 넣어야 한다"
    )


def test_no_expert_holds_an_unregistered_tool():
    """반대 방향 — 편성에만 있고 레지스트리에 없으면 도구 모듈 등록이 빠진 것이다."""
    missing = _domain_tool_names() - _registry_tool_names()
    assert not missing, (
        f"tool_registry._TOOL_MODULES에 빠진 모듈의 도구다: {sorted(missing)}"
    )


def test_every_expert_has_at_least_one_tool():
    """도구가 하나도 없는 전문가는 런타임에서 조용히 제외된다(_build_subagent가 None).

    편성표에는 이름이 남아 있어 '있는 기능'처럼 보이므로, 빈 도메인은 사고에 가깝다.
    """
    empty = [
        d["name"] for d in main_agent._DOMAINS
        if not any(main_agent._module_tools(m) for m in d["modules"])
    ]
    assert not empty, f"도구가 없어 비활성인 전문가: {empty}"


def test_tool_names_are_unique_across_experts():
    """같은 이름의 도구가 두 전문가에 걸쳐 있으면 위임 결과가 어느 쪽인지 알 수 없다."""
    seen: dict[str, str] = {}
    clashes: list[str] = []
    for domain in main_agent._DOMAINS:
        for module_path in domain["modules"]:
            for t in main_agent._module_tools(module_path):
                if t.name in seen and seen[t.name] != domain["name"]:
                    clashes.append(f"{t.name}: {seen[t.name]} / {domain['name']}")
                seen[t.name] = domain["name"]
    assert not clashes, f"여러 전문가에 중복 편성된 도구: {clashes}"
