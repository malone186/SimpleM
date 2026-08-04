"""브루의 오늘 브리핑 (백엔드 B) — 묻기 전에 먼저 하루를 정리해 주는 비서의 첫마디

인사이트 엔진(insight_service)이 '무엇이 문제인지'를 찾는다면, 여기서는 그것들을
**오늘 아침 사장님이 읽을 한 장**으로 만든다. 어제 얼마 벌었고, 오늘 누가 나오고,
지금 가장 급한 세 가지가 무엇인지 — 화면 여섯 개를 열어야 알던 것을 한 문단으로.

설계 규칙:
  - 숫자는 전부 DB에서 계산한 값만 쓴다. LLM은 그 숫자로 문장을 만들 뿐이고,
    실패하면 규칙 기반 문장으로 폴백한다 (브리핑이 통째로 사라지지 않게).
  - 우선순위 세 가지는 인사이트를 그대로 쓴다 — 알림·할 일·브리핑이 같은 근거를 본다.
  - 매장별 하루 캐시. 아침에 한 번 만들면 그날은 같은 브리핑을 돌려준다
    (알림·챗봇·홈 화면이 각자 부르더라도 Gemini는 한 번만 탄다).
"""

from __future__ import annotations

import logging
import time
from datetime import date, datetime, time as dtime, timedelta, timezone
from typing import Any, Optional

logger = logging.getLogger(__name__)

KST = timezone(timedelta(hours=9))

_TTL = 12 * 3600
_cache: dict[str, tuple[float, str, dict[str, Any]]] = {}  # store → (ts, day, result)

# 브리핑에 올릴 우선순위 개수 — 셋을 넘기면 '전부 중요한 것'이 되어 아무것도 안 읽힌다
TOP_N = 3

_SCHEMA = {
    "type": "object",
    "properties": {
        "headline": {"type": "string"},
        "message": {"type": "string"},
    },
    "required": ["headline", "message"],
}

_PROMPT = """너는 동네 카페 사장님의 매니저 '브루'다. 아래 사실만 가지고 오늘 아침 브리핑을 쓴다.

[오늘] {today} ({weekday}요일)
[어제 매출] {yesterday}
[오늘 근무] {staff}
[오늘 입금 예정] {deposit}
[지금 챙길 일]
{priorities}

규칙:
1) headline: 오늘을 한 줄로 요약 (18자 이내, 사장님을 부르지 말 것). 예: "어제보다 12% 오른 하루"
2) message: 2~3문장. 어제 실적을 한 문장으로 짚고, 오늘 가장 먼저 할 일 하나를 콕 집어 권한다.
   존댓말·다정하지만 담백하게. 이모지는 쓰지 않는다.
3) 위에 없는 숫자·사실을 지어내지 않는다. 데이터가 '없음'이면 그 항목은 말하지 않는다.
4) JSON만 반환한다."""


# ---------------------------------------------------------------------------
# 사실 수집 — 전부 값싼 조회만 (예측은 이미 계산된 캐시만 들여다본다)
# ---------------------------------------------------------------------------

def _yesterday_sales(store_id: str, yesterday: date) -> dict[str, Any]:
    """어제 매출과 그 전날 대비 증감. 정산 입력이 원본이고 없으면 판매 원장 합계로."""
    from sqlalchemy import func as sa_func

    from app.models.inventory import Sale
    from app.services.ai.document_service import _session

    out: dict[str, Any] = {"total": 0, "prev_total": 0, "change_pct": None, "best_menu": None}

    try:
        from app.services.ai import settlement_service

        out["total"] = int(settlement_service.get_day(store_id, yesterday.isoformat()).get("total") or 0)
        out["prev_total"] = int(
            settlement_service.get_day(store_id, (yesterday - timedelta(days=1)).isoformat()).get("total") or 0)
    except Exception:
        logger.debug("브리핑: 정산 조회 실패 — 판매 원장으로 폴백", exc_info=True)

    try:
        with _session() as db:
            from app.models.inventory import Menu

            start = datetime.combine(yesterday, dtime.min).astimezone()
            rows = (
                db.query(Menu.name, sa_func.sum(Sale.quantity), sa_func.sum(Sale.total_price))
                .join(Menu, Sale.menu_id == Menu.id)
                .filter(Sale.store_id == store_id,
                        Sale.sold_at >= start, Sale.sold_at < start + timedelta(days=1))
                .group_by(Menu.name)
                .order_by(sa_func.sum(Sale.quantity).desc())
                .all()
            )
            if rows:
                out["best_menu"] = {"name": rows[0][0], "qty": int(rows[0][1] or 0)}
                if out["total"] <= 0:
                    out["total"] = sum(int(r[2] or 0) for r in rows)
    except Exception:
        logger.debug("브리핑: 판매 집계 실패", exc_info=True)

    if out["total"] > 0 and out["prev_total"] > 0:
        out["change_pct"] = round((out["total"] - out["prev_total"]) / out["prev_total"] * 100)
    return out


def _today_staff(store_id: str, today: date) -> list[dict[str, Any]]:
    """오늘 근무로 잡혀 있는 직원 (이름·시작/종료 시각)."""
    from app.models.operation import Employee, Schedule
    from app.services.ai.document_service import _session

    try:
        with _session() as db:
            rows = (
                db.query(Schedule, Employee.name)
                .join(Employee, Schedule.employee_id == Employee.id)
                .filter(Employee.store_id == store_id, Schedule.date == today.isoformat())
                .all()
            )
    except Exception:
        logger.debug("브리핑: 근무 조회 실패", exc_info=True)
        return []

    staff = []
    for s, name in rows:
        span = ""
        if s.start_time and s.end_time:
            span = f"{s.start_time.strftime('%H:%M')}~{s.end_time.strftime('%H:%M')}"
        staff.append({"name": name, "span": span})
    return staff


def _today_deposit(store_id: str, today: date) -> Optional[dict[str, Any]]:
    """오늘 통장에 들어올 카드 대금 (없으면 None)."""
    try:
        from app.services.ai import settlement_service

        data = settlement_service.upcoming_deposits(store_id, lookback_days=14, ahead_days=7)
    except Exception:
        logger.debug("브리핑: 입금 예정 조회 실패", exc_info=True)
        return None

    nxt = data.get("next_deposit")
    if nxt and nxt.get("deposit_date") == today.isoformat():
        return {"net": int(nxt.get("net") or 0), "date": nxt["deposit_date"]}
    return None


# ---------------------------------------------------------------------------
# 문장 만들기
# ---------------------------------------------------------------------------

def _money(v: int) -> str:
    return f"{int(v):,}원"


def _fallback_text(facts: dict[str, Any], priorities: list[dict[str, Any]]) -> tuple[str, str]:
    """Gemini 없이도 브리핑은 나간다 — 사실을 그대로 잇는 문장."""
    sales = facts["yesterday_sales"]
    if sales["total"] > 0:
        head = f"어제 매출 {_money(sales['total'])}"
        if sales["change_pct"] is not None:
            head += f" ({'+' if sales['change_pct'] >= 0 else ''}{sales['change_pct']}%)"
        msg = f"어제는 {_money(sales['total'])}을 파셨어요"
        if sales["best_menu"]:
            msg += f" (가장 많이 나간 건 {sales['best_menu']['name']} {sales['best_menu']['qty']}잔)"
        msg += "."
    else:
        head = "어제 기록이 비어 있어요"
        msg = "어제 매출이 아직 입력되지 않았어요. 오늘 채워두면 예측과 리포트가 정확해져요."

    if priorities:
        top = priorities[0]
        msg += f" 오늘 먼저 볼 것은 '{top['title']}'입니다."
        if len(priorities) > 1:
            msg += f" 그 밖에 챙길 일이 {len(priorities) - 1}가지 더 있어요."
    else:
        msg += " 지금 급하게 챙길 일은 없어요. 오늘도 좋은 하루 되세요."
    return head[:40], msg


def _ai_text(facts: dict[str, Any], priorities: list[dict[str, Any]],
             today: date) -> Optional[tuple[str, str]]:
    """Gemini로 브리핑 문장을 만든다. 실패하면 None (폴백 문장이 대신 나간다)."""
    from app.services.ai.nearby_cafe_service import _gemini_json

    sales = facts["yesterday_sales"]
    if sales["total"] > 0:
        y = _money(sales["total"])
        if sales["change_pct"] is not None:
            y += f" (그제 대비 {'+' if sales['change_pct'] >= 0 else ''}{sales['change_pct']}%)"
        if sales["best_menu"]:
            y += f", 최다 판매 {sales['best_menu']['name']} {sales['best_menu']['qty']}잔"
    else:
        y = "입력 없음"

    staff = ", ".join(f"{s['name']} {s['span']}".strip() for s in facts["staff"]) or "없음"
    deposit = _money(facts["deposit"]["net"]) if facts.get("deposit") else "없음"
    lines = "\n".join(f"- [{p['severity']}] {p['title']}: {p['body']}" for p in priorities) or "- 없음"

    raw = _gemini_json(_PROMPT.format(
        today=today.isoformat(), weekday="월화수목금토일"[today.weekday()],
        yesterday=y, staff=staff, deposit=deposit, priorities=lines), _SCHEMA, timeout=20.0)
    if not raw:
        return None
    headline = str(raw.get("headline") or "").strip()[:40]
    message = str(raw.get("message") or "").strip()[:400]
    return (headline, message) if headline and message else None


# ---------------------------------------------------------------------------
# 공개 인터페이스
# ---------------------------------------------------------------------------

def build(store_id: str, force_refresh: bool = False, deep: bool = False) -> dict[str, Any]:
    """오늘의 브리핑. 반환: {date, headline, message, facts, priorities, todo_count, engine}

    deep=True면 무거운 인사이트(단골 이탈·원두 시세)까지 지금 계산한다 — 알림 스케줄러용.
    """
    from app.services.ai import insight_service

    now = datetime.now(KST)
    today = now.date()
    hit = _cache.get(store_id)
    if not force_refresh and hit and hit[1] == today.isoformat() and time.time() - hit[0] < _TTL:
        return {**hit[2], "cached": True}

    scan = insight_service.scan(store_id, deep=deep)
    priorities = [
        {k: i[k] for k in ("key", "category", "severity", "title", "body", "action", "due_date")}
        for i in scan.get("insights", []) if i.get("severity") != "low"
    ][:TOP_N]

    yesterday = today - timedelta(days=1)
    facts = {
        "yesterday": yesterday.isoformat(),
        "yesterday_sales": _yesterday_sales(store_id, yesterday),
        "staff": _today_staff(store_id, today),
        "deposit": _today_deposit(store_id, today),
    }

    engine = "ai"
    text = _ai_text(facts, priorities, today)
    if text is None:
        engine = "rule"
        text = _fallback_text(facts, priorities)

    result = {
        "date": today.isoformat(),
        "weekday": "월화수목금토일"[today.weekday()],
        "headline": text[0],
        "message": text[1],
        "facts": facts,
        "priorities": priorities,
        "insight_count": scan.get("count", 0),
        "high_count": scan.get("high", 0),
        "engine": engine,
        "generated_at": now.isoformat(timespec="seconds"),
    }
    _cache[store_id] = (time.time(), today.isoformat(), result)
    return result


def push_body(briefing: dict[str, Any]) -> str:
    """푸시 본문 — 열기 전에 이미 정보가 되도록 요약 + 첫 우선순위."""
    parts = [briefing["message"].split(". ")[0].rstrip(".") + "."]
    for p in briefing.get("priorities", [])[:2]:
        parts.append(f"· {p['title']}")
    return "\n".join(parts)[:300]
