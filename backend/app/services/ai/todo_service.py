"""할 일 목록 (백엔드 B) — 대시보드 '오늘 할 일' 중 명시적으로 적어둔 항목

여기서 다루는 건 '누군가 적어둔 일'뿐이다. 재고 부족·서류 갱신처럼 조건에서 자동으로
도출되는 할 일은 대시보드가 재고·서류 API로 매번 조립한다 (저장하면 상황이 해소된 뒤에도
유령 항목이 남는다). 그래서 이 서비스는 자동 도출 항목을 만들지도, 지우지도 않는다.

사장님 직접 입력과 챗봇(브루) 추가가 같은 테이블을 쓰고 source로만 구분한다 —
대시보드가 "브루가 추가함" 배지를 붙일 수 있게.
"""

import logging
from datetime import date, datetime, timedelta, timezone
from typing import Any, Optional

from app.schemas.ai import TodoCreate, TodoUpdate

logger = logging.getLogger(__name__)

KST = timezone(timedelta(hours=9))

# 완료된 항목을 목록에서 계속 보여줄 기간. 체크하자마자 사라지면 잘못 눌렀을 때
# 되돌릴 방법이 없고, 오래 남으면 목록이 지저분해진다.
DONE_VISIBLE_HOURS = 12


class TodoError(ValueError):
    """할 일 처리 실패 (없는 항목·잘못된 입력)"""


def _session():
    import app.models  # noqa: F401 — 모든 모델을 Base.metadata에 등록
    from app.core.database import SessionLocal

    return SessionLocal()


def _to_dict(row) -> dict[str, Any]:
    return {
        "id": row.id,
        "title": row.title,
        "note": row.note,
        "source": row.source,
        "done": row.done,
        "due_date": row.due_date,
        "created_at": row.created_at.isoformat() if row.created_at else None,
    }


# ---------------------------------------------------------------------------
# 조회
# ---------------------------------------------------------------------------

def list_todos(store_id: str, include_done: bool = True) -> list[dict[str, Any]]:
    """할 일 목록. 미완료가 먼저, 그 안에서는 기한이 임박한 순 → 최근 추가 순.

    완료 항목은 기본적으로 함께 돌려주되 최근 것만 준다 — 체크 직후 사라지면
    잘못 눌렀을 때 되돌릴 수가 없다.
    """
    from app.models.ai import TodoItem

    with _session() as db:
        q = db.query(TodoItem).filter(TodoItem.store_id == store_id)
        if not include_done:
            q = q.filter(TodoItem.done.is_(False))
        rows = q.all()

    cutoff = datetime.now(timezone.utc) - timedelta(hours=DONE_VISIBLE_HOURS)
    visible = [
        r for r in rows
        if not r.done or r.done_at is None or _aware(r.done_at) >= cutoff
    ]

    def _sort_key(r):
        # 미완료 먼저 → 기한 있는 것 먼저(가까운 순) → 최근 추가 순
        return (
            r.done,
            r.due_date or "9999-12-31",
            -(r.created_at.timestamp() if r.created_at else 0),
        )

    return [_to_dict(r) for r in sorted(visible, key=_sort_key)]


def _aware(dt: datetime) -> datetime:
    """sqlite는 tz 정보를 잃어버린 naive datetime을 돌려준다 — UTC로 간주해 비교 가능하게."""
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


# ---------------------------------------------------------------------------
# 추가
# ---------------------------------------------------------------------------

def _normalize_title(s: str) -> str:
    """중복 판정용 제목 정규화 — 공백을 걷어내고 '~하기' 어미를 뗀다.

    AI가 짓는 제목은 매번 조금씩 달라서('원두 발주' vs '원두 발주하기') 정확일치로는
    같은 일이 두 줄로 쌓인다. 반대로 포함관계 매칭은 '원두 발주'와 '원두 발주서 확인'
    같은 다른 일까지 합쳐버린다 — 잘못 합치는 것보다 한 줄 더 생기는 쪽이 덜 위험하므로
    표기 차이만 흡수하는 정규화 동등 비교에 머문다.
    """
    t = "".join(s.split())
    return t[:-2] if t.endswith("하기") else t


def add_todo(store_id: str, req: TodoCreate, source: str = "owner") -> dict[str, Any]:
    """할 일을 추가한다. 같은 일을 가리키는 미완료 항목이 이미 있으면 그것을 그대로 돌려준다.

    중복을 막는 이유는 챗봇 때문이다. 사장님이 "원두 발주 잊지 말라고 해줘"를 두 번
    말하거나 모델이 도구를 두 번 호출하면 같은 줄이 두 개 쌓인다. 판정 기준은
    _normalize_title 참고.
    """
    from app.models.ai import TodoItem

    title = (req.title or "").strip()
    if not title:
        raise TodoError("할 일 제목이 비어 있습니다")
    if req.due_date:
        try:
            date.fromisoformat(req.due_date)
        except ValueError:
            raise TodoError(f"기한 형식 오류: '{req.due_date}' (YYYY-MM-DD로 입력)")

    with _session() as db:
        open_rows = (
            db.query(TodoItem)
            .filter(TodoItem.store_id == store_id, TodoItem.done.is_(False))
            .all()
        )
        norm = _normalize_title(title)
        existing = next((r for r in open_rows if _normalize_title(r.title) == norm), None)
        if existing is not None:
            return _to_dict(existing)

        row = TodoItem(store_id=store_id, title=title, note=(req.note or "").strip() or None,
                       source=source, due_date=req.due_date)
        db.add(row)
        db.commit()
        db.refresh(row)
        logger.info("할 일 추가 (%s, source=%s): %s", store_id, source, title)
        return _to_dict(row)


# ---------------------------------------------------------------------------
# 수정 · 완료 · 삭제
# ---------------------------------------------------------------------------

def _own_row(db, store_id: str, todo_id: int):
    """내 매장 것만 집는다 — id만 알면 남의 할 일을 건드릴 수 있으면 안 된다."""
    from app.models.ai import TodoItem

    row = db.get(TodoItem, todo_id)
    if row is None or row.store_id != store_id:
        raise TodoError(f"할 일 {todo_id}를 찾을 수 없습니다")
    return row


def update_todo(store_id: str, todo_id: int, req: TodoUpdate) -> dict[str, Any]:
    """부분 수정 — 보낸 필드만 바꾼다."""
    if req.due_date:
        try:
            date.fromisoformat(req.due_date)
        except ValueError:
            raise TodoError(f"기한 형식 오류: '{req.due_date}' (YYYY-MM-DD로 입력)")

    with _session() as db:
        row = _own_row(db, store_id, todo_id)

        if req.title is not None:
            title = req.title.strip()
            if not title:
                raise TodoError("할 일 제목이 비어 있습니다")
            row.title = title
        if req.note is not None:
            row.note = req.note.strip() or None
        if req.due_date is not None:
            row.due_date = req.due_date
        if req.done is not None and req.done != row.done:
            row.done = req.done
            # done_at은 목록에서 언제 감출지 정하는 기준이라 완료 시점에만 찍는다
            row.done_at = datetime.now(timezone.utc) if req.done else None

        db.commit()
        db.refresh(row)
        return _to_dict(row)


def complete_todo(store_id: str, todo_id: int) -> dict[str, Any]:
    """완료 표시 (챗봇이 "그거 했어" 같은 말에 쓴다)."""
    return update_todo(store_id, todo_id, TodoUpdate(done=True))


def delete_todo(store_id: str, todo_id: int) -> None:
    with _session() as db:
        row = _own_row(db, store_id, todo_id)
        db.delete(row)
        db.commit()


def find_by_title(store_id: str, text: str) -> Optional[dict[str, Any]]:
    """제목으로 미완료 항목을 찾는다 — 챗봇이 id를 모른 채 "원두 발주 완료" 같은 말을
    할 때 쓴다. 정확히 일치하는 게 없으면 부분 일치로 한 번 더 본다."""
    todos = [t for t in list_todos(store_id, include_done=False)]
    needle = (text or "").strip()
    if not needle:
        return None

    for t in todos:
        if t["title"] == needle:
            return t
    matches = [t for t in todos if needle in t["title"] or t["title"] in needle]
    # 후보가 여럿이면 어느 것인지 확신할 수 없다 — 챗봇이 되물어야 한다
    return matches[0] if len(matches) == 1 else None
