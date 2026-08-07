"""근무 체크리스트 로직 — 매일 반복 루틴 (직원·사장 공유)

체크 상태는 날짜로 관리한다(ChecklistCheck.check_date). 그래서 '오늘'을 조회하면
어제 체크는 딸려 오지 않고, 자정이 지나면 저절로 새 체크리스트가 된다 — 크론 없이
매일 초기화되는 셈이다.
"""
from datetime import date, timedelta, timezone
from typing import Any, Optional

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.checklist import ChecklistCheck, ChecklistItem

KST = timezone(timedelta(hours=9))


def _today() -> date:
    # 매장 하루의 경계는 KST 자정이다. UTC로 잡으면 오전 9시 이전 체크가 전날로 밀린다.
    from datetime import datetime
    return datetime.now(KST).date()


def list_today(db: Session, store_id: str) -> list[dict[str, Any]]:
    """활성 항목을 정렬 순서대로, 오늘 체크 상태를 붙여 돌려준다."""
    items = (
        db.query(ChecklistItem)
        .filter(ChecklistItem.store_id == store_id, ChecklistItem.active.is_(True))
        .order_by(ChecklistItem.sort_order, ChecklistItem.id)
        .all()
    )
    if not items:
        return []
    today = _today()
    checks = {
        c.item_id: c
        for c in db.query(ChecklistCheck)
        .filter(ChecklistCheck.store_id == store_id, ChecklistCheck.check_date == today)
        .all()
    }
    rows = []
    for it in items:
        c = checks.get(it.id)
        rows.append({
            "id": it.id,
            "label": it.label,
            "sort_order": it.sort_order,
            "done": c is not None,
            "done_by": c.done_by if c else None,
            "checked_at": c.checked_at if c else None,
        })
    return rows


def toggle(db: Session, store_id: str, item_id: int, done_by: Optional[str]) -> dict[str, Any]:
    """오늘 체크를 토글한다. 켜면 행을 만들고, 끄면 지운다.

    체크됨 = 행이 있음. 안 함 = 행이 없음. done_by는 켠 사람을 기록한다.
    """
    item = (
        db.query(ChecklistItem)
        .filter(ChecklistItem.id == item_id, ChecklistItem.store_id == store_id)
        .first()
    )
    if item is None:
        raise ValueError("항목을 찾을 수 없습니다.")

    today = _today()
    existing = (
        db.query(ChecklistCheck)
        .filter(ChecklistCheck.item_id == item_id, ChecklistCheck.check_date == today)
        .first()
    )
    if existing:
        db.delete(existing)
        db.commit()
        return {"id": item_id, "done": False, "done_by": None}

    row = ChecklistCheck(store_id=store_id, item_id=item_id, check_date=today, done_by=done_by)
    db.add(row)
    try:
        db.commit()
    except IntegrityError:
        # 두 직원이 동시에 눌렀다 — 유니크 제약이 막았다. 이미 체크된 상태로 본다.
        db.rollback()
        return {"id": item_id, "done": True, "done_by": done_by}
    db.refresh(row)
    return {"id": item_id, "done": True, "done_by": row.done_by}


# --- 사장님 전용: 항목 템플릿 관리 ---------------------------------------------

def add_item(db: Session, store_id: str, label: str) -> ChecklistItem:
    label = label.strip()
    if not label:
        raise ValueError("항목 이름을 입력해 주세요.")
    # 새 항목은 맨 아래로 — 기존 최대 정렬값 +1
    max_order = (
        db.query(ChecklistItem.sort_order)
        .filter(ChecklistItem.store_id == store_id)
        .order_by(ChecklistItem.sort_order.desc())
        .first()
    )
    item = ChecklistItem(store_id=store_id, label=label,
                         sort_order=(max_order[0] + 1) if max_order else 0)
    db.add(item)
    db.commit()
    db.refresh(item)
    return item


def update_item(db: Session, store_id: str, item_id: int,
                label: Optional[str] = None, active: Optional[bool] = None,
                sort_order: Optional[int] = None) -> ChecklistItem:
    item = (
        db.query(ChecklistItem)
        .filter(ChecklistItem.id == item_id, ChecklistItem.store_id == store_id)
        .first()
    )
    if item is None:
        raise ValueError("항목을 찾을 수 없습니다.")
    if label is not None:
        label = label.strip()
        if not label:
            raise ValueError("항목 이름을 입력해 주세요.")
        item.label = label
    if active is not None:
        item.active = active
    if sort_order is not None:
        item.sort_order = sort_order
    db.commit()
    db.refresh(item)
    return item


def delete_item(db: Session, store_id: str, item_id: int) -> None:
    item = (
        db.query(ChecklistItem)
        .filter(ChecklistItem.id == item_id, ChecklistItem.store_id == store_id)
        .first()
    )
    if item is None:
        raise ValueError("항목을 찾을 수 없습니다.")
    # 체크 기록(ChecklistCheck)은 FK ondelete=CASCADE라 함께 지워진다.
    db.delete(item)
    db.commit()
