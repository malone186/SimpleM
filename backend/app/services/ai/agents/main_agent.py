# c:\STUDY\SimpleM\backend\app\services\ai\agents\main_agent.py
"""챗봇 두뇌 (백엔드 B)

사용자(사장님)의 자연어 질의를 분석하여, 필요한 경우 tool_registry에 등록된 도구들을 
동적으로 호출(Agent Loop)하고 최종적으로 친절한 한국어 답변을 생성하는 메인 에이전트 모듈입니다.
"""

import json
import logging
import os
import re
from pathlib import Path
from typing import Any, Optional

import httpx

from app.services.ai import tool_registry

logger = logging.getLogger(__name__)

# [한글 주석] backend/.env 환경변수를 안전하게 수동 로드합니다.
def _load_dotenv() -> None:
    env_file = Path(__file__).resolve().parents[4] / ".env"
    if not env_file.exists():
        return
    for line in env_file.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        if value.strip():
            os.environ.setdefault(key.strip(), value.strip())

_load_dotenv()

# [한글 주석] Gemini API 호출을 위한 기본 설정을 가져옵니다.
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")

# [한글 주석] 에이전트가 무한 루프에 빠지는 것을 막기 위해 최대 도구 호출 횟수를 제한합니다.
MAX_ITERATIONS = 5

# [한글 주석] 챗봇의 기본 정체성과 행동 강령을 정의하는 시스템 프롬프트입니다.
SYSTEM_PROMPT = """당신은 카페 사장님들을 위한 똑똑하고 친절한 AI 비서 '포슬이'입니다.
컴퓨터 공학이나 어려운 데이터 모델 용어를 쓰지 않고, 대학교 1학년 학생도 바로 이해할 수 있을 만큼 쉽고 친절하게 대답해야 합니다.

사용자의 질문을 해결하기 위해 필요한 경우, 아래 제공된 [사용 가능한 도구 목록]을 활용할 수 있습니다.

[행동 규칙]
1. 사용자의 질문에 대답하기 위해 특정 도구의 정보가 필요하다면, **오직 아래의 JSON 형식 하나만** 응답으로 출력해야 합니다. 다른 텍스트, 설명, 혹은 마크다운 코드 블록(```json 등)을 절대 붙이지 마세요.
   예시:
   {{"tool": "도구_이름", "args": {{"인자명": "값"}}}}

2. 도구의 실행 결과(Tool Output)가 주어지면, 그 데이터를 기반으로 분석하여 사장님께 자연스러운 한국어 구어체로 최종 답변을 작성해 주세요.

3. 도구를 사용할 필요가 없는 일상적인 대화(인사 등)나 단순 질문은 즉시 친절한 한국어 답변으로 출력하세요.

4. 돈이 걸린 액션(예: 발주 확정, 세금 신고 확정 등)을 직접 수행하는 도구는 존재하지 않습니다. 반드시 추천이나 초안(propose_, draft_ 접두어가 붙은 도구)만 작성해서 보여준 뒤, "전용 화면에서 확인하고 승인해 주세요"라고 안내하세요.

[사용 가능한 도구 목록]
{tools_specification}

현재 매장 식별자(store_id): {store_id}
※ 만약 어떤 도구가 store_id를 요구한다면, 반드시 위 store_id 값을 그대로 전달해야 합니다.
"""

def _build_tools_specification() -> str:
    """[한글 주석] 등록된 모든 도구의 이름, 설명 및 인자 정보를 텍스트 명세로 변환합니다."""
    tools = tool_registry.get_all_tools()
    specs = []
    for t in tools:
        args_info = []
        # t.args는 파라미터 구조 정보를 담은 딕셔너리입니다.
        if hasattr(t, "args") and t.args:
            for name, info in t.args.items():
                arg_type = info.get("type", "unknown")
                arg_desc = info.get("description", "")
                required = "필수" if hasattr(t, "args_schema") and t.args_schema and name in t.args_schema.model_json_schema().get("required", []) else "선택"
                args_info.append(f"  - {name} ({arg_type}, {required}): {arg_desc}")
        
        args_str = "\n".join(args_info) if args_info else "  (매개변수 없음)"
        specs.append(
            f"■ 도구 이름: {t.name}\n"
            f"  설명: {t.description}\n"
            f"  매개변수:\n{args_str}"
        )
    return "\n\n".join(specs) if specs else "(사용 가능한 도구 없음)"

def _parse_json_tool_call(text: str) -> Optional[dict[str, Any]]:
    """[한글 주석] 모델의 응답 텍스트에 JSON 형식의 도구 호출이 포함되어 있는지 확인하고 파싱합니다."""
    text_clean = text.strip()
    # 마크다운 코드 블록(```json ... ```)을 쓰고 나오는 경우가 있으므로 이를 제거해 줍니다.
    if text_clean.startswith("```"):
        # ```json 이나 ``` 를 제거하고 내부 텍스트만 추출
        lines = text_clean.splitlines()
        if len(lines) >= 2:
            if lines[0].startswith("```"):
                lines = lines[1:]
            if lines[-1].startswith("```"):
                lines = lines[:-1]
            text_clean = "\n".join(lines).strip()

    try:
        # JSON 형식만 깨끗하게 남겨 파싱합니다.
        data = json.loads(text_clean)
        if isinstance(data, dict) and "tool" in data:
            return data
    except Exception:
        # 만약 전체 문장이 JSON이 아니더라도, 본문 내에서 {...} 패턴을 찾아 파싱을 재시도합니다.
        match = re.search(r"\{.*\}", text_clean, re.DOTALL)
        if match:
            try:
                data = json.loads(match.group(0))
                if isinstance(data, dict) and "tool" in data:
                    return data
            except Exception:
                pass
    return None

async def generate_response(
    user_message: str,
    store_id: str,
    history: list[dict[str, Any]] = None
) -> str:
    """[한글 주석] 챗봇 에이전트의 메인 실행 루프입니다.
    
    사용자 입력을 받으면 Gemini API를 호출하며, 모델이 도구 호출(JSON)을 요구할 때마다 
    해당 도구를 로컬에서 직접 실행하고 결과를 돌려주는 루프를 반복(최대 5회)합니다.
    """
    if history is None:
        history = []

    if not GEMINI_API_KEY:
        return "죄송합니다. 챗봇의 핵심 API 키(GEMINI_API_KEY)가 설정되어 있지 않아 대화가 불가능합니다. 시스템 관리자에게 문의해 주세요."

    # [한글 주석] 등록된 도구들의 명세서를 동적으로 만듭니다.
    tools_spec = _build_tools_specification()
    system_instruction = SYSTEM_PROMPT.format(
        tools_specification=tools_spec,
        store_id=store_id
    )

    # [한글 주석] Gemini API 호출을 위한 대화 히스토리 및 컨텍스트를 구성합니다.
    # system 지침을 첫 번째 메시지 혹은 컨텍스트로 결합합니다.
    messages = []
    # 이전 대화 내역 추가 (Gemini v1beta API 양식: role 은 user / model 만 허용됨)
    for h in history:
        messages.append({
            "role": h.get("role", "user"),
            "parts": [{"text": h.get("text", "")}]
        })
    
    # 현재 사용자의 마지막 메시지 추가
    messages.append({
        "role": "user",
        "parts": [{"text": user_message}]
    })

    # HTTP 통신을 위한 비동기 클라이언트 생성
    async with httpx.AsyncClient() as client:
        iteration = 0
        
        while iteration < MAX_ITERATIONS:
            iteration += 1
            
            # [한글 주석] 시스템 프롬프트를 대화의 첫 시작점에 항상 주입해 줍니다.
            # system instruction은 v1beta generateContent API의 systemInstruction 매개변수로 직접 전달 가능합니다.
            payload = {
                "contents": messages,
                "systemInstruction": {
                    "parts": [{"text": system_instruction}]
                },
                "generationConfig": {
                    "temperature": 0.2  # 도구 호출의 일관성을 높이기 위해 낮게 설정
                }
            }

            try:
                response = await client.post(
                    f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent",
                    headers={"x-goog-api-key": GEMINI_API_KEY},
                    json=payload,
                    timeout=30.0
                )
                response.raise_for_status()
                res_data = response.json()
                
                # 모델의 텍스트 응답 추출
                model_text = res_data["candidates"][0]["content"]["parts"][0]["text"]
            except Exception as e:
                logger.exception("Gemini API 호출 중 오류 발생")
                return f"앗! AI 비서와 연결하는 중에 문제가 생겼어요. 잠시 후에 다시 말해 주세요. (오류: {e})"

            # [한글 주석] 모델의 응답에 도구 호출 지시(JSON)가 있는지 확인합니다.
            tool_call = _parse_json_tool_call(model_text)
            
            if not tool_call:
                # [한글 주석] 도구 호출 지시가 없고 일반 텍스트 대답이라면 루프를 종료하고 결과를 반환합니다.
                return model_text

            # [한글 주석] 도구 호출이 감지된 경우, 도구를 실행합니다.
            tool_name = tool_call["tool"]
            tool_args = tool_call.get("args", {})

            # [한글 주석] 보안 조치 - 도구가 store_id를 사용한다면 현재 접속한 사장님의 store_id로 강제 고정합니다.
            # 툴 리스트에서 해당 툴을 찾아 아규먼트 검사를 수행합니다.
            all_tools = tool_registry.get_all_tools()
            target_tool = next((t for t in all_tools if t.name == tool_name), None)
            
            if target_tool is None:
                # 존재하지 않는 도구일 경우 에러 메시지를 모델에게 피드백으로 던져주고 다시 생각하게 합니다.
                tool_output = f"오류: 존재하지 않는 도구 이름 '{tool_name}'을 호출했습니다. 사용 가능한 도구 목록을 다시 확인하세요."
            else:
                # 도구의 파라미터 규격(args)에 store_id가 정의되어 있다면 안전하게 강제 덮어쓰기합니다.
                if hasattr(target_tool, "args") and "store_id" in target_tool.args:
                    tool_args["store_id"] = store_id
                
                try:
                    # [한글 주석] LangChain Tool의 invoke 함수를 사용해 동기식으로 호출합니다.
                    logger.info(f"에이전트 도구 호출 수행: {tool_name} with args {tool_args}")
                    tool_result = target_tool.invoke(tool_args)
                    
                    # 결과를 보기 좋은 문자열 형태로 변환
                    if isinstance(tool_result, (dict, list)):
                        tool_output = json.dumps(tool_result, ensure_ascii=False)
                    else:
                        tool_output = str(tool_result)
                except Exception as e:
                    logger.exception(f"도구 {tool_name} 실행 중 예외 발생")
                    tool_output = f"오류: 도구 실행 중 예외 발생: {e}"

            # [한글 주석] 모델이 도구를 호출한 흐름을 대화 히스토리에 누적시켜 줍니다.
            # 1. 모델이 도구를 호출하겠다고 한 지시사항(JSON)을 모델의 응답 역할로 저장
            messages.append({
                "role": "model",
                "parts": [{"text": model_text}]
            })
            
            # 2. 도구의 실행 결과값을 사용자의 입력 역할로 저장하여 피드백합니다.
            messages.append({
                "role": "user",
                "parts": [{"text": f"도구 [{tool_name}] 실행 결과:\n{tool_output}\n위 데이터를 바탕으로 분석하여 답변을 완성하거나, 추가 정보가 필요하면 다른 도구를 호출해 주세요."}]
            })

        # 최대 루프 횟수를 초과한 경우 안전 예외 답변을 반환합니다.
        return "죄송합니다. 질문에 답하기 위해 너무 많은 단계를 거치고 있어서 답변을 마무리하지 못했어요. 질문을 조금 더 구체적으로 해주실 수 있을까요?"
