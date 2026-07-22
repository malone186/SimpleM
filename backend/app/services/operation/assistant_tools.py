"""음성 비서(Assistant) 챗봇 도구 래퍼 (백엔드 B)

[한글 주석] 이 파일에는 비즈니스 로직을 넣지 않습니다.
assistant_service.py의 함수를 호출해 JSON으로 포장하는 얇은 껍데기입니다.

왜 상태 변경 도구가 handle_voice_command를 경유하는가:
  완료/시작 처리를 _apply_complete 같은 내부 함수로 직접 부르면
  음성 경로에 있는 "확인 후 실행" 안전장치를 에이전트가 통째로 건너뛰게 됩니다.
  게다가 근무 완료 시각(actual_end_time)은 OperationService.calculate_payroll의
  입력값이라 급여 계산에 그대로 반영됩니다 — 되돌리기 어려운 액션입니다.
  그래서 안전 규칙이 한 곳(handle_voice_command)에만 존재하도록 경유시킵니다.
"""
from typing import Optional

from app.services.operation.assistant_service import (
    assemble_briefing,      # 내부에서 build_voice_briefing 호출
    assemble_next_task,     # 내부에서 get_next_task 호출
    handle_voice_command,   # 안전 규칙(되묻기/확인)이 들어있는 단일 진입점
)

# LangChain @tool 데코레이터 안전 로드 구조 (operation_tools.py와 동일)
try:
    from langchain.tools import tool
except ImportError:
    try:
        from langchain_core.tools import tool
    except ImportError:
        def tool(func):
            return func


# ═══════════════════════════════════════════════════
# [한글 주석] 조회 도구 — 상태를 바꾸지 않으므로 확인 절차가 없습니다.
# ═══════════════════════════════════════════════════

@tool
def get_voice_briefing_tool(limit: int = 3) -> dict:
    """오늘의 완료된 작업과 남은 할 일을 음성용 한국어 문단으로 요약합니다.
    "오늘 브리핑 해줘", "오늘 뭐 했지", "상황 정리해줘" 같은 질문에 사용합니다.
    - limit: 음성 문단에 이름을 나열할 최대 작업 건수 (기본 3)
    """
    try:
        from app.core.database import SessionLocal
        with SessionLocal() as db:
            # [한글 주석] assemble_briefing이 내부에서 build_voice_briefing을 호출합니다.
            result = assemble_briefing(db, limit=limit)

        return {
            "success": True,
            "data": result.model_dump(mode="json"),
            "documents": [],
            "message": "오늘의 음성 브리핑이 생성되었습니다.",
        }
    except Exception as e:
        return {
            "success": False,
            "data": None,
            "documents": [],
            "message": f"음성 브리핑 생성 중 서버 오류 발생: {str(e)}",
        }


@tool
def get_next_task_tool() -> dict:
    """우선순위와 마감 시각을 기준으로 지금 해야 할 다음 작업 1건을 조회합니다.
    "다음 뭐 해야 해?", "이제 뭐 하지?" 같은 질문에 사용합니다.
    상태를 바꾸지 않고 조회만 합니다 — 실제로 시작하려면 start_next_task_by_voice_tool을 쓰세요.
    """
    try:
        from app.core.database import SessionLocal
        with SessionLocal() as db:
            # [한글 주석] assemble_next_task가 내부에서 get_next_task를 호출합니다.
            result = assemble_next_task(db)

        return {
            "success": True,
            "data": result.model_dump(mode="json"),
            "documents": [],
            "message": "다음 할 일 조회가 완료되었습니다.",
        }
    except Exception as e:
        return {
            "success": False,
            "data": None,
            "documents": [],
            "message": f"다음 할 일 조회 중 서버 오류 발생: {str(e)}",
        }


# ═══════════════════════════════════════════════════
# [한글 주석] 상태 변경 도구 — 확인 절차를 반드시 거칩니다.
# ═══════════════════════════════════════════════════

@tool
def complete_task_by_voice_tool(task_hint: str = "", confirm: bool = False) -> dict:
    """근무/작업을 완료 처리합니다. 되돌리기 어려운 작업이므로 반드시 두 번에 나눠 호출하세요.

    1단계) confirm=False (기본) 로 호출하면 실행하지 않고 확인 문장만 돌려줍니다.
           그 문장을 사용자에게 그대로 보여주고 승인을 받으세요.
    2단계) 사용자가 승인하면 같은 task_hint로 confirm=True로 다시 호출하세요.

    사용자 승인 없이 confirm=True로 곧바로 호출하면 안 됩니다.
    완료 시각은 급여 계산에 반영됩니다.
    - task_hint: 대상 지정 힌트. 직원 이름('홍길동') 또는 작업 번호('3번').
                 비우면 가장 급한 작업이 대상이 됩니다.
    - confirm: 사용자 승인을 받았으면 True (기본 False)
    """
    try:
        # [한글 주석] 안전 규칙이 들어있는 단일 진입점을 그대로 호출합니다.
        # confirm=False면 handle_voice_command가 needs_confirmation만 반환하고 실행하지 않습니다.
        command_text = f"{task_hint} 완료".strip()

        from app.core.database import SessionLocal
        with SessionLocal() as db:
            result = handle_voice_command(db, text=command_text, confirm=confirm)

        data = result.model_dump(mode="json")
        return {
            "success": result.status != "failed",
            "data": data,
            "documents": [],
            "message": (
                result.speech_text
                if result.executed
                else f"[확인 필요] {result.speech_text}"
            ),
        }
    except Exception as e:
        return {
            "success": False,
            "data": None,
            "documents": [],
            "message": f"작업 완료 처리 중 서버 오류 발생: {str(e)}",
        }


@tool
def start_next_task_by_voice_tool(task_hint: str = "") -> dict:
    """다음 작업을 시작 상태로 만듭니다 (실제 출근 시각 기록).

    되돌릴 수 있는 작업이라 확인 없이 바로 실행됩니다.
    이미 시작된 작업이면 기존 기록을 덮어쓰지 않고 그 사실을 알려줍니다.
    - task_hint: 대상 지정 힌트. 직원 이름('홍길동') 또는 작업 번호('3번').
                 비우면 가장 급한 작업이 대상이 됩니다.
    """
    try:
        command_text = f"{task_hint} 시작".strip()

        from app.core.database import SessionLocal
        with SessionLocal() as db:
            result = handle_voice_command(db, text=command_text)

        return {
            "success": result.status != "failed",
            "data": result.model_dump(mode="json"),
            "documents": [],
            "message": result.speech_text,
        }
    except Exception as e:
        return {
            "success": False,
            "data": None,
            "documents": [],
            "message": f"작업 시작 처리 중 서버 오류 발생: {str(e)}",
        }


# [한글 주석] tool_registry가 우선 참조하는 목록 (없으면 @tool 객체를 자동 수집)
TOOLS = [
    get_voice_briefing_tool,
    get_next_task_tool,
    complete_task_by_voice_tool,
    start_next_task_by_voice_tool,
]
