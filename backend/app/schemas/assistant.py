"""음성 비서(Assistant) API 요청/응답 스키마 (1단계 + 2단계 알림 + 3단계 음성 명령)"""
from datetime import datetime
from typing import List, Literal, Optional
from pydantic import BaseModel, Field, ConfigDict


# ──────────────────────────────────────────────
# [한글 주석] 할 일(Task) 1건을 표현하는 공용 아이템 스키마
# ──────────────────────────────────────────────
class TaskItem(BaseModel):
    """브리핑에 표시되는 개별 할 일/완료 항목"""

    id: int = Field(..., description="작업 고유 ID", examples=[1])
    title: str = Field(..., description="작업 제목 (사람이 읽기 쉬운 한 줄 요약)", examples=["홍길동 근무 09:00~18:00"])
    priority: int = Field(
        0,
        description="우선순위 (숫자가 낮을수록 높은 우선순위, 0=기본)",
        examples=[0],
    )
    deadline: Optional[datetime] = Field(
        None,
        description="마감 시각 (스케줄의 경우 근무 시작 시각)",
        examples=["2026-07-22T09:00:00"],
    )
    employee_name: Optional[str] = Field(
        None,
        description="담당 직원 이름",
        examples=["홍길동"],
    )
    status: str = Field(
        "pending",
        description="상태 — 'completed' 또는 'pending'",
        examples=["pending"],
    )

    model_config = ConfigDict(from_attributes=True)


# ──────────────────────────────────────────────
# [한글 주석] 브리핑 응답 — 완료 목록 + 대기 목록 + 음성 문단
# ──────────────────────────────────────────────
class BriefingResponse(BaseModel):
    """음성 브리핑 전체 응답"""

    completed: List[TaskItem] = Field(
        default_factory=list,
        description="오늘 완료된 작업 목록",
    )
    pending: List[TaskItem] = Field(
        default_factory=list,
        description="오늘 남은 대기 작업 목록",
    )
    speech_text: str = Field(
        ...,
        description="TTS 용 한국어 음성 문단 (숫자·통화 한국어로 풀어쓴 버전)",
        examples=["오늘 완료된 작업은 두 건이고, 남은 할 일은 세 건입니다."],
    )


# ──────────────────────────────────────────────
# [한글 주석] 다음 할 일 응답 — 가장 급한 작업 1건 + 음성 문구
# ──────────────────────────────────────────────
class NextTaskResponse(BaseModel):
    """다음 할 일 1건 응답"""

    task: Optional[TaskItem] = Field(
        None,
        description="우선순위/마감 기준 가장 급한 다음 작업 (없으면 null)",
    )
    speech_text: str = Field(
        ...,
        description="TTS 용 한국어 음성 문구",
        examples=["다음 할 일은 홍길동 님의 오전 아홉 시 근무입니다."],
    )


# ──────────────────────────────────────────────
# [한글 주석] 2단계: 알림 폴링 — 새로 완료된 작업을 음성으로 안내
# ──────────────────────────────────────────────
class NotificationItem(BaseModel):
    """음성 알림 1건 — 새로 완료된 작업에 대한 안내"""

    id: int = Field(..., description="알림 대상 스케줄 ID", examples=[42])
    event_type: str = Field(
        "task_completed",
        description="이벤트 유형 (현재는 task_completed만 지원)",
        examples=["task_completed"],
    )
    title: str = Field(
        ...,
        description="알림 제목 (화면 표시용)",
        examples=["홍길동 근무 완료"],
    )
    speech_text: str = Field(
        ...,
        description="TTS 용 한국어 음성 문구",
        examples=["홍길동 님의 오전 아홉 시 근무가 완료되었습니다."],
    )
    completed_at: Optional[datetime] = Field(
        None,
        description="작업 완료 시각",
        examples=["2026-07-22T18:05:00"],
    )


class NotificationsResponse(BaseModel):
    """음성 알림 폴링 응답"""

    notifications: List[NotificationItem] = Field(
        default_factory=list,
        description="since 이후 새로 발생한 알림 목록",
    )
    server_time: datetime = Field(
        ...,
        description="서버 현재 시각 — 다음 폴링의 since 값으로 사용",
        examples=["2026-07-22T14:30:00"],
    )


# ──────────────────────────────────────────────
# [한글 주석] 3단계: 음성 명령 — 말로 작업을 시작/완료/조회
# ──────────────────────────────────────────────

# 지원하는 의도(intent) 목록
VoiceIntent = Literal["start_next_task", "complete_task", "read_pending", "unknown"]

# 명령 처리 결과 상태
#   executed             — 실제로 상태를 변경했거나 조회를 마침
#   needs_confirmation   — 파괴적 명령이라 확인을 먼저 받아야 함 (아직 실행 안 함)
#   needs_clarification  — intent가 unknown이거나 신뢰도가 낮아 되물음 (아직 실행 안 함)
#   cancelled            — 사용자가 확인 단계에서 취소함
#   failed               — 실행을 시도했으나 오류/대상 없음
VoiceCommandStatus = Literal[
    "executed", "needs_confirmation", "needs_clarification", "cancelled", "failed"
]


class PendingAction(BaseModel):
    """확인 대기 중인 파괴적 명령 1건.

    [한글 주석] 서버는 세션 상태를 들고 있지 않습니다.
    이 객체를 응답으로 내려주면 프론트엔드가 그대로 다시 보내주고("네"라는 답과 함께),
    서버는 그때 비로소 실행합니다. — 확인 절차를 무상태(stateless)로 구현하는 방법입니다.
    """

    intent: VoiceIntent = Field(..., description="확인을 기다리는 의도", examples=["complete_task"])
    task_id: int = Field(..., description="대상 작업(스케줄) ID", examples=[42])
    task_title: str = Field(
        ...,
        description="대상 작업 제목 (사용자에게 되읽어 주기 위한 용도)",
        examples=["홍길동 근무 09:00~18:00"],
    )


class VoiceCommandRequest(BaseModel):
    """음성 명령 요청 — 프론트에서 STT로 변환한 텍스트를 보냅니다."""

    text: str = Field(
        ...,
        min_length=1,
        max_length=500,
        description="사용자가 말한 내용을 STT로 변환한 텍스트",
        examples=["다음 작업 시작해줘"],
    )
    pending_action: Optional[PendingAction] = Field(
        None,
        description=(
            "직전 응답에서 받은 확인 대기 명령. "
            "이 값이 있으면 text는 '네/아니오' 형태의 확인 답변으로 해석됩니다."
        ),
    )
    confirm: bool = Field(
        False,
        description=(
            "화면의 확인 버튼처럼 명시적으로 승인된 경우 true. "
            "true이면 pending_action을 되묻지 않고 바로 실행합니다."
        ),
        examples=[False],
    )


class VoiceCommandResponse(BaseModel):
    """음성 명령 처리 결과"""

    transcript: str = Field(..., description="서버가 해석한 원본 텍스트", examples=["다음 작업 시작해줘"])
    intent: VoiceIntent = Field(..., description="파싱된 의도", examples=["start_next_task"])
    confidence: float = Field(
        ...,
        ge=0.0,
        le=1.0,
        description="의도 파싱 신뢰도 (0.0~1.0). 임계값 미만이면 실행하지 않고 되묻습니다.",
        examples=[0.92],
    )
    status: VoiceCommandStatus = Field(..., description="처리 상태", examples=["executed"])
    executed: bool = Field(
        ...,
        description="실제로 상태 변경/조회가 수행되었는지 여부",
        examples=[True],
    )
    speech_text: str = Field(
        ...,
        description="TTS 용 한국어 응답 문구 (되묻기/확인 문장도 여기에 담깁니다)",
        examples=["홍길동 님의 오전 아홉 시 근무를 시작했습니다."],
    )
    task: Optional[TaskItem] = Field(
        None,
        description="명령의 대상이 된 작업 (없으면 null)",
    )
    tasks: List[TaskItem] = Field(
        default_factory=list,
        description="read_pending 등 목록을 반환하는 명령의 결과 목록",
    )
    pending_action: Optional[PendingAction] = Field(
        None,
        description=(
            "status가 needs_confirmation일 때 채워집니다. "
            "프론트엔드는 사용자의 다음 발화와 함께 이 값을 그대로 되돌려 보내야 합니다."
        ),
    )

