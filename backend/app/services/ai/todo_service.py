"""할 일 목록 (백엔드 B) — 대시보드 '오늘 할 일' 중 명시적으로 적어둔 항목

여기서 다루는 건 '누군가 적어둔 일'뿐이다. 재고 부족·서류 갱신처럼 조건에서 자동으로
도출되는 할 일은 대시보드가 재고·서류 API로 매번 조립한다 (저장하면 상황이 해소된 뒤에도
유령 항목이 남는다). 그래서 이 서비스는 자동 도출 항목을 만들지도, 지우지도 않는다.

사장님 직접 입력과 챗봇(브루) 추가가 같은 테이블을 쓰고 source로만 구분한다 —
대시보드가 "브루가 추가함" 배지를 붙일 수 있게.
"""

import logging
import re
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
        # 알바 전달 흔적 — 완료 여부(forwarded_done)는 체크리스트를 조인해야 알 수 있어
        # 목록 조회(list_todos)에서만 채운다. 단건 응답에서는 이름만 실린다.
        "forwarded_to": row.forwarded_staff_name,
        "forwarded_done": None,
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

        # 알바에게 보낸 항목의 완료 여부 — 보낸 항목은 one_off라 완료되면 active=False로
        # 은퇴하므로, active만 보면 된다 (당일 체크 여부를 따로 조인할 필요가 없다).
        fwd_ids = [r.forwarded_item_id for r in rows if r.forwarded_item_id]
        fwd_done: dict[int, bool] = {}
        if fwd_ids:
            from app.models.checklist import ChecklistItem
            fwd_done = {
                i.id: (not i.active)
                for i in db.query(ChecklistItem).filter(ChecklistItem.id.in_(fwd_ids))
            }

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

    out = []
    for r in sorted(visible, key=_sort_key):
        d = _to_dict(r)
        if r.forwarded_item_id:
            # 보낸 항목이 체크리스트에서 지워졌으면 None — 화면엔 '전달됨'만 남는다
            d["forwarded_done"] = fwd_done.get(r.forwarded_item_id)
        out.append(d)
    return out


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


def add_todos_bulk(store_id: str, items: list[TodoCreate],
                   source: str = "ai") -> dict[str, Any]:
    """여러 할 일을 한 번에 추가한다 (행사 준비 목록처럼 '통째로 담기'용).

    add_todo를 목록만큼 반복하면 DB 왕복이 항목 수만큼 늘어난다 — 공유 DB가 원격(Neon)이라
    한 번에 0.2초씩 붙어 5개만 담아도 1초가 넘는다. 여기서는 기존 미완료 목록을 한 번만
    읽고, 추가도 한 트랜잭션에서 끝낸다.

    중복 판정은 add_todo와 같은 기준(_normalize_title)이되, **이번 묶음 안의 중복도**
    함께 걸러낸다 (AI가 "얼음 넉넉히 준비하기"를 두 곳에서 뽑아 오는 일이 있다).

    반환: {"added": [할 일...], "skipped": ["이미 있던 제목"...]}
    """
    from app.models.ai import TodoItem

    cleaned: list[TodoCreate] = []
    for req in items:
        title = (req.title or "").strip()
        if not title:
            continue
        if req.due_date:
            try:
                date.fromisoformat(req.due_date)
            except ValueError:
                raise TodoError(f"기한 형식 오류: '{req.due_date}' (YYYY-MM-DD로 입력)")
        cleaned.append(req.model_copy(update={"title": title}))
    if not cleaned:
        raise TodoError("추가할 할 일이 없습니다")

    added: list[dict[str, Any]] = []
    skipped: list[str] = []
    with _session() as db:
        open_rows = (
            db.query(TodoItem)
            .filter(TodoItem.store_id == store_id, TodoItem.done.is_(False))
            .all()
        )
        seen = {_normalize_title(r.title) for r in open_rows}
        rows: list[Any] = []
        for req in cleaned:
            norm = _normalize_title(req.title)
            if norm in seen:
                skipped.append(req.title)
                continue
            seen.add(norm)
            row = TodoItem(store_id=store_id, title=req.title,
                           note=(req.note or "").strip() or None,
                           source=source, due_date=req.due_date)
            db.add(row)
            rows.append(row)
        if rows:
            db.commit()
            for row in rows:
                db.refresh(row)
                added.append(_to_dict(row))

    logger.info("할 일 일괄 추가 (%s, source=%s): 추가 %d건 / 중복 %d건",
                store_id, source, len(added), len(skipped))
    return {"added": added, "skipped": skipped}


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
        just_completed = False
        if req.done is not None and req.done != row.done:
            row.done = req.done
            # done_at은 목록에서 언제 감출지 정하는 기준이라 완료 시점에만 찍는다
            row.done_at = datetime.now(timezone.utc) if req.done else None
            just_completed = req.done

        completed_title = row.title
        db.commit()
        db.refresh(row)
        result = _to_dict(row)

    # 할 일을 끝내면 코인을 준다 (게임화 보상).
    # 세션을 닫은 뒤에 부르는 이유: 적립이 실패해도 '할 일 완료' 자체는 이미 저장돼야 한다.
    # 완료를 껐다 켜도 reward_service가 할 일 id로 중복을 막아 한 번만 지급된다.
    if just_completed:
        try:
            from app.services.ai import reward_service

            if reward_service.award_todo_done(store_id, todo_id, completed_title):
                result["points_awarded"] = reward_service.POINTS_PER_TODO
        except Exception:
            logger.exception("할 일 완료 포인트 적립 실패 — 할 일 저장은 정상")

    return result


def complete_todo(store_id: str, todo_id: int) -> dict[str, Any]:
    """완료 표시 (챗봇이 "그거 했어" 같은 말에 쓴다)."""
    return update_todo(store_id, todo_id, TodoUpdate(done=True))


def delete_todo(store_id: str, todo_id: int) -> None:
    with _session() as db:
        row = _own_row(db, store_id, todo_id)
        db.delete(row)
        db.commit()


def forward_todo(db, store_id: str, todo_id: int, staff_id: int):
    """할 일을 알바의 근무 체크리스트로 보낸다 (담당 지정 + 일회성 one_off).

    체크리스트 항목 생성과 할 일에 흔적 남기기를 같은 세션에서 처리한다.
    같은 할 일을 다시 보내는 것은 막지 않는다 — 다른 알바에게 재전달하는 경우가
    실제로 있어서다(흔적은 마지막 전달 기준으로 덮어쓴다).

    반환: (할 일 dict, 생성된 체크리스트 항목, 직원 이름) — 항목·이름은 푸시 문구에 쓴다.
    """
    from app.models.ai import TodoItem
    from app.services import checklist_service

    row = (
        db.query(TodoItem)
        .filter(TodoItem.id == todo_id, TodoItem.store_id == store_id)
        .first()
    )
    if row is None:
        raise TodoError("할 일을 찾을 수 없습니다.")
    if row.done:
        raise TodoError("이미 완료된 할 일은 보낼 수 없습니다.")

    # 홈 화면 제목 규칙과 동일하게 "[서류·행정] " 태그를 떼고 보낸다 — 체크리스트에선 소음이다
    label = re.sub(r"^\[[^\]]{1,8}\]\s*", "", row.title).strip() or row.title
    # 직원 검증(우리 매장의 활성 계정인지)은 checklist_service.add_item이 한다 (ValueError)
    item, staff_name = checklist_service.add_item(
        db, store_id, label, assigned_staff_id=staff_id, one_off=True)

    row.forwarded_item_id = item.id
    row.forwarded_staff_name = staff_name
    db.commit()

    d = _to_dict(row)
    d["forwarded_done"] = False
    return d, item, staff_name


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
