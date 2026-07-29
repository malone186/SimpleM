"""매장 기본 정보 API (백엔드 B) — 업종·영업 시간

가입 화면에서 운영 시간을 물어보면서 저장할 곳이 없어 그대로 버려지고 있었다.
설정 화면의 업종·운영시간도 기기 AsyncStorage에만 있어 재설치하면 초기화됐다.
여기가 그 값들의 실제 보관처다 (store_profiles 테이블, 이메일이 키).
"""

import re
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.core.auth import get_current_user
from app.core.database import get_db
from app.models.ai import StoreProfile
from app.models.user import User

router = APIRouter(prefix="/store", tags=["store"])

# "09:00" 같은 24시간 표기만 받는다 — 자정을 넘겨 닫는 가게가 있어 순서는 검사하지 않는다
_HHMM = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")


class StoreProfileOut(BaseModel):
    business_type: str
    open_hour: str
    close_hour: str
    # False면 아직 아무도 저장한 적이 없다는 뜻 — 앱이 기기에 남은 값을 올려도 안전하다
    configured: bool


class StoreProfileUpdate(BaseModel):
    """부분 수정 — 보낸 항목만 바꾼다 (안 보낸 값이 기본값으로 덮이지 않게)."""

    business_type: Optional[str] = Field(None, max_length=50)
    open_hour: Optional[str] = None
    close_hour: Optional[str] = None


def _validate_hour(label: str, value: str) -> str:
    if not _HHMM.match(value):
        raise HTTPException(status_code=422, detail=f"{label}은 HH:MM 형식이어야 합니다 (예: 09:00).")
    return value


def _get_or_create(db: Session, store_id: str) -> StoreProfile:
    row = db.query(StoreProfile).filter(StoreProfile.store_id == store_id).first()
    if row is None:
        # 아직 저장한 적 없는 매장은 기본값으로 만든다 — 조회할 때마다 404를 주면
        # 앱이 '설정 없음'과 '서버 오류'를 구분하기 어렵다.
        row = StoreProfile(store_id=store_id)
        db.add(row)
        db.commit()
        db.refresh(row)
    return row


@router.get("/profile", response_model=StoreProfileOut)
def get_store_profile(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """[매장 정보 조회] 업종·영업 시간. 저장한 적 없으면 기본값을 만들어 돌려준다."""
    row = _get_or_create(db, current_user.email)
    return StoreProfileOut(
        business_type=row.business_type,
        open_hour=row.open_hour,
        close_hour=row.close_hour,
        configured=row.configured,
    )


@router.put("/profile", response_model=StoreProfileOut)
def update_store_profile(
    payload: StoreProfileUpdate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """[매장 정보 저장] 보낸 항목만 갱신한다."""
    row = _get_or_create(db, current_user.email)

    if payload.business_type is not None:
        cleaned = payload.business_type.strip()
        if not cleaned:
            raise HTTPException(status_code=422, detail="업종을 입력해 주세요.")
        row.business_type = cleaned
    if payload.open_hour is not None:
        row.open_hour = _validate_hour("영업 시작 시각", payload.open_hour.strip())
    if payload.close_hour is not None:
        row.close_hour = _validate_hour("영업 종료 시각", payload.close_hour.strip())

    row.configured = True  # 이제부터는 사장님이 정한 값이다
    db.commit()
    db.refresh(row)
    return StoreProfileOut(
        business_type=row.business_type,
        open_hour=row.open_hour,
        close_hour=row.close_hour,
        configured=row.configured,
    )
