"""음성 비서(Assistant) API 라우터 — 1단계 (브리핑 / 다음 할 일) + 2단계 (알림 폴링) + 3단계 (음성 명령)

[매장 동기화] 로그인 토큰이 오면 그 매장(이메일) 직원·스케줄만 읽고 바꾼다.
예전엔 매장 구분 없이 전체를 읽어서, 음성 브리핑·완료 알림이 앱에 등록된 내 직원
데이터와 따로 놀았다. 토큰이 없으면 데모 매장(owner@cafe.com)으로 한정한다
— /chatbot/chat과 같은 정책. 무스코프(None)로 서비스에 넘기면 전 매장 스케줄이
읽히고 voice-command로는 남의 매장 출퇴근 기록까지 바뀐다.
"""
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Query, Depends, HTTPException
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy.orm import Session

from app.core.auth import get_current_user
from app.core.database import get_db
from app.schemas.operation import CommonResponse
from app.schemas.assistant import (
    BriefingResponse,
    NextTaskResponse,
    NotificationsResponse,
    VoiceCommandRequest,
    VoiceCommandResponse,
)
from app.services.operation.assistant_service import (
    assemble_briefing,
    assemble_next_task,
    assemble_notifications,
    get_pending_tasks,
    handle_voice_command,
)

# [한글 주석] prefix="/assistant" → 최종 경로: /api/v1/assistant/*
router = APIRouter(prefix="/assistant", tags=["Assistant (음성 비서)"])

_oauth2_optional = OAuth2PasswordBearer(tokenUrl="/api/v1/auth/login", auto_error=False)


def _optional_store_id(
    token: Optional[str] = Depends(_oauth2_optional),
    db: Session = Depends(get_db),
) -> str:
    """로그인했으면 매장 식별자(이메일)를, 아니면 데모 매장 — chatbot.py와 같은 패턴.

    절대 None을 돌려주지 않는다 — None이 서비스까지 내려가면 전 매장 무스코프 조회가 된다.
    """
    if not token:
        return "owner@cafe.com"
    try:
        return get_current_user(token=token, db=db).email
    except HTTPException:
        return "owner@cafe.com"


# ──────────────────────────────────────────────
# GET /api/v1/assistant/briefing
# ──────────────────────────────────────────────
@router.get("/briefing", response_model=CommonResponse)
def briefing_api(
    limit: int = Query(3, ge=1, le=10, description="음성 문단에 나열할 최대 작업 건수"),
    db: Session = Depends(get_db),
    store_id: Optional[str] = Depends(_optional_store_id),
):
    """오늘의 음성 브리핑을 생성합니다 (로그인 시 내 매장 직원 스케줄만).

    완료된 작업과 남은 할 일을 조회한 뒤,
    화면용 데이터(completed/pending 리스트)와 음성용 speech_text를 함께 반환합니다.
    """
    try:
        result: BriefingResponse = assemble_briefing(db, limit=limit, store_id=store_id)
        return CommonResponse(
            success=True,
            data=result.model_dump(),
            message="음성 브리핑이 생성되었습니다.",
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"브리핑 생성 중 오류: {str(e)}")


# ──────────────────────────────────────────────
# GET /api/v1/assistant/next-task
# ──────────────────────────────────────────────
@router.get("/next-task", response_model=CommonResponse)
def next_task_api(
    db: Session = Depends(get_db),
    store_id: Optional[str] = Depends(_optional_store_id),
):
    """우선순위/마감 기준으로 다음 할 일 1건을 반환합니다 (로그인 시 내 매장만).

    화면용 task 데이터와 음성용 speech_text를 함께 반환합니다.
    """
    try:
        result: NextTaskResponse = assemble_next_task(db, store_id=store_id)
        return CommonResponse(
            success=True,
            data=result.model_dump(),
            message="다음 할 일 조회가 완료되었습니다.",
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"다음 할 일 조회 중 오류: {str(e)}")


# ──────────────────────────────────────────────
# GET /api/v1/assistant/notifications
# [한글 주석] 프론트엔드가 주기적으로 폴링하여 새 완료 이벤트를 감지합니다.
# since 파라미터로 마지막 확인 시각을 넘기면, 그 이후의 알림만 반환합니다.
# ──────────────────────────────────────────────
@router.get("/notifications", response_model=CommonResponse)
def notifications_api(
    since: datetime = Query(
        ...,
        description="마지막 폴링 시각 (ISO 8601). 이 시각 이후 새로 완료된 작업만 반환합니다.",
        examples=["2026-07-22T14:00:00"],
    ),
    db: Session = Depends(get_db),
    store_id: Optional[str] = Depends(_optional_store_id),
):
    """since 이후 새로 완료된 작업 알림을 반환합니다 (로그인 시 내 매장 직원의 완료만).

    프론트엔드는 응답의 server_time을 다음 폴링의 since 값으로 사용합니다.
    """
    try:
        result: NotificationsResponse = assemble_notifications(db, since=since, store_id=store_id)
        return CommonResponse(
            success=True,
            data=result.model_dump(mode="json"),
            message=f"알림 {len(result.notifications)}건 조회 완료",
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"알림 조회 중 오류: {str(e)}")


# ──────────────────────────────────────────────
# POST /api/v1/assistant/voice-command
# [한글 주석] 프론트에서 STT로 변환한 텍스트를 받아 의도를 판단하고,
# 안전하다고 판단될 때만 기존 운영관리 로직을 호출해 상태를 변경합니다.
# ──────────────────────────────────────────────
@router.post("/voice-command", response_model=CommonResponse)
def voice_command_api(
    payload: VoiceCommandRequest,
    db: Session = Depends(get_db),
    store_id: Optional[str] = Depends(_optional_store_id),
):
    """음성 명령을 해석하고 실행합니다.

    안전 규칙:
      - intent가 unknown이거나 신뢰도가 낮으면 실행하지 않고 되묻습니다
        (status=needs_clarification).
      - 완료 같은 파괴적 명령은 곧바로 실행하지 않고 확인 문장을 먼저 반환합니다
        (status=needs_confirmation + pending_action).
        프론트엔드는 사용자의 다음 답변과 함께 pending_action을 그대로 되돌려 보냅니다.
      - 상태 변경은 전부 기존 OperationService를 통해 수행됩니다 (로직 중복 없음).
    """
    try:
        result: VoiceCommandResponse = handle_voice_command(
            db,
            text=payload.text,
            pending_action=payload.pending_action,
            confirm=payload.confirm,
            store_id=store_id,
        )
        return CommonResponse(
            success=True,
            data=result.model_dump(mode="json"),
            message=f"음성 명령 처리 완료 (intent={result.intent}, status={result.status})",
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"음성 명령 처리 중 오류: {str(e)}")
