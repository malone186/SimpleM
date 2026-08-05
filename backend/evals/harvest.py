"""사고 후보 수확 — 재현 검증 후 골든 세트에 자동 등록

    python -m evals.harvest              # pending 후보를 재현해 보고 등록까지
    python -m evals.harvest --dry-run    # 등록은 하지 않고 판정만
    python -m evals.harvest --limit 5

[흐름]
    운영 대화 → answer_audit이 감시 규칙·사장님 부정 반응으로 사고 후보 적재(chat_incidents)
             → (여기) 평가 매장에서 그 질문을 다시 물어 재현되는지 확인
             → 재현되면 golden.auto.yaml에 문항으로 등록 (status=registered)
             → 재현 안 되면 기각 (status=rejected)

[왜 재현 검증을 거치는가] 감시 규칙에는 오탐이 있고, 분당 한도·외부 API 실패처럼 챗봇
잘못이 아닌 사고도 섞인다. 검증 없이 등록하면 골든 세트가 쓰레기 문항으로 차서, 통과율이
의미를 잃고 결국 아무도 안 본다. 두 번 물어 한 번이라도 같은 규칙을 다시 어겨야 등록한다.

[자동 등록의 경계 — 정직하게]
  · 감시 규칙형 사고(마크다운 노출·조회 없이 숫자·거절 등)는 완전 자동 등록된다.
    감시 규칙은 모든 답변에 자동 적용되므로, 질문만 등록해 두면 재발 시 다시 잡힌다.
  · '사장님부정'형은 무엇이 정답인지 기계가 알 수 없다. 질문만 등록하고 통과 조건은
    비워 둔다 — 사람이 나중에 `정답:`이나 `통과: 전문가:`를 한 줄 채우면 강해진다.
    파일에 그렇게 표시해 둔다(TODO 주석).
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path
from typing import Any

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from evals import checks  # noqa: E402
from evals.run_golden import (  # noqa: E402
    AUTO_SUITE_PATH, QuotaExhausted, _ask, _install_capture, load_suite,
)

# 후보 하나당 다시 물어보는 횟수. 1회로는 우연히 통과할 수 있고, 3회는 한도가 아깝다.
REPLAY_TIMES = 2
# 한 번 실행에서 처리할 후보 상한 — 무료 한도를 한 번에 태우지 않게
DEFAULT_LIMIT = 10
PACE_SECONDS = 20.0


def _load_auto_ids() -> set[str]:
    """이미 등록된 문항 id — 같은 사고를 두 번 등록하지 않는다."""
    ids: set[str] = set()
    for path in (Path(__file__).with_name("golden.yaml"), AUTO_SUITE_PATH):
        if not path.exists():
            continue
        suite = load_suite(path)
        for section in ("골든", "탐색"):
            for item in suite.get(section) or []:
                ids.add(item["id"])
    return ids


def _item_id(incident: dict[str, Any], taken: set[str]) -> str:
    """문항 id를 만든다 — 사람이 파일에서 읽고 알아볼 수 있게 규칙+번호로."""
    base = f"auto_{incident['rule']}_{incident['id']}"
    candidate = base
    n = 2
    while candidate in taken:
        candidate = f"{base}_{n}"
        n += 1
    return candidate


def _append_item(incident: dict[str, Any], item_id: str, verdict: str) -> None:
    """golden.auto.yaml에 문항 한 개를 덧붙인다.

    사람이 쓴 golden.yaml과 파일을 나눈 이유: 기계가 쌓은 문항이 섞이면 사람이 손댈
    문항을 찾기 어려워지고, 통째로 되돌리기도 힘들어진다.
    """
    question = incident["question"].replace('"', "'")
    lines = [""]
    if not AUTO_SUITE_PATH.exists():
        lines = [
            "# 자동 등록 문항 — evals/harvest.py가 운영 사고에서 수확한 것",
            "#",
            "# 손으로 고쳐도 되지만, 새 문항은 harvest가 여기 덧붙인다.",
            "# 사람이 정리한 문항은 golden.yaml에 둔다.",
            "",
            "매장: s@gmail.com",
            "",
            "탐색:",
        ]
    lines += [
        f"  - id: {item_id}",
        f"    분류: 자동수확",
        f"    # {incident['rule']} · 운영에서 {incident['hits']}회 · 재현 {verdict}",
        f"    #   {incident['detail'] or ''}".rstrip(),
    ]
    if incident["rule"] == "사장님부정":
        lines.append("    # TODO 정답을 아는 사람이 `정답:` 또는 `통과: 전문가:`를 채우면 더 강해진다")
    lines += [
        "    질문:",
        f'      - "{question}"',
        "    데이터질문: true",
    ]
    # 사고 당시 어느 전문가가 처리했는지 알면 라우팅 기대로 굳혀 둔다
    if incident["experts"] and incident["rule"] != "사장님부정":
        lines += ["    통과:", f"      전문가: [{incident['experts'][0]}]"]

    with AUTO_SUITE_PATH.open("a", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")


async def _replay(incident: dict[str, Any], store_id: str) -> tuple[bool, str]:
    """후보 질문을 다시 물어 같은 규칙을 또 어기는지 본다. (재현여부, 설명)"""
    rule = incident["rule"]
    for attempt in range(REPLAY_TIMES):
        if attempt:
            await asyncio.sleep(PACE_SECONDS)
        turn = await _ask(incident["question"], store_id, expects_data=True)
        if turn["reason"] == "rate_limit":
            return (False, "분당 한도로 확인 실패 — 다음 실행에서 다시 시도")
        hits = {name for name, level, _ in checks.run_watchers(turn) if level == "fail"}
        if rule == "사장님부정":
            # 무엇이 정답인지 모르므로, 감시 규칙 중 아무거나 걸리면 재현으로 본다.
            # 아무것도 안 걸리면 '기계가 판단할 수 없음'이라 등록하지 않는다.
            if hits:
                return (True, f"재현({', '.join(sorted(hits))})")
        elif rule in hits:
            return (True, "재현")
    return (False, "재현되지 않음")


async def _main_async(args: argparse.Namespace) -> int:
    from app.services.ai import answer_audit

    suite = load_suite()
    store_id = args.store or suite.get("매장")
    if not store_id:
        print("평가 매장을 알 수 없습니다 (golden.yaml의 `매장:` 또는 --store)")
        return 2

    incidents = answer_audit.list_incidents(status="pending", limit=args.limit)
    if not incidents:
        print("재현해 볼 사고 후보가 없습니다.")
        return 0

    print(f"사고 후보 {len(incidents)}건 · 평가 매장 {store_id}"
          f"{' · 모의 실행' if args.dry_run else ''}\n")
    _install_capture()
    taken = _load_auto_ids()
    registered = rejected = held = 0

    for incident in incidents:
        label = f"[{incident['rule']}] {incident['question'][:40]}"
        try:
            reproduced, note = await _replay(incident, store_id)
        except QuotaExhausted as e:
            # 한도 소진·DB 다운은 후보의 잘못이 아니다. 상태를 건드리지 않고 멈춘다 —
            # 여기서 기각으로 찍으면 진짜 버그가 조용히 세트에서 빠진다.
            print(f"  중단 {label}  →  {e}")
            print(f"\n남은 {len(incidents) - registered - rejected - held}건은 "
                  f"다음 실행에서 그대로 다시 시도합니다.")
            break
        if not reproduced:
            if "한도" in note:
                held += 1
                print(f"  ...  {label}  →  {note}")
                continue
            rejected += 1
            print(f"  기각 {label}  →  {note}")
            if not args.dry_run:
                answer_audit.set_status(incident["id"], "rejected", note)
            continue

        item_id = _item_id(incident, taken)
        taken.add(item_id)
        registered += 1
        print(f"  등록 {label}  →  {note} · {item_id}")
        if not args.dry_run:
            _append_item(incident, item_id, note)
            answer_audit.set_status(incident["id"], "registered", note)
        await asyncio.sleep(PACE_SECONDS)

    print(f"\n등록 {registered}건 · 기각 {rejected}건 · 보류 {held}건")
    if registered and not args.dry_run:
        print(f"→ {AUTO_SUITE_PATH.name}에 추가됨. 다음 `python -m evals.run_golden`부터 함께 돕니다.")
    return 0


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except Exception:
            pass

    parser = argparse.ArgumentParser(description="운영 사고 후보를 재현 검증해 골든 세트에 등록")
    parser.add_argument("--store", default="", help="재현에 쓸 평가 매장")
    parser.add_argument("--limit", type=int, default=DEFAULT_LIMIT, help="한 번에 처리할 후보 수")
    parser.add_argument("--dry-run", action="store_true", help="판정만 하고 등록하지 않는다")
    return asyncio.run(_main_async(parser.parse_args()))


if __name__ == "__main__":
    raise SystemExit(main())
