"""직원 로그인 계정 API (백엔드 B)

[한글 주석] 계정 관리는 사장님만(require_owner), 로그인은 인증 없이 연다.
직원이 자기 계정을 만들거나 남의 비밀번호를 바꿀 수 있으면 안 된다.
"""
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.core.auth import get_current_user, require_owner
from app.core.database import get_db
from app.models.user import User
from app.services import staff_account_service as svc

router = APIRouter(prefix="/staff-accounts", tags=["직원 계정 (Staff Account)"])


class StaffAccountCreate(BaseModel):
    name: str = Field(..., max_length=50, description="직원 이름")
    login_id: str = Field(..., description="로그인 아이디 (영문·숫자 3~20자)")
    employee_id: Optional[int] = Field(None, description="직원 명부와 연결 (선택)")


class StaffLoginRequest(BaseModel):
    login_id: str
    password: str


@router.get("", summary="직원 계정 목록")
def list_accounts_api(db: Session = Depends(get_db),
                      user: User = Depends(require_owner)):
    return svc.list_accounts(db, user.email)


@router.post("", summary="직원 계정 만들기")
def create_account_api(payload: StaffAccountCreate, db: Session = Depends(get_db),
                       user: User = Depends(require_owner)):
    """[한글 주석] 초기 비밀번호는 이 응답에서 한 번만 보여집니다.
    저장하지 않고 해시만 남기므로 잊으면 재발급해야 합니다."""
    acc, msg, raw = svc.create_staff_account(
        db, user.email, payload.name, payload.login_id, payload.employee_id)
    if not acc:
        raise HTTPException(status_code=400, detail=msg)
    return {
        "id": acc.id, "name": acc.name, "login_id": acc.login_id,
        "initial_password": raw, "message": msg,
        "guide": "이 비밀번호는 지금만 보입니다. 직원에게 전달해 주세요.",
    }


@router.post("/{staff_id}/reset-password", summary="비밀번호 재발급")
def reset_password_api(staff_id: int, db: Session = Depends(get_db),
                       user: User = Depends(require_owner)):
    ok, msg, raw = svc.reset_password(db, user.email, staff_id)
    if not ok:
        raise HTTPException(status_code=404, detail=msg)
    return {"password": raw, "message": msg}


@router.post("/{staff_id}/deactivate", summary="계정 사용 중지 (퇴사 등)")
def deactivate_api(staff_id: int, db: Session = Depends(get_db),
                   user: User = Depends(require_owner)):
    """[한글 주석] 지우지 않고 잠급니다.
    이 직원이 처리한 차감 기록이 남아 있어, 지우면 '누가 했는지'를 되짚을 수 없습니다."""
    ok, msg = svc.set_active(db, user.email, staff_id, False)
    if not ok:
        raise HTTPException(status_code=404, detail=msg)
    return {"success": True, "message": msg}


@router.post("/{staff_id}/activate", summary="계정 다시 사용")
def activate_api(staff_id: int, db: Session = Depends(get_db),
                 user: User = Depends(require_owner)):
    ok, msg = svc.set_active(db, user.email, staff_id, True)
    if not ok:
        raise HTTPException(status_code=404, detail=msg)
    return {"success": True, "message": msg}


@router.post("/login", summary="[직원용] 로그인")
def staff_login_api(payload: StaffLoginRequest, db: Session = Depends(get_db)):
    """[한글 주석] 발급되는 토큰에는 매장(사장님) 이메일이 담깁니다.

    직원 이메일을 담으면 이걸 매장 식별자로 쓰는 기존 API 150여 군데가
    조용히 어긋납니다("재고가 빈다", "엉뚱한 매장에 저장된다").
    매장은 그대로 두고 '누가 조작했는지'만 따로 실어 보냅니다.
    """
    token, msg, acc = svc.login(db, payload.login_id, payload.password)
    if not token:
        raise HTTPException(status_code=401, detail=msg)
    return {
        "access_token": token,
        "token_type": "bearer",
        "name": acc.name,
        "role": "staff",
        "message": msg,
    }


@router.get("/me", summary="현재 로그인 주체 확인")
def whoami_api(user: User = Depends(get_current_user)):
    """[한글 주석] 화면이 사장님/직원을 구분해 메뉴를 감추는 데 씁니다."""
    staff = getattr(user, "acting_staff", None)
    return {
        "store_id": user.email,
        "store_name": getattr(user, "store_name", None),
        "is_owner": staff is None,
        "staff_id": staff.id if staff else None,
        "name": staff.name if staff else getattr(user, "name", None),
    }
