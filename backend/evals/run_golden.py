"""골든 질문 회귀 테스트 러너 — 배포 전에 손으로 돌린다

    python -m evals.run_golden                  # 전부
    python -m evals.run_golden --only 매출,재고  # 분류만
    python -m evals.run_golden --id sales_yesterday
    python -m evals.run_golden --store other@cafe.com
    python -m evals.run_golden --json out.json  # 결과를 파일로 (이력 비교용)

[왜 pytest가 아닌가]
  · 질문 하나당 Gemini를 실제로 부른다 — 매 푸시마다 돌리면 팀 공유 무료 한도가 녹는다
  · 문항당 수 초씩 걸린다
  · 공유 Neon DB를 직접 쓰므로 병렬 실행이 금지다([[pytest-shared-db-no-parallel]])
  문항 파일이 상하지 않았는지(오타·없는 계산기)는 tests/test_golden_suite.py가 API 호출
  없이 확인하므로, 그쪽은 CI에서 매번 돈다.

[무엇을 잡는가]
  1) 골든 대조 — 이미 아는 오답의 재발. 정답은 채점 시점에 DB에서 계산한다.
  2) 감시 규칙 — 정답을 몰라도 걸리는 이상. 새로운 유형의 오답은 여기서 드러난다.
  3) 표현 불일치 — 같은 뜻의 두 표현이 다른 금액을 답하면 정답을 몰라도 버그 확정.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
from pathlib import Path
from typing import Any, Optional

if __package__ in (None, ""):  # `python evals/run_golden.py`로 직접 부른 경우
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from evals import checks, truth  # noqa: E402

SUITE_PATH = Path(__file__).with_name("golden.yaml")
# harvest.py가 운영 사고에서 수확해 쌓는 문항. 사람이 쓴 세트와 파일을 나눠 둔다 —
# 섞이면 손댈 문항을 찾기 어렵고, 통째로 되돌리기도 힘들다.
AUTO_SUITE_PATH = Path(__file__).with_name("golden.auto.yaml")

# 질문 사이에 쉬는 시간 — 무료 한도는 분당 요청 수로 걸리는데(모델별 15회), 한 턴이
# 메인+서브에이전트로 여러 번 호출하므로 실제로는 분당 서너 턴이 상한이다.
PACE_SECONDS = 5.0
# 429를 만났을 때 기다렸다 다시 묻는 횟수. 재시도하지 않으면 한도에 걸린 턴이 그대로
# 오답으로 집계되는데, 그건 챗봇 버그가 아니라 평가의 잡음이다 — 헛경보를 내는 회귀
# 도구는 결국 아무도 안 본다.
RATE_LIMIT_RETRIES = 2
RATE_LIMIT_WAIT = 35.0

PASS, FAIL, WARN = "PASS", "FAIL", "WARN"
_MARK = {PASS: "[ OK ]", FAIL: "[FAIL]", WARN: "[WARN]"}


# ---------------------------------------------------------------------------
# 도구 출력 캡처
#
# runtime_stats.TurnRecorder는 '어느 도구가 불렸나'까지만 남긴다(콘솔 표시가 목적이라
# 반환값은 안 들고 있다). 근거 없는 금액을 잡으려면 도구가 무엇을 돌려줬는지가 필요해서,
# 러너에서만 _bind_store를 한 겹 더 감싼다 — 운영 코드에는 평가용 훅을 넣지 않는다.
# ---------------------------------------------------------------------------

_captured: list[str] = []


def _install_capture() -> None:
    from langchain_core.tools import StructuredTool

    from app.services.ai.agents import main_agent

    if getattr(main_agent._bind_store, "_eval_wrapped", False):
        return
    original = main_agent._bind_store

    def wrapped(t, store_id, created_docs, recorder=None):
        bound = original(t, store_id, created_docs, recorder)
        # args_schema가 없는 도구는 운영 코드도 다시 감싸지 않는다 — 여기서도 그대로 둔다
        if getattr(bound, "args_schema", None) is None:
            return bound

        def _run(**kwargs):
            out = bound.invoke(kwargs)
            _captured.append(str(out))
            return out

        async def _arun(**kwargs):
            out = await bound.ainvoke(kwargs)
            _captured.append(str(out))
            return out

        return StructuredTool(name=bound.name, description=bound.description,
                              args_schema=bound.args_schema, func=_run, coroutine=_arun)

    wrapped._eval_wrapped = True
    main_agent._bind_store = wrapped


# ---------------------------------------------------------------------------
# 한 턴 실행
# ---------------------------------------------------------------------------

class QuotaExhausted(RuntimeError):
    """오늘 쓸 수 있는 무료 한도를 다 썼다 — 남은 문항을 오답으로 기록하지 말고 멈춘다."""


async def _ask_once(question: str, store_id: str, expects_data: bool) -> dict[str, Any]:
    """질문 하나를 실제 챗봇에 던지고, 답변·호출된 도구·전문가·도구 출력을 모아 온다."""
    from app.services.ai.agents import main_agent, runtime_stats

    _captured.clear()
    started = time.perf_counter()
    result = await main_agent.generate_response(question, store_id)
    ms = (time.perf_counter() - started) * 1000

    # 방금 턴의 계측을 runtime_stats에서 되찾는다. 문항을 순차로 돌리므로 맨 앞이 방금 턴이지만,
    # 질문이 어긋나면(다른 경로에서 턴이 끼어들면) 계측 없이 진행한다 — 엉뚱한 턴의 도구
    # 목록으로 채점하면 없는 버그를 만들어 낸다.
    tools: list[str] = []
    experts: list[str] = []
    reason = ""
    recent = runtime_stats.snapshot().get("recent", [])
    if recent and question.startswith((recent[0].get("question") or "").rstrip("…")[:20]):
        tools = list(recent[0].get("tools") or [])
        experts = list(recent[0].get("experts") or [])
        reason = str(recent[0].get("reason") or "")

    return {
        "question": question,
        "answer": result.get("text", ""),
        "ok": bool(result.get("ok")),
        "reason": reason,
        "tools": tools,
        "experts": experts,
        "tool_output": "\n".join(_captured),
        "ms": ms,
        "expects_data": expects_data,
    }


async def _ask(question: str, store_id: str, expects_data: bool) -> dict[str, Any]:
    """_ask_once에 한도 대응을 씌운 것.

    분당 제한(429)은 기다렸다 다시 묻는다 — 그 턴의 답변("질문이 잠깐 몰려서…")을 그대로
    채점하면 정답이 없으니 무조건 오답이 되고, 리포트가 가짜 실패로 뒤덮인다.
    일일 한도 소진은 재시도해도 소용없으므로 즉시 중단한다.
    """
    for attempt in range(RATE_LIMIT_RETRIES + 1):
        turn = await _ask_once(question, store_id, expects_data)
        if turn["reason"] == "quota":
            raise QuotaExhausted(
                "오늘 쓸 수 있는 AI 무료 한도를 다 썼습니다. 남은 문항은 평가하지 않습니다.")
        if turn["reason"] == "db":
            raise QuotaExhausted("매장 데이터베이스에 연결할 수 없어 평가를 진행할 수 없습니다.")
        if turn["reason"] != "rate_limit":
            return turn
        if attempt < RATE_LIMIT_RETRIES:
            print(f"        . 분당 한도 — {RATE_LIMIT_WAIT:.0f}초 쉬고 다시 묻습니다 "
                  f"({attempt + 1}/{RATE_LIMIT_RETRIES})")
            await asyncio.sleep(RATE_LIMIT_WAIT)
    return turn


# ---------------------------------------------------------------------------
# 채점
# ---------------------------------------------------------------------------

def _grade_conditions(turn: dict[str, Any], conditions: dict[str, Any],
                      expected: Any = None) -> list[str]:
    """라우팅 조건 채점 — 정답을 몰라도 판정할 수 있어서 탐색 문항에도 그대로 적용된다.

    "홍보 문구 써줘"에 marketing_expert가 안 불렸다면, 답변 문구가 그럴듯한지와 무관하게
    잘못이다 — 도구를 거치지 않으면 홍보물이 저장되지도, 채팅에 카드로 뜨지도 않는다.
    실제로 이 규칙이 없을 때 그 사고가 통과로 잡혔다.
    """
    answer = turn["answer"]
    problems: list[str] = []

    for phrase in conditions.get("금지문구") or []:
        # 정답이 0이면 '기록이 없다'가 옳은 답이라 금지문구 검사를 건너뛴다
        if expected == 0:
            break
        if phrase in answer:
            problems.append(f"금지 문구 '{phrase}' 포함")

    for name in conditions.get("도구") or []:
        if name not in turn["tools"]:
            problems.append(f"도구 {name}를 부르지 않음 (부른 것: {turn['tools'] or '없음'})")

    wanted_experts = conditions.get("전문가") or []
    if wanted_experts and not any(e in turn["experts"] for e in wanted_experts):
        problems.append(f"전문가 {wanted_experts} 중 아무도 안 불림 "
                        f"(부른 것: {turn['experts'] or '없음'})")
    return problems


def _grade_expected(turn: dict[str, Any], expected: Any) -> list[str]:
    """정답 대조 — 실패 사유 목록을 준다 (빈 목록이면 통과)."""
    answer = turn["answer"]
    problems: list[str] = []

    if isinstance(expected, str):
        if not checks.contains_text(answer, expected):
            problems.append(f"정답 '{expected}'이 답변에 없음")
    elif expected == 0:
        # 정답이 0이면 "없다"가 옳은 답이다. 숫자 0을 요구하면 정상 답을 오답으로 잡는다.
        if not (checks.contains_number(answer, 0) or "없" in answer):
            problems.append("정답이 0인데 '없다'는 취지의 답이 아님")
    elif not checks.contains_number(answer, expected):
        got = sorted(n for n in checks.extract_numbers(answer) if n >= checks.NUMERIC_FLOOR)
        problems.append(f"정답 {expected:,}이 답변에 없음 (답변 속 숫자: {got[:5]})")
    return problems


async def _run_item(item: dict[str, Any], store_id: str, is_golden: bool) -> dict[str, Any]:
    """문항 하나 — 표현 여러 개를 각각 물어보고 합산한다."""
    questions = item["질문"]
    expects_data = bool(item.get("데이터질문"))
    conditions = item.get("통과") or {}

    expected: Any = None
    truth_error: Optional[str] = None
    if is_golden:
        try:
            expected = truth.resolve(item["정답"], store_id)
        except truth.TruthError as e:
            truth_error = str(e)

    runs = []
    for idx, question in enumerate(questions):
        if idx:
            await asyncio.sleep(PACE_SECONDS)
        turn = await _ask(question, store_id, expects_data)
        # 재시도까지 하고도 한도에 걸린 턴은 채점하지 않는다 — 답변이 안내 문구라 무조건
        # 오답이 되고, 그건 챗봇이 아니라 한도에 대한 기록이다
        if turn["reason"] == "rate_limit":
            runs.append({**turn, "problems": [], "warnings": [], "skipped": True})
            continue
        watched = checks.run_watchers(turn)
        # 라우팅 조건은 골든·탐색 모두에 적용된다 (정답을 몰라도 판정 가능)
        problems = _grade_conditions(turn, conditions, expected)
        if is_golden and not truth_error:
            problems += _grade_expected(turn, expected)
        problems += [f"[{n}] {msg}" for n, level, msg in watched if level == FAIL.lower()]
        warnings = [f"[{n}] {msg}" for n, level, msg in watched if level == WARN.lower()]
        runs.append({**turn, "problems": problems, "warnings": warnings, "skipped": False})

    graded = [r for r in runs if not r["skipped"]]
    skipped = len(runs) - len(graded)

    # 정답을 몰라도 잡히는 버그 — 표현마다 답이 다르면 적어도 하나는 틀렸다
    disagreement = checks.paraphrase_disagreement([r["answer"] for r in graded])
    if disagreement:
        for r in graded:
            r["problems"] = r["problems"] + [f"[표현불일치] {disagreement}"]

    passed = sum(1 for r in graded if not r["problems"])
    if not graded or truth_error:
        status = WARN
    elif passed == len(graded):
        status = PASS if not any(r["warnings"] for r in graded) else WARN
    else:
        status = FAIL

    return {
        "id": item["id"],
        "분류": item.get("분류", "-"),
        "golden": is_golden,
        "status": status,
        "passed": passed,
        "total": len(graded),
        "skipped": skipped,
        "expected": expected,
        "truth_error": truth_error,
        "runs": runs,
    }


# ---------------------------------------------------------------------------
# 출력
# ---------------------------------------------------------------------------

def _print_item(result: dict[str, Any]) -> None:
    head = f"{_MARK[result['status']]} {result['id']:<20} {result['passed']}/{result['total']}"
    if result.get("skipped"):
        head += f" (+{result['skipped']} 한도로 건너뜀)"
    if result["truth_error"]:
        print(f"{head}  정답 계산 실패 — {result['truth_error']}")
        return
    if not result["runs"] or all(r.get("skipped") for r in result["runs"]):
        print(f"{head}  전부 분당 한도에 걸려 채점하지 못함")
        return
    if result["expected"] is not None:
        expected = result["expected"]
        head += f"  정답={expected:,}" if isinstance(expected, int) else f"  정답={expected}"
    first = result["runs"][0]
    trail = " · ".join(filter(None, [
        ",".join(first["experts"]) or "위임없음",
        ",".join(first["tools"][:3]),
        f"{first['ms'] / 1000:.1f}s",
    ]))
    print(f"{head}  {trail}")
    for run in result["runs"]:
        for problem in run["problems"]:
            print(f"        X {run['question']}  →  {problem}")
        for warning in run["warnings"]:
            print(f"        ! {run['question']}  →  {warning}")


def _print_summary(results: list[dict[str, Any]], elapsed: float) -> None:
    total_runs = sum(r["total"] for r in results)
    passed_runs = sum(r["passed"] for r in results)
    skipped_runs = sum(r.get("skipped", 0) for r in results)
    failed = [r for r in results if r["status"] == FAIL]
    warned = [r for r in results if r["status"] == WARN]

    print("\n" + "=" * 72)
    rate = (passed_runs / total_runs * 100) if total_runs else 0.0
    line = f"통과 {passed_runs}/{total_runs} ({rate:.1f}%) · 문항 {len(results)}개 · {elapsed:.0f}초"
    if skipped_runs:
        line += f" · 한도로 건너뛴 질문 {skipped_runs}개"
    print(line)
    if failed:
        print("실패:", ", ".join(r["id"] for r in failed))
    if warned:
        print("확인 필요:", ", ".join(r["id"] for r in warned))
    if not failed and not warned:
        print("모든 문항 통과.")
    print("=" * 72)


# ---------------------------------------------------------------------------

def load_suite(path: Path = SUITE_PATH) -> dict[str, Any]:
    """문항 파일을 읽는다. PyYAML은 langchain-core의 필수 의존성이라 항상 있다."""
    import yaml

    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{path.name}의 최상위는 매핑이어야 한다")
    return data


async def _main_async(args: argparse.Namespace) -> int:
    suite = load_suite()
    store_id = args.store or suite.get("매장")
    if not store_id:
        print("매장이 지정되지 않았습니다 (golden.yaml의 `매장:` 또는 --store)")
        return 2

    items: list[tuple[dict[str, Any], bool]] = (
        [(i, True) for i in suite.get("골든") or []]
        + [(i, False) for i in suite.get("탐색") or []]
    )
    # 자동 수확 문항도 같이 돈다 (--no-auto로 뺄 수 있다)
    if AUTO_SUITE_PATH.exists() and not args.no_auto:
        auto = load_suite(AUTO_SUITE_PATH)
        auto_items = ([(i, True) for i in auto.get("골든") or []]
                      + [(i, False) for i in auto.get("탐색") or []])
        items += auto_items
        if auto_items:
            print(f"(자동 수확 문항 {len(auto_items)}개 포함)")
    if args.id:
        wanted = {s.strip() for s in args.id.split(",")}
        items = [(i, g) for i, g in items if i["id"] in wanted]
    if args.only:
        wanted = {s.strip() for s in args.only.split(",")}
        items = [(i, g) for i, g in items if i.get("분류") in wanted]
    if args.golden_only:
        items = [(i, g) for i, g in items if g]
    if not items:
        print("조건에 맞는 문항이 없습니다.")
        return 2

    turns = sum(len(i["질문"]) for i, _ in items)
    print(f"매장 {store_id} · 문항 {len(items)}개 · 실제 호출 {turns}회\n")
    _install_capture()

    started = time.perf_counter()
    results = []
    aborted = ""
    for item, is_golden in items:
        try:
            result = await _run_item(item, store_id, is_golden)
        except QuotaExhausted as e:
            aborted = str(e)
            break
        results.append(result)
        _print_item(result)
    elapsed = time.perf_counter() - started

    if aborted:
        print(f"\n중단: {aborted}")
    if not results:
        print("채점한 문항이 없습니다.")
        return 2

    _print_summary(results, elapsed)
    if aborted:
        print(f"({len(items) - len(results)}개 문항은 실행하지 못했습니다)")

    if args.json:
        Path(args.json).write_text(
            json.dumps({"store_id": store_id, "results": results}, ensure_ascii=False, indent=2),
            encoding="utf-8")
        print(f"결과 저장: {args.json}")

    return 1 if any(r["status"] == FAIL for r in results) else 0


def main() -> int:
    global PACE_SECONDS

    # 윈도우 콘솔 기본 코드페이지(cp949)로는 이 표가 깨져 나온다 — 결과를 못 읽으면 소용없다
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except Exception:
            pass

    parser = argparse.ArgumentParser(description="챗봇 골든 질문 회귀 테스트")
    parser.add_argument("--store", default="", help="평가할 매장 (기본: golden.yaml의 매장)")
    parser.add_argument("--only", default="", help="분류만 골라 실행 (쉼표 구분)")
    parser.add_argument("--id", default="", help="문항 id만 골라 실행 (쉼표 구분)")
    parser.add_argument("--golden-only", action="store_true", help="탐색 문항은 빼고 실행")
    parser.add_argument("--no-auto", action="store_true",
                        help="자동 수확 문항(golden.auto.yaml)은 빼고 실행")
    parser.add_argument("--json", default="", help="결과를 JSON 파일로 저장")
    parser.add_argument("--pace", type=float, default=PACE_SECONDS,
                        help=f"질문 사이 대기 초 (기본 {PACE_SECONDS:.0f}). 429가 잦으면 늘린다")
    args = parser.parse_args()
    PACE_SECONDS = max(0.0, args.pace)
    return asyncio.run(_main_async(args))


if __name__ == "__main__":
    raise SystemExit(main())
