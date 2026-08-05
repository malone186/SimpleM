"""챗봇 실행 계측 (백엔드 B) — '지금 에이전트가 어떻게 돌아가는지'를 숫자로 남긴다

관리자 콘솔의 AI 에이전트 탭은 그동안 편성표(전문가·도구 목록)만 보여 줬다. 구성은
코드를 보면 알 수 있는 것이고, 정작 궁금한 건 "실제로 돌고는 있나, 얼마나 걸리나,
어디서 실패하나"다. 그래서 대화 한 턴이 끝날 때마다 여기에 기록한다.

저장은 프로세스 메모리다 — DB에 쓰면 대화 한 턴마다 왕복이 붙고(Neon RTT), 실패해도
챗봇을 방해하면 안 되는 부가 기능이라 그만한 값어치가 없다. 대신 '서버 시작 이후'
기준이라는 걸 응답에 함께 실어 보내, 콘솔이 그렇게 표시하게 한다.

이 모듈의 어떤 함수도 예외를 밖으로 내보내지 않는다. 계측이 대화를 죽이면 본말전도다.
"""

from __future__ import annotations

import logging
import threading
from collections import Counter, deque
from datetime import datetime, timedelta, timezone
from typing import Any

logger = logging.getLogger(__name__)

KST = timezone(timedelta(hours=9))

# 최근 실행 로그 보관 개수 — 콘솔 표에 그대로 뿌린다
MAX_RECENT = 20
# 평균·중앙값을 낼 표본 (오래된 건 밀어낸다)
MAX_SAMPLES = 300

_LOCK = threading.Lock()
_STARTED_AT = datetime.now(KST)

# 실패 사유 코드 → 콘솔 표시 문구
REASON_LABEL = {
    "ok": "정상",
    "no_api_key": "API 키 없음",
    "no_expert": "활성 전문가 없음",
    "empty": "빈 답변",
    "quota": "무료 한도 소진",
    "rate_limit": "분당 요청 제한",
    "db": "DB 연결 실패",
    "error": "실행 오류",
}

_turns = 0
_ok = 0
_samples: deque[float] = deque(maxlen=MAX_SAMPLES)
_reasons: Counter = Counter()
_experts: dict[str, dict[str, float]] = {}
_tools: dict[str, dict[str, int]] = {}
_recent: deque[dict[str, Any]] = deque(maxlen=MAX_RECENT)


class TurnRecorder:
    """대화 한 턴 동안 어느 전문가·도구가 불렸는지 모으는 수집기.

    턴마다 새로 만들어 generate_response가 들고 다닌다 — 동시에 여러 대화가 돌아도
    서로 섞이지 않는다(전역 카운터만 잠금으로 보호하면 된다).
    """

    __slots__ = ("experts", "tools", "tool_failures")

    def __init__(self) -> None:
        self.experts: list[str] = []
        self.tools: list[str] = []
        self.tool_failures: int = 0

    def expert_called(self, name: str, ms: float, ok: bool = True) -> None:
        try:
            self.experts.append(name)
            with _LOCK:
                slot = _experts.setdefault(name, {"calls": 0, "failures": 0, "total_ms": 0.0})
                slot["calls"] += 1
                slot["total_ms"] += ms
                if not ok:
                    slot["failures"] += 1
        except Exception:  # 계측 실패가 대화를 막지 않는다
            logger.debug("전문가 호출 기록 실패", exc_info=True)

    def tool_called(self, name: str, ok: bool = True) -> None:
        try:
            self.tools.append(name)
            if not ok:
                self.tool_failures += 1
            with _LOCK:
                slot = _tools.setdefault(name, {"calls": 0, "failures": 0})
                slot["calls"] += 1
                if not ok:
                    slot["failures"] += 1
        except Exception:
            logger.debug("도구 호출 기록 실패", exc_info=True)


def record_turn(store_id: str, ms: float, reason: str, recorder: TurnRecorder | None = None,
                question: str = "") -> None:
    """대화 한 턴의 결과를 남긴다. reason='ok'면 성공, 나머지는 실패 사유 코드."""
    global _turns, _ok
    try:
        rec = recorder or TurnRecorder()
        with _LOCK:
            _turns += 1
            if reason == "ok":
                _ok += 1
            _samples.append(float(ms))
            _reasons[reason] += 1
            _recent.appendleft({
                "at": datetime.now(KST).strftime("%m-%d %H:%M:%S"),
                "store_id": store_id or "-",
                "ms": round(float(ms)),
                "ok": reason == "ok",
                "reason": reason,
                "reason_label": REASON_LABEL.get(reason, reason),
                # 무엇을 물었길래 이렇게 걸렸는지/실패했는지가 보여야 원인을 좁힐 수 있다
                "question": (question[:60] + "…") if len(question) > 60 else question,
                "experts": list(dict.fromkeys(rec.experts)),
                "tools": list(dict.fromkeys(rec.tools)),
                "tool_calls": len(rec.tools),
            })
    except Exception:
        logger.debug("턴 기록 실패", exc_info=True)


def _percentile(values: list[float], pct: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    idx = min(len(ordered) - 1, int(round((len(ordered) - 1) * pct)))
    return ordered[idx]


def snapshot() -> dict[str, Any]:
    """콘솔이 그리는 실행 현황 한 벌. 아직 한 번도 안 돌았으면 turns=0으로 온다."""
    try:
        with _LOCK:
            samples = list(_samples)
            experts = [
                {
                    "name": name,
                    "calls": int(v["calls"]),
                    "failures": int(v["failures"]),
                    "avg_ms": round(v["total_ms"] / v["calls"]) if v["calls"] else 0,
                }
                for name, v in _experts.items()
            ]
            tools = [
                {"name": name, "calls": int(v["calls"]), "failures": int(v["failures"])}
                for name, v in _tools.items()
            ]
            reasons = [
                {"reason": r, "label": REASON_LABEL.get(r, r), "count": c}
                for r, c in _reasons.most_common()
                if r != "ok"
            ]
            turns, ok, recent = _turns, _ok, list(_recent)

        experts.sort(key=lambda e: e["calls"], reverse=True)
        tools.sort(key=lambda t: t["calls"], reverse=True)
        return {
            "since": _STARTED_AT.isoformat(),
            "since_label": _STARTED_AT.strftime("%m-%d %H:%M"),
            "turns": turns,
            "ok": ok,
            "failed": turns - ok,
            "ok_rate": round(ok / turns * 100, 1) if turns else None,
            "avg_ms": round(sum(samples) / len(samples)) if samples else 0,
            "p95_ms": round(_percentile(samples, 0.95)) if samples else 0,
            "last_ms": round(samples[-1]) if samples else 0,
            "failure_reasons": reasons,
            "experts": experts,
            "tools": tools[:12],
            "recent": recent,
        }
    except Exception:
        logger.debug("실행 현황 조회 실패", exc_info=True)
        return {"since": _STARTED_AT.isoformat(), "turns": 0, "ok": 0, "failed": 0,
                "ok_rate": None, "avg_ms": 0, "p95_ms": 0, "last_ms": 0,
                "failure_reasons": [], "experts": [], "tools": [], "recent": []}


def reset() -> None:
    """테스트용 — 전역 카운터를 비운다."""
    global _turns, _ok
    with _LOCK:
        _turns = 0
        _ok = 0
        _samples.clear()
        _reasons.clear()
        _experts.clear()
        _tools.clear()
        _recent.clear()
