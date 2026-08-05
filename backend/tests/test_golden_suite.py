"""골든 문항 파일이 상하지 않았는지 검증 (백엔드 B) — API 호출 없음

러너(evals/run_golden.py)는 실제 Gemini를 부르므로 CI에서 못 돌린다. 그러면 문항 파일의
오타는 배포 직전에야 발견되는데, 하필 그때는 "챗봇이 틀렸나, 문항이 틀렸나"를 가려내느라
시간을 쓰게 된다. 그래서 파일 구조와 정답 표현 파싱만 여기서 매번 확인한다.

여기서 걸리는 것: 없는 계산기 이름, 인자 오타, id 중복, 질문 없는 문항, 골든인데 정답 없음.
여기서 안 걸리는 것: 챗봇이 실제로 맞게 답하는가 (그건 러너의 일).
"""
import pytest

from evals import checks, truth
from evals.run_golden import load_suite


@pytest.fixture(scope="module")
def suite():
    return load_suite()


def _all_items(suite) -> list[tuple[str, dict, bool]]:
    return ([("골든", i, True) for i in suite.get("골든") or []]
            + [("탐색", i, False) for i in suite.get("탐색") or []])


def test_suite_has_store_and_items(suite):
    assert suite.get("매장"), "golden.yaml에 평가 대상 매장이 없다"
    assert _all_items(suite), "문항이 하나도 없다"


def test_item_ids_are_unique(suite):
    ids = [i["id"] for _, i, _ in _all_items(suite)]
    duplicates = {x for x in ids if ids.count(x) > 1}
    assert not duplicates, f"id가 중복된 문항: {duplicates}"


def test_every_item_has_questions(suite):
    for section, item, _ in _all_items(suite):
        questions = item.get("질문")
        assert questions, f"[{section}] {item.get('id')}: 질문이 없다"
        assert all(q.strip() for q in questions), f"{item['id']}: 빈 질문이 있다"


def test_golden_items_have_parsable_truth_spec(suite):
    """정답 표현이 실제 계산기와 인자 형태에 맞는가 — DB도 API도 건드리지 않고 파싱만."""
    for _, item, is_golden in _all_items(suite):
        if not is_golden:
            continue
        spec = item.get("정답")
        assert spec, f"{item['id']}: 골든 문항인데 정답 표현이 없다"
        name, kwargs = truth.parse_spec(spec)  # 이름이 틀리면 TruthError로 여기서 넘어진다
        assert name in truth.CALCULATORS
        assert isinstance(kwargs, dict)


def test_probe_items_have_no_truth_spec(suite):
    """탐색 문항에 정답을 적어 두면 채점되지 않아 조용히 무시된다 — 헷갈리게 두지 않는다."""
    for _, item, is_golden in _all_items(suite):
        if not is_golden:
            assert "정답" not in item, (
                f"{item['id']}: 탐색 문항에는 정답을 적지 않는다 (골든으로 옮길 것)")


def test_pass_conditions_use_known_expert_names(suite):
    """`통과: 전문가:`에 오타가 있으면 영영 통과하지 못하는 문항이 된다."""
    from app.services.ai.agents.main_agent import _DOMAINS

    known = {d["name"] for d in _DOMAINS}
    for _, item, _ in _all_items(suite):
        for name in (item.get("통과") or {}).get("전문가") or []:
            assert name in known, f"{item['id']}: '{name}'라는 전문가는 편성에 없다"


def test_pass_conditions_use_registered_tool_names(suite):
    """`통과: 도구:`도 마찬가지 — 등록된 도구 이름이어야 한다."""
    from app.services.ai.tool_registry import get_all_tools

    known = {t.name for t in get_all_tools()}
    for _, item, _ in _all_items(suite):
        for name in (item.get("통과") or {}).get("도구") or []:
            assert name in known, f"{item['id']}: '{name}'라는 도구는 등록돼 있지 않다"


# ---------------------------------------------------------------------------
# 채점 규칙 자체의 검증 — 채점기가 틀리면 멀쩡한 답을 오답으로 잡는다
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("text,expected", [
    ("어제 매출은 24,600원입니다", 24600),
    ("어제 매출은 24600원입니다", 24600),
    ("어제 매출은 2만 4,600원입니다", 24600),
    ("어제 매출은 2만4600원이에요", 24600),
    ("총 3만원 나왔습니다", 30000),
    ("1억 2000만원", 120000000),
])
def test_number_extraction_handles_korean_notation(text, expected):
    """모델은 같은 금액을 여러 표기로 쓴다 — 표기 차이로 정답이 오답이 되면 안 된다."""
    assert checks.contains_number(text, expected), f"{text!r}에서 {expected}를 못 찾았다"


def test_number_extraction_rejects_wrong_value():
    assert not checks.contains_number("어제 매출은 24,600원입니다", 31200)


def test_watcher_catches_markdown_leak():
    hits = checks.run_watchers({"answer": "**어제 매출**은 24,600원입니다", "tools": ["x"]})
    assert any(name == "마크다운노출" and level == "fail" for name, level, _ in hits)


def test_watcher_catches_internal_key_leak():
    hits = checks.run_watchers({"answer": "total_revenue는 24600입니다", "tools": ["x"]})
    assert any(name == "내부값노출" and level == "fail" for name, level, _ in hits)


def test_watcher_catches_number_without_any_tool_call():
    """조회 없이 금액을 답하는 것 — 가장 강한 환각 신호."""
    hits = checks.run_watchers(
        {"answer": "어제 매출은 24,600원입니다", "tools": [], "expects_data": True})
    assert any(name == "무근거숫자" and level == "fail" for name, level, _ in hits)


def test_watcher_allows_greeting_without_tools():
    """일상 대화는 도구를 안 불러도 정상 — 여기서 걸리면 러너가 온통 거짓 실패로 덮인다."""
    hits = checks.run_watchers(
        {"answer": "안녕하세요 사장님. 무엇을 도와드릴까요?", "tools": [], "expects_data": False})
    assert not [h for h in hits if h[1] == "fail"]


def test_watcher_flags_number_missing_from_tool_output():
    hits = checks.run_watchers({
        "answer": "어제 매출은 99,900원입니다",
        "tools": ["get_sales_history"],
        "tool_output": '{"total_revenue": 24600}',
        "expects_data": True,
    })
    assert any(name == "근거없는금액" and level == "warn" for name, level, _ in hits)


def test_watcher_catches_refusal_without_trying():
    hits = checks.run_watchers(
        {"answer": "그 기능은 지원하지 않는 기능입니다.", "tools": [], "expects_data": False})
    assert any(name == "거절" and level == "fail" for name, level, _ in hits)


def test_paraphrase_disagreement_detected_without_truth():
    """정답을 몰라도 버그를 확정할 수 있는 규칙."""
    assert checks.paraphrase_disagreement(
        ["어제 매출은 24,600원입니다", "어제 매출은 31,200원입니다"])
    assert not checks.paraphrase_disagreement(
        ["어제 매출은 24,600원입니다", "어제는 24600원 팔았어요"])


# ---------------------------------------------------------------------------
# 자동 수확 — harvest가 만든 문항이 실제로 읽히는 YAML인가
#
# 여기가 깨지면 조용히 망가진다: harvest는 "등록 3건"이라 보고하는데 다음 러너 실행이
# 파싱 에러로 통째로 죽는다. 사고에서 수확한 문항을 통째로 잃는다.
# ---------------------------------------------------------------------------

def test_harvested_item_is_valid_yaml(tmp_path, monkeypatch):
    from evals import harvest, run_golden

    target = tmp_path / "golden.auto.yaml"
    monkeypatch.setattr(harvest, "AUTO_SUITE_PATH", target)

    incident = {
        "id": 7,
        "question": '어제 "매출" 얼마야?',   # 큰따옴표가 섞여도 깨지지 않아야 한다
        "rule": "무근거숫자",
        "detail": "도구를 하나도 안 부르고 숫자를 답함: [159000]",
        "hits": 3,
        "experts": ["data_expert"],
    }
    harvest._append_item(incident, "auto_무근거숫자_7", "재현")
    harvest._append_item({**incident, "id": 8, "rule": "사장님부정", "experts": []},
                         "auto_사장님부정_8", "재현(마크다운노출)")

    suite = run_golden.load_suite(target)
    items = suite.get("탐색") or []
    assert len(items) == 2
    assert suite.get("매장")
    assert items[0]["id"] == "auto_무근거숫자_7"
    assert items[0]["질문"] == ['어제 \'매출\' 얼마야?']
    assert items[0]["통과"]["전문가"] == ["data_expert"]
    # 정답을 모르는 유형은 통과 조건을 비워 두고 사람이 채우게 표시한다
    assert "통과" not in items[1]
