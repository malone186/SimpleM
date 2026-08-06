"""정답 계산기 — 채점 시점에 DB에서 진짜 값을 뽑는다

[왜 정답을 파일에 안 박는가] 데모 매장 시드는 매시간 크론이 새로 만든다. "어제 매출은
24,600원"이라고 golden.yaml에 적어 두면 한 시간 뒤 전부 실패한다. 그래서 문항에는
'무엇을 계산하면 정답인가'(예: sales_total(day=yesterday))만 적고, 러너가 채점하는
순간에 여기서 실제 값을 계산한다.

[왜 챗봇이 쓰는 것과 같은 함수를 쓰는가] 정답 계산을 따로 구현하면 그 구현이 틀렸을 때
멀쩡한 답을 오답으로 잡는다. 챗봇의 도구가 부르는 것과 같은 서비스 함수를 부르되,
'어느 인자로 부를지'는 여기서 사람이 정한다 — 8/4 사고가 정확히 인자 선택(days=1이
'어제'가 아니라 '오늘')에서 났기 때문에, 그 선택을 모델이 아니라 사람이 고정해 둔 값과
비교하는 것이 이 평가의 핵심이다.
"""

from __future__ import annotations

import re
from datetime import date, timedelta
from typing import Any, Callable

# 문항의 `정답:` 표현을 파싱한다 — 예: "sales_total(day=yesterday)"
_SPEC = re.compile(r"^\s*([a-z_]+)\s*\((.*)\)\s*$")


class TruthError(RuntimeError):
    """정답 계산 실패 — 문항 오타이거나 DB가 죽었다."""


def _day(value: str) -> str:
    """'yesterday' / 'today' / '2026-08-04' → YYYY-MM-DD"""
    today = date.today()
    if value in ("today", "오늘"):
        return today.isoformat()
    if value in ("yesterday", "어제"):
        return (today - timedelta(days=1)).isoformat()
    try:
        return date.fromisoformat(value).isoformat()
    except ValueError:
        raise TruthError(f"날짜로 읽을 수 없는 값: {value}")


# ---------------------------------------------------------------------------
# 계산기들 — 반환값이 숫자면 '답변에 이 숫자가 있는가', 문자열이면 '이 말이 있는가'로 채점된다
# ---------------------------------------------------------------------------

def sales_total(store_id: str, day: str = "", days: int = 0) -> int:
    """매출 합계. day를 주면 그 하루만, days를 주면 오늘까지 그 일수만큼."""
    from app.services.ai import store_data_service

    if day:
        d = _day(day)
        result = store_data_service.get_sales_history(store_id, start_date=d, end_date=d)
    else:
        result = store_data_service.get_sales_history(store_id, days=max(1, int(days) or 7))
    return int(result["total_revenue"])


def sales_cups(store_id: str, day: str = "", days: int = 0) -> int:
    """판매 잔 수 합계."""
    from app.services.ai import store_data_service

    if day:
        d = _day(day)
        result = store_data_service.get_sales_history(store_id, start_date=d, end_date=d)
    else:
        result = store_data_service.get_sales_history(store_id, days=max(1, int(days) or 7))
    return int(result["total_cups"])


def top_menu(store_id: str, days: int = 14) -> str:
    """기간 내 매출 1위 메뉴 이름."""
    from app.services.ai import store_data_service

    menus = store_data_service.get_sales_history(store_id, days=int(days))["by_menu"]
    if not menus:
        raise TruthError("판매 기록이 없어 1위 메뉴를 정할 수 없다 (시드부터 확인)")
    return str(menus[0]["menu"])


def expense_total(store_id: str, days: int = 30) -> int:
    """지출 합계."""
    from app.services.ai import store_data_service

    return int(store_data_service.get_expenses(store_id, days=int(days))["total"])


def staff_count(store_id: str) -> int:
    """등록된 직원 수."""
    from app.services.ai import store_data_service

    return int(store_data_service.get_staff_roster(store_id)["count"])


def document_count(store_id: str, kind: str = "") -> int:
    """생성된 문서 수 (kind를 주면 그 종류만)."""
    from app.services.ai import document_service

    return len(document_service.list_documents(store_id, kind=kind or None))


def todo_open_count(store_id: str) -> int:
    """아직 완료하지 않은 할 일 수."""
    from app.services.ai import todo_service

    return sum(1 for t in todo_service.list_todos(store_id) if not t.get("done"))


CALCULATORS: dict[str, Callable[..., Any]] = {
    "sales_total": sales_total,
    "sales_cups": sales_cups,
    "top_menu": top_menu,
    "expense_total": expense_total,
    "staff_count": staff_count,
    "document_count": document_count,
    "todo_open_count": todo_open_count,
}


def parse_spec(spec: str) -> tuple[str, dict[str, Any]]:
    """"sales_total(day=yesterday)" → ("sales_total", {"day": "yesterday"})

    문항 파일의 오타를 실행 전에 잡을 수 있도록 계산과 파싱을 나눠 둔다
    (tests/test_golden_suite.py가 전 문항을 파싱만 해 본다 — API 호출 없이).
    """
    m = _SPEC.match(spec or "")
    if not m:
        raise TruthError(f"정답 표현을 읽을 수 없다: {spec!r} (예: sales_total(day=yesterday))")
    name, raw_args = m.group(1), m.group(2).strip()
    if name not in CALCULATORS:
        raise TruthError(f"'{name}'라는 정답 계산기가 없다. 쓸 수 있는 것: "
                         + ", ".join(sorted(CALCULATORS)))

    kwargs: dict[str, Any] = {}
    if raw_args:
        for part in raw_args.split(","):
            if "=" not in part:
                raise TruthError(f"인자는 이름=값 형태여야 한다: {part!r}")
            key, _, value = part.partition("=")
            value = value.strip().strip("'\"")
            kwargs[key.strip()] = int(value) if value.lstrip("-").isdigit() else value
    return name, kwargs


def resolve(spec: str, store_id: str) -> Any:
    """문항의 `정답:` 표현을 실제 값으로 계산한다."""
    name, kwargs = parse_spec(spec)
    try:
        return CALCULATORS[name](store_id, **kwargs)
    except TruthError:
        raise
    except TypeError as e:
        raise TruthError(f"{spec} 인자가 맞지 않는다: {e}")
    except Exception as e:
        raise TruthError(f"{spec} 계산 실패: {type(e).__name__}: {e}")
