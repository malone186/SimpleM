"""근무 체크리스트 API — 매일 반복 루틴 (직원·사장 공유)

조회·토글·항목 추가는 직원도 한다(계산대 근무 루틴 + 현장에서 발견한 할 일).
항목 수정·삭제는 사장님만(require_owner) — 루틴의 원본 관리는 사장님 몫.
직원 토큰도 store_id가 사장님 이메일이라, 두 사람이 같은 체크리스트를 본다.
"""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.core.auth import get_current_user, require_owner
from app.core.database import get_db
from app.models.user import User
from app.schemas.checklist import (
    ChecklistItemCreate, ChecklistItemRow, ChecklistItemUpdate, ChecklistToggleResult,
)
from app.services import checklist_service as svc

router = APIRouter(prefix="/checklist", tags=["근무 체크리스트 (Checklist)"])


def _done_by(user: User) -> str:
    """오늘 체크를 누가 했는지 표시할 이름 — 직원이면 직원 이름, 아니면 '사장님'."""
    staff = getattr(user, "acting_staff", None)
    return staff.name if staff else "사장님"


@router.get("", response_model=list[ChecklistItemRow], summary="오늘 체크리스트")
def list_checklist(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """오늘 기준 체크리스트. 자정이 지나면 저절로 새 목록이 된다(날짜 기준)."""
    return svc.list_today(db, user.email)


@router.post("/{item_id}/toggle", response_model=ChecklistToggleResult, summary="오늘 체크 토글")
def toggle_checklist(item_id: int, db: Session = Depends(get_db),
                     user: User = Depends(get_current_user)):
    """오늘 체크를 켜고 끈다. 직원도 할 수 있다 — 근무 루틴을 끝내는 게 이 화면의 목적이다."""
    try:
        return svc.toggle(db, user.email, item_id, done_by=_done_by(user))
    except ValueError as e:
        raise HTTPException(404, str(e))


# --- 사장님 전용: 항목 관리 (require_owner) -----------------------------------

@router.post("/items", response_model=ChecklistItemRow, status_code=201, summary="항목 추가")
def create_item(body: ChecklistItemCreate, db: Session = Depends(get_db),
                # 추가는 직원도 한다 — 근무 중 발견한 할 일(가스 점검 등)을 그 자리에서
                # 올리게. 수정·삭제는 여전히 사장님만(루틴의 원본은 사장님이 관리한다).
                user: User = Depends(get_current_user)):
    try:
        item = svc.add_item(db, user.email, body.label)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"id": item.id, "label": item.label, "sort_order": item.sort_order,
            "done": False, "done_by": None, "checked_at": None}


@router.patch("/items/{item_id}", response_model=ChecklistItemRow, summary="항목 수정")
def update_item(item_id: int, body: ChecklistItemUpdate, db: Session = Depends(get_db),
                user: User = Depends(require_owner)):
    try:
        item = svc.update_item(db, user.email, item_id,
                               label=body.label, active=body.active, sort_order=body.sort_order)
    except ValueError as e:
        raise HTTPException(404, str(e))
    return {"id": item.id, "label": item.label, "sort_order": item.sort_order,
            "done": False, "done_by": None, "checked_at": None}


@router.delete("/items/{item_id}", status_code=204, summary="항목 삭제")
def delete_item(item_id: int, db: Session = Depends(get_db),
                user: User = Depends(require_owner)):
    try:
        svc.delete_item(db, user.email, item_id)
    except ValueError as e:
        raise HTTPException(404, str(e))
