"""음성 비서(Assistant) 비즈니스 로직 — 1단계 (브리핑·다음 할 일) + 3단계 (음성 명령)

기존 Schedule 모델의 actual_end_time 유무로 완료/미완료를 판별합니다.
향후 Todo 전용 모델을 도입하면 _fetch_* 함수만 교체하면 됩니다.

[한글 주석] 상태 변경은 이 파일에서 직접 하지 않습니다.
운영관리의 OperationService.update_schedule을 그대로 호출합니다 — 로직 중복 금지.
"""
import re
from datetime import datetime, date
from typing import List, Optional

from sqlalchemy.orm import Session

from app.models.operation import Schedule, Employee
from app.schemas.operation import ScheduleUpdate
from app.services.operation.operation_service import OperationService
from app.schemas.assistant import (
    TaskItem, BriefingResponse, NextTaskResponse,
    NotificationItem, NotificationsResponse,
    PendingAction, VoiceCommandResponse,
)


# ═══════════════════════════════════════════════════
# [한글 주석] 숫자 → 한국어 변환 유틸리티
# ═══════════════════════════════════════════════════

# 기본 한국어 숫자 단위 테이블
_KOREAN_DIGITS = {
    0: "", 1: "일", 2: "이", 3: "삼", 4: "사",
    5: "오", 6: "육", 7: "칠", 8: "팔", 9: "구",
}
_KOREAN_UNITS = ["", "십", "백", "천"]
_KOREAN_BIG_UNITS = ["", "만", "억", "조"]

# 순수 한국어 고유어 숫자 (1~99, 개수 세기용: "한 건", "두 건" 등)
_NATIVE_KOREAN = {
    1: "한", 2: "두", 3: "세", 4: "네", 5: "다섯",
    6: "여섯", 7: "일곱", 8: "여덟", 9: "아홉", 10: "열",
    11: "열한", 12: "열두", 13: "열세", 14: "열네", 15: "열다섯",
    16: "열여섯", 17: "열일곱", 18: "열여덟", 19: "열아홉", 20: "스물",
}

# 시각 읽기용 고유어 ("한 시", "두 시" … "열두 시")
_HOUR_KOREAN = {
    0: "열두", 1: "한", 2: "두", 3: "세", 4: "네", 5: "다섯",
    6: "여섯", 7: "일곱", 8: "여덟", 9: "아홉", 10: "열",
    11: "열한", 12: "열두",
}


def _number_to_sino_korean(n: int) -> str:
    """정수를 한국어 한자음 숫자로 변환합니다.

    비유: 전화번호를 읽듯이 "일이삼사" 식으로 읽는 방법입니다.
    예) 3000 → "삼천", 15 → "십오", 0 → "영"
    """
    if n == 0:
        return "영"
    if n < 0:
        return "마이너스 " + _number_to_sino_korean(-n)

    result = ""
    # 4자리씩 끊어서 만/억/조 단위로 처리
    big_unit_idx = 0
    while n > 0:
        chunk = n % 10000
        n //= 10000

        if chunk > 0:
            chunk_str = ""
            for i, unit in enumerate(_KOREAN_UNITS):
                digit = chunk % 10
                chunk //= 10
                if digit == 0:
                    continue
                # "일십", "일백", "일천"은 "십", "백", "천"으로 줄임
                prefix = "" if (digit == 1 and i > 0) else _KOREAN_DIGITS[digit]
                chunk_str = prefix + unit + chunk_str

            result = chunk_str + _KOREAN_BIG_UNITS[big_unit_idx] + result

        big_unit_idx += 1

    return result


def _native_count(n: int) -> str:
    """고유어 수사로 개수를 셉니다 (1~20 → "한"~"스물").

    20을 넘으면 한자어로 대체합니다.
    예) 3 → "세", 15 → "열다섯", 25 → "이십오"
    """
    if n in _NATIVE_KOREAN:
        return _NATIVE_KOREAN[n]
    return _number_to_sino_korean(n)


def _money_to_korean(amount: int) -> str:
    """금액을 한국어 음성용 문자열로 변환합니다.

    예) 3000 → "삼천 원", 10500 → "만 오백 원"
    """
    return f"{_number_to_sino_korean(amount)} 원"


def _time_to_korean(dt: datetime) -> str:
    """시각을 한국어 음성용 문자열로 변환합니다.

    예) 09:00 → "오전 아홉 시", 14:30 → "오후 두 시 삼십 분"
    """
    # 오전/오후 판별
    period = "오전" if dt.hour < 12 else "오후"
    # 12시간제로 변환
    h12 = dt.hour % 12
    hour_str = _HOUR_KOREAN.get(h12, _number_to_sino_korean(h12))

    if dt.minute == 0:
        return f"{period} {hour_str} 시"
    else:
        min_str = _number_to_sino_korean(dt.minute)
        return f"{period} {hour_str} 시 {min_str} 분"


# ═══════════════════════════════════════════════════
# [한글 주석] Schedule → TaskItem 변환 헬퍼
# ═══════════════════════════════════════════════════

def _schedule_to_task_item(schedule: Schedule, employee: Optional[Employee], status: str) -> TaskItem:
    """Schedule ORM 객체를 TaskItem 스키마로 변환합니다."""
    emp_name = employee.name if employee else f"직원#{schedule.employee_id}"
    start_str = schedule.start_time.strftime("%H:%M") if schedule.start_time else ""
    end_str = schedule.end_time.strftime("%H:%M") if schedule.end_time else ""
    title = f"{emp_name} 근무 {start_str}~{end_str}"

    return TaskItem(
        id=schedule.id,
        title=title,
        priority=0,  # 스케줄 기반이므로 기본 우선순위
        deadline=schedule.start_time,  # 근무 시작 시각을 마감으로 사용
        employee_name=emp_name,
        status=status,
    )


# ═══════════════════════════════════════════════════
# [한글 주석] 데이터 조회 함수 — Mock 확장 포인트
#   향후 Todo 모델 도입 시 이 함수들만 교체하면 됩니다.
# ═══════════════════════════════════════════════════

def _fetch_completed_tasks(db: Session, target_date: date) -> List[TaskItem]:
    """오늘 완료된 작업 목록을 조회합니다.

    판별 기준: Schedule의 actual_end_time이 존재하면 '완료'로 간주합니다.
    """
    date_str = target_date.strftime("%Y-%m-%d")
    schedules = (
        db.query(Schedule, Employee)
        .outerjoin(Employee, Schedule.employee_id == Employee.id)
        .filter(Schedule.date == date_str)
        .filter(Schedule.actual_end_time.isnot(None))
        .order_by(Schedule.start_time.asc())
        .all()
    )
    return [_schedule_to_task_item(s, e, "completed") for s, e in schedules]


def _fetch_pending_tasks(db: Session, target_date: date) -> List[TaskItem]:
    """오늘 아직 완료되지 않은 대기 작업 목록을 조회합니다.

    판별 기준: Schedule의 actual_end_time이 NULL이면 '대기 중'으로 간주합니다.
    """
    date_str = target_date.strftime("%Y-%m-%d")
    schedules = (
        db.query(Schedule, Employee)
        .outerjoin(Employee, Schedule.employee_id == Employee.id)
        .filter(Schedule.date == date_str)
        .filter(Schedule.actual_end_time.is_(None))
        .order_by(Schedule.start_time.asc())
        .all()
    )
    return [_schedule_to_task_item(s, e, "pending") for s, e in schedules]


# ═══════════════════════════════════════════════════
# [한글 주석] 핵심 비즈니스 로직
# ═══════════════════════════════════════════════════

def build_voice_briefing(
    completed: List[TaskItem],
    pending: List[TaskItem],
    limit: int = 3,
) -> str:
    """완료/대기 목록을 받아 사람이 듣기 자연스러운 한국어 한 문단을 생성합니다.

    비유: 아침 조회 때 반장이 "오늘 완료된 건 두 건이고…" 하고 읽어주는 느낌입니다.

    Args:
        completed: 완료된 작업 리스트
        pending: 대기 중인 작업 리스트
        limit: 음성 문단에 이름을 나열할 최대 건수

    Returns:
        speech_text (str): TTS에 바로 넘길 수 있는 한국어 문단
    """
    parts: List[str] = []

    # ── 완료 파트 ──
    c_count = len(completed)
    if c_count == 0:
        parts.append("오늘 완료된 작업은 아직 없습니다.")
    else:
        names = [t.title for t in completed[:limit]]
        names_joined = ", ".join(names)
        count_word = _native_count(c_count)

        if c_count <= limit:
            parts.append(f"오늘 완료된 작업은 {count_word} 건으로, {names_joined}입니다.")
        else:
            rest = c_count - limit
            rest_word = _native_count(rest)
            parts.append(
                f"오늘 완료된 작업은 총 {count_word} 건입니다. "
                f"그중 {names_joined} 외 {rest_word} 건이 더 있습니다."
            )

    # ── 대기 파트 ──
    p_count = len(pending)
    if p_count == 0:
        parts.append("남은 할 일은 모두 마무리되었습니다. 수고하셨습니다!")
    else:
        names = [t.title for t in pending[:limit]]
        names_joined = ", ".join(names)
        count_word = _native_count(p_count)

        if p_count <= limit:
            parts.append(f"남은 할 일은 {count_word} 건으로, {names_joined}이 있습니다.")
        else:
            rest = p_count - limit
            rest_word = _native_count(rest)
            parts.append(
                f"남은 할 일은 총 {count_word} 건입니다. "
                f"가장 가까운 일정은 {names_joined} 외 {rest_word} 건입니다."
            )

    return " ".join(parts)


def get_next_task(pending: List[TaskItem]) -> Optional[TaskItem]:
    """대기 목록에서 우선순위(priority 낮은 순) → 마감(deadline 빠른 순) 기준으로 다음 작업 1건을 반환합니다.

    비유: 시험 과목 중 가장 먼저 치르는 과목을 골라주는 것과 같습니다.
    """
    if not pending:
        return None

    def _sort_key(t: TaskItem):
        # priority 낮을수록 급함 → 오름차순
        # deadline 빠를수록 급함 → 오름차순 (None이면 맨 뒤로)
        dl = t.deadline if t.deadline else datetime.max
        return (t.priority, dl)

    sorted_tasks = sorted(pending, key=_sort_key)
    return sorted_tasks[0]


def get_pending_tasks(db: Session, limit: int = 5) -> List[TaskItem]:
    """DB에서 오늘 남은 대기 할 일을 상위 N건 조회하여 반환합니다."""
    today = date.today()
    all_pending = _fetch_pending_tasks(db, today)

    # 우선순위 → 마감 순으로 정렬 후 상위 N건
    def _sort_key(t: TaskItem):
        dl = t.deadline if t.deadline else datetime.max
        return (t.priority, dl)

    return sorted(all_pending, key=_sort_key)[:limit]


# ═══════════════════════════════════════════════════
# [한글 주석] 브리핑 조립 — API 레이어에서 호출하는 최상위 함수
# ═══════════════════════════════════════════════════

def assemble_briefing(db: Session, limit: int = 3) -> BriefingResponse:
    """오늘의 전체 브리핑을 조립하여 BriefingResponse를 반환합니다.

    1. DB에서 완료/대기 목록 조회
    2. 음성 문단(speech_text) 생성
    3. 응답 스키마에 담아 반환
    """
    today = date.today()
    completed = _fetch_completed_tasks(db, today)
    pending = _fetch_pending_tasks(db, today)
    speech_text = build_voice_briefing(completed, pending, limit=limit)

    return BriefingResponse(
        completed=completed,
        pending=pending,
        speech_text=speech_text,
    )


def assemble_next_task(db: Session) -> NextTaskResponse:
    """다음 할 일 1건을 조립하여 NextTaskResponse를 반환합니다."""
    today = date.today()
    pending = _fetch_pending_tasks(db, today)
    next_task = get_next_task(pending)

    if next_task is None:
        speech_text = "현재 남은 할 일이 없습니다. 오늘도 수고하셨습니다!"
    else:
        # 시각을 한국어로 변환
        time_str = ""
        if next_task.deadline:
            time_str = f" {_time_to_korean(next_task.deadline)}"

        emp_str = next_task.employee_name or "담당자 미정"
        speech_text = f"다음 할 일은 {emp_str} 님의{time_str} 근무입니다."

    return NextTaskResponse(
        task=next_task,
        speech_text=speech_text,
    )


# ═══════════════════════════════════════════════════
# [한글 주석] 2단계: 알림 폴링 — 새 완료 이벤트 감지
# ═══════════════════════════════════════════════════

def _fetch_new_completions(db: Session, since: datetime) -> List[NotificationItem]:
    """since 이후에 actual_end_time이 채워진(완료된) 스케줄을 조회합니다.

    비유: "마지막으로 확인한 이후에 새로 끝난 일이 있나?"를 묻는 것입니다.
    프론트엔드가 주기적으로 since 값을 갱신하며 호출하면,
    새로 완료된 건만 차분(diff)으로 받아갈 수 있습니다.
    """
    schedules = (
        db.query(Schedule, Employee)
        .outerjoin(Employee, Schedule.employee_id == Employee.id)
        .filter(Schedule.actual_end_time.isnot(None))
        .filter(Schedule.actual_end_time > since)
        .order_by(Schedule.actual_end_time.asc())
        .all()
    )

    notifications: List[NotificationItem] = []
    for schedule, employee in schedules:
        emp_name = employee.name if employee else f"직원#{schedule.employee_id}"
        start_str = schedule.start_time.strftime("%H:%M") if schedule.start_time else ""
        end_str = schedule.end_time.strftime("%H:%M") if schedule.end_time else ""

        # 화면용 제목
        title = f"{emp_name} 근무 완료 ({start_str}~{end_str})"

        # 음성용 문구 — 시각을 한국어로 자연스럽게
        time_str = ""
        if schedule.start_time:
            time_str = f" {_time_to_korean(schedule.start_time)}"
        speech_text = f"{emp_name} 님의{time_str} 근무가 완료되었습니다."

        notifications.append(NotificationItem(
            id=schedule.id,
            event_type="task_completed",
            title=title,
            speech_text=speech_text,
            completed_at=schedule.actual_end_time,
        ))

    return notifications


def assemble_notifications(db: Session, since: datetime) -> NotificationsResponse:
    """since 이후의 새 알림을 조립하여 NotificationsResponse를 반환합니다.

    프론트엔드는 응답의 server_time을 다음 폴링의 since로 사용합니다.
    """
    notifications = _fetch_new_completions(db, since)
    return NotificationsResponse(
        notifications=notifications,
        server_time=datetime.now(),
    )


# ═══════════════════════════════════════════════════
# [한글 주석] 3단계: 음성 명령 파싱
#   1차 구현은 키워드/정규식 매칭입니다.
#   나중에 LLM 기반으로 바꾸더라도 parse_voice_command의
#   시그니처(text → (intent, confidence))만 지키면 나머지는 그대로 씁니다.
# ═══════════════════════════════════════════════════

# 신뢰도 임계값 — 이 값 미만이면 실행하지 않고 되묻습니다.
CONFIDENCE_THRESHOLD = 0.55

# 확실한 단서(strong)와 애매한 단서(weak)의 가중치
_STRONG = 1.0
_WEAK = 0.6

# [한글 주석] intent별 판별 패턴.
#   strong = 이 표현이 나오면 의도가 거의 확실한 것
#   weak   = 단독으로는 애매해서 다른 단서와 함께 봐야 하는 것
#   예) "다음"만으로는 "다음 거 시작해"인지 "다음 할 일 뭐야"인지 알 수 없으므로 weak.
_INTENT_PATTERNS: dict = {
    "complete_task": {
        "strong": [
            r"완료",
            r"끝(났|냈|내|났어|냈어)",
            r"마쳤|마무리",
            r"퇴근\s*(처리|했)",
            r"done",
        ],
        "weak": [r"처리\s*해"],
    },
    "start_next_task": {
        "strong": [
            r"시작",
            r"출근\s*(처리|했)",
            r"진행\s*(해|할)",
            r"착수",
            r"start",
        ],
        "weak": [r"다음", r"next"],
    },
    "read_pending": {
        "strong": [
            r"뭐(야|예요|입니까|니|가\s*있|\s*있)",
            r"알려\s*줘",
            r"읽어\s*줘",
            r"말해\s*줘",
            r"목록",
            r"브리핑",
            r"얼마나\s*(남|있)",
            r"(남은|남아\s*있는).*(일|작업|것|거)",
            r"몇\s*(건|개)",
        ],
        "weak": [r"할\s*일", r"작업\s*(목록)?", r"남았"],
    },
}

# 확인 응답(예/아니오) 판별 패턴
# [한글 주석] 부정을 먼저 검사합니다 — "아니네"처럼 부정 표현 안에 "네"가 들어있기 때문입니다.
_NO_PATTERN = re.compile(r"(아니|아냐|아뇨|취소|그만|됐어|됐습니다|하지\s*마|안\s*해|no)", re.IGNORECASE)
_YES_PATTERN = re.compile(
    r"(^|\s)(네|예|응|어|그래|맞아|맞아요|좋아|확인|오케이|오케|진행|해\s*줘|해줘|yes|ok)($|\s|요|\.|!)",
    re.IGNORECASE,
)


def _normalize(text: str) -> str:
    """앞뒤 공백을 없애고 연속 공백을 하나로 줄입니다."""
    return re.sub(r"\s+", " ", text or "").strip()


def parse_voice_command(text: str) -> tuple:
    """음성 텍스트에서 의도(intent)와 신뢰도(confidence)를 파싱합니다.

    비유: 손님 말을 듣고 "주문이구나 / 문의구나"를 가려내는 것과 같습니다.
    확실한 단어(strong)와 애매한 단어(weak)에 점수를 매긴 뒤,
    1등과 2등의 점수 차가 얼마나 벌어졌는지로 확신의 정도를 계산합니다.

    Args:
        text: STT로 변환된 사용자 발화

    Returns:
        (intent, confidence) 튜플.
        intent는 start_next_task / complete_task / read_pending / unknown 중 하나이며,
        confidence는 0.0~1.0 입니다.
    """
    normalized = _normalize(text)
    if not normalized:
        return "unknown", 0.0

    # ── 1) intent별 점수 집계 ──
    scores: dict = {}
    for intent, patterns in _INTENT_PATTERNS.items():
        score = 0.0
        for pattern in patterns["strong"]:
            if re.search(pattern, normalized, re.IGNORECASE):
                score += _STRONG
        for pattern in patterns["weak"]:
            if re.search(pattern, normalized, re.IGNORECASE):
                score += _WEAK
        scores[intent] = score

    # ── 2) 1등 / 2등 추출 ──
    ranked = sorted(scores.items(), key=lambda kv: kv[1], reverse=True)
    best_intent, best_score = ranked[0]
    runner_up_score = ranked[1][1] if len(ranked) > 1 else 0.0

    # 아무 단서도 없으면 unknown
    if best_score <= 0:
        return "unknown", 0.0

    # ── 3) 신뢰도 계산 ──
    # margin_ratio: 1등이 2등을 얼마나 앞섰는가 (동점이면 0.5, 독주면 1.0)
    margin_ratio = best_score / (best_score + runner_up_score)
    # evidence: 단서가 얼마나 확실한가 (weak 하나만 걸리면 0.6에 그침)
    evidence = min(1.0, best_score / _STRONG)
    confidence = round(margin_ratio * evidence, 2)

    return best_intent, confidence


def _parse_confirmation(text: str) -> Optional[bool]:
    """확인 단계의 답변을 예(True)/아니오(False)/모호함(None)으로 해석합니다."""
    normalized = _normalize(text)
    if not normalized:
        return None
    # 부정을 먼저 검사 ("아니네"에 "네"가 포함되므로)
    if _NO_PATTERN.search(normalized):
        return False
    if _YES_PATTERN.search(f" {normalized} "):
        return True
    return None


# ═══════════════════════════════════════════════════
# [한글 주석] 명령 대상(작업) 찾기
# ═══════════════════════════════════════════════════

def _resolve_target_task(text: str, pending: List[TaskItem]) -> Optional[TaskItem]:
    """발화 내용에서 명령의 대상이 될 작업 1건을 찾아냅니다.

    우선순위:
      1. "3번" 처럼 작업 ID를 직접 말한 경우
      2. "홍길동" 처럼 담당자 이름을 말한 경우
      3. 아무 언급도 없으면 → 가장 급한 작업(다음 할 일)
    """
    if not pending:
        return None

    normalized = _normalize(text)

    # 1) ID 지정 — "3번 완료"
    id_match = re.search(r"(\d+)\s*번", normalized)
    if id_match:
        target_id = int(id_match.group(1))
        for task in pending:
            if task.id == target_id:
                return task

    # 2) 담당자 이름 지정 — "홍길동 완료"
    for task in pending:
        if task.employee_name and task.employee_name in normalized:
            return task

    # 3) 기본값 — 가장 급한 작업
    return get_next_task(pending)


# ═══════════════════════════════════════════════════
# [한글 주석] 실제 상태 변경 — 기존 OperationService를 그대로 호출합니다.
#   여기서 db.commit()이나 필드 대입을 직접 하지 않는 것이 핵심입니다.
# ═══════════════════════════════════════════════════

def _apply_start(db: Session, task: TaskItem) -> Schedule:
    """작업을 '시작' 상태로 만듭니다 (actual_start_time 기록)."""
    return OperationService.update_schedule(
        db,
        task.id,
        ScheduleUpdate(actual_start_time=datetime.now()),
    )


def _apply_complete(db: Session, task: TaskItem) -> Schedule:
    """작업을 '완료' 상태로 만듭니다 (actual_end_time 기록)."""
    return OperationService.update_schedule(
        db,
        task.id,
        ScheduleUpdate(actual_end_time=datetime.now()),
    )


def _task_phrase(task: TaskItem) -> str:
    """작업을 음성으로 읽기 좋은 짧은 표현으로 만듭니다.

    예) "홍길동 님의 오전 아홉 시 근무"
    """
    emp = task.employee_name or "담당자 미정"
    time_str = f" {_time_to_korean(task.deadline)}" if task.deadline else ""
    return f"{emp} 님의{time_str} 근무"


# ═══════════════════════════════════════════════════
# [한글 주석] 음성 명령 처리 — API 레이어에서 호출하는 최상위 함수
# ═══════════════════════════════════════════════════

def handle_voice_command(
    db: Session,
    text: str,
    pending_action: Optional[PendingAction] = None,
    confirm: bool = False,
) -> VoiceCommandResponse:
    """음성 명령 한 건을 해석하고, 안전하면 실행합니다.

    안전 규칙:
      1. intent가 unknown이거나 신뢰도가 임계값 미만이면 → 실행하지 않고 되묻습니다.
      2. 완료처럼 되돌리기 어려운 명령은 → 먼저 확인 문장을 반환하고, 다음 발화에서 실행합니다.
      3. 상태 변경은 전부 OperationService를 통해서만 수행합니다.

    Args:
        db: DB 세션
        text: STT로 변환된 사용자 발화
        pending_action: 직전 응답에서 내려준 확인 대기 명령 (있으면 text는 예/아니오 답변)
        confirm: 화면 버튼 등으로 이미 명시적 승인을 받은 경우 True

    Returns:
        VoiceCommandResponse — 수행 결과와 speech_text 포함
    """
    transcript = _normalize(text)

    # ══════════════════════════════════════
    # 경로 A: 확인 대기 중 → 이번 발화는 예/아니오 답변
    # ══════════════════════════════════════
    if pending_action is not None:
        answer = _parse_confirmation(transcript)

        # 답이 모호하면 실행하지 않고 같은 질문을 다시 던집니다.
        if answer is None:
            return VoiceCommandResponse(
                transcript=transcript,
                intent=pending_action.intent,
                confidence=0.0,
                status="needs_confirmation",
                executed=False,
                speech_text=(
                    f"{pending_action.task_title} 을(를) 완료 처리할까요? "
                    f"'네' 또는 '아니오'로 답해 주세요."
                ),
                pending_action=pending_action,  # 확인 대기 유지
            )

        # 사용자가 거절 → 아무것도 하지 않습니다.
        if answer is False:
            return VoiceCommandResponse(
                transcript=transcript,
                intent=pending_action.intent,
                confidence=1.0,
                status="cancelled",
                executed=False,
                speech_text="명령을 취소했습니다.",
            )

        # 사용자가 승인 → 여기서 비로소 실행합니다.
        return _execute_confirmed_action(db, transcript, pending_action)

    # ══════════════════════════════════════
    # 경로 B: 새 명령 파싱
    # ══════════════════════════════════════
    intent, confidence = parse_voice_command(transcript)

    # ── 안전 규칙 1: 모르겠거나 확신이 없으면 되묻습니다 ──
    if intent == "unknown" or confidence < CONFIDENCE_THRESHOLD:
        return VoiceCommandResponse(
            transcript=transcript,
            intent="unknown" if intent == "unknown" else intent,
            confidence=confidence,
            status="needs_clarification",
            executed=False,
            speech_text=(
                "죄송합니다, 잘 알아듣지 못했습니다. "
                "'다음 작업 시작해줘', '지금 작업 완료', '남은 할 일 알려줘' 중에서 다시 말씀해 주세요."
            ),
        )

    today = date.today()
    pending = _fetch_pending_tasks(db, today)

    # ── read_pending: 읽기 전용이라 확인 없이 바로 수행 ──
    if intent == "read_pending":
        top_tasks = get_pending_tasks(db, limit=5)
        completed = _fetch_completed_tasks(db, today)
        return VoiceCommandResponse(
            transcript=transcript,
            intent=intent,
            confidence=confidence,
            status="executed",
            executed=True,
            speech_text=build_voice_briefing(completed, pending, limit=3),
            tasks=top_tasks,
        )

    # ── start_next_task: 되돌릴 수 있는 명령이라 바로 실행 ──
    if intent == "start_next_task":
        target = _resolve_target_task(transcript, pending)
        if target is None:
            return VoiceCommandResponse(
                transcript=transcript,
                intent=intent,
                confidence=confidence,
                status="failed",
                executed=False,
                speech_text="시작할 수 있는 남은 작업이 없습니다.",
            )

        # 이미 시작된 작업이면 덮어쓰지 않습니다 (기록 손실 방지).
        schedule = OperationService.get_schedule_by_id(db, target.id)
        if schedule is not None and schedule.actual_start_time is not None:
            return VoiceCommandResponse(
                transcript=transcript,
                intent=intent,
                confidence=confidence,
                status="failed",
                executed=False,
                speech_text=(
                    f"{_task_phrase(target)}는 이미 "
                    f"{_time_to_korean(schedule.actual_start_time)}에 시작된 상태입니다."
                ),
                task=target,
            )

        try:
            _apply_start(db, target)
        except ValueError as e:
            return VoiceCommandResponse(
                transcript=transcript,
                intent=intent,
                confidence=confidence,
                status="failed",
                executed=False,
                speech_text=f"작업을 시작하지 못했습니다. {str(e)}",
                task=target,
            )

        return VoiceCommandResponse(
            transcript=transcript,
            intent=intent,
            confidence=confidence,
            status="executed",
            executed=True,
            speech_text=f"{_task_phrase(target)}를 시작했습니다.",
            task=target,
        )

    # ── 안전 규칙 2: complete_task는 파괴적 → 확인 문장만 먼저 반환 ──
    if intent == "complete_task":
        target = _resolve_target_task(transcript, pending)
        if target is None:
            return VoiceCommandResponse(
                transcript=transcript,
                intent=intent,
                confidence=confidence,
                status="failed",
                executed=False,
                speech_text="완료 처리할 남은 작업이 없습니다.",
            )

        action = PendingAction(
            intent="complete_task",
            task_id=target.id,
            task_title=target.title,
        )

        # confirm=True는 화면 버튼 등으로 이미 승인을 받은 경우입니다.
        if confirm:
            return _execute_confirmed_action(db, transcript, action, confidence=confidence)

        return VoiceCommandResponse(
            transcript=transcript,
            intent=intent,
            confidence=confidence,
            status="needs_confirmation",
            executed=False,  # 아직 실행하지 않았음을 분명히 합니다
            speech_text=f"{_task_phrase(target)}를 완료 처리할까요? 맞으면 '네'라고 답해 주세요.",
            task=target,
            pending_action=action,
        )

    # 방어적 분기 — 위에서 모든 intent를 처리하므로 도달하지 않습니다.
    return VoiceCommandResponse(
        transcript=transcript,
        intent="unknown",
        confidence=0.0,
        status="needs_clarification",
        executed=False,
        speech_text="처리할 수 없는 명령입니다. 다시 말씀해 주세요.",
    )


def _execute_confirmed_action(
    db: Session,
    transcript: str,
    action: PendingAction,
    confidence: float = 1.0,
) -> VoiceCommandResponse:
    """사용자 승인이 끝난 파괴적 명령을 실제로 실행합니다."""
    # 확인을 주고받는 사이에 상황이 바뀌었을 수 있으므로 대상을 다시 확인합니다.
    schedule = OperationService.get_schedule_by_id(db, action.task_id)
    if schedule is None:
        return VoiceCommandResponse(
            transcript=transcript,
            intent=action.intent,
            confidence=confidence,
            status="failed",
            executed=False,
            speech_text="해당 작업을 찾을 수 없습니다. 이미 삭제되었을 수 있습니다.",
        )

    if action.intent != "complete_task":
        return VoiceCommandResponse(
            transcript=transcript,
            intent=action.intent,
            confidence=confidence,
            status="failed",
            executed=False,
            speech_text="확인이 필요한 명령이 아닙니다.",
        )

    # 이미 완료된 작업이면 중복 처리하지 않습니다.
    if schedule.actual_end_time is not None:
        return VoiceCommandResponse(
            transcript=transcript,
            intent=action.intent,
            confidence=confidence,
            status="failed",
            executed=False,
            speech_text=f"{action.task_title} 은(는) 이미 완료된 작업입니다.",
        )

    employee = db.query(Employee).filter(Employee.id == schedule.employee_id).first()
    target = _schedule_to_task_item(schedule, employee, "pending")

    try:
        _apply_complete(db, target)
    except ValueError as e:
        return VoiceCommandResponse(
            transcript=transcript,
            intent=action.intent,
            confidence=confidence,
            status="failed",
            executed=False,
            speech_text=f"완료 처리하지 못했습니다. {str(e)}",
            task=target,
        )

    # 완료 후 남은 할 일을 함께 안내합니다.
    remaining = _fetch_pending_tasks(db, date.today())
    if remaining:
        tail = f" 남은 할 일은 {_native_count(len(remaining))} 건입니다."
    else:
        tail = " 오늘 남은 할 일을 모두 마쳤습니다. 수고하셨습니다!"

    return VoiceCommandResponse(
        transcript=transcript,
        intent=action.intent,
        confidence=confidence,
        status="executed",
        executed=True,
        speech_text=f"{_task_phrase(target)}를 완료 처리했습니다.{tail}",
        task=target,
        tasks=remaining,
    )

