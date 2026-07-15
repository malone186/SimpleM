"""챗봇 두뇌 (백엔드 B) — 멀티에이전트 오케스트레이션

구조 (supervisor 패턴, langchain v1 create_agent = langgraph 기반):

    사용자 질문
        ↓
    메인 에이전트 '포슬이' (오케스트레이터)
        ├─ inventory_expert  : 재고·재료·메뉴·발주  (백엔드 A 도구 — 구현되면 자동 활성화)
        ├─ document_expert   : 서류 자동화·갱신 알림 (document_tools 13종)
        ├─ ocr_expert        : 영수증/명세서 OCR 문서 조회·수정 (ocr_tools)
        ├─ operation_expert  : 매출 예측·운영 요약·원두 시세·세금 추정 (백엔드 C 도구)
        └─ report_expert     : 주간 리포트 (report_tools — 구현되면 자동 활성화)

메인 에이전트는 실제 도구를 직접 만지지 않고 "어느 전문가에게 무엇을 맡길지"만 결정한다.
각 서브에이전트는 자기 도메인 도구만 들고 독립적으로 ReAct 루프를 돈다 — 도구 22종을
한 에이전트에 다 넣을 때보다 선택 정확도가 높고, 도메인별 지침을 따로 줄 수 있다.

안전 원칙 (PRD §5.3): 돈이 걸린 액션은 draft_/propose_ 초안 도구만 존재하며,
store_id는 모델이 뭐라 넣든 서버가 로그인 사용자 값으로 강제 덮어쓴다.
"""

import importlib
import logging
import os
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger(__name__)


def _load_dotenv() -> None:
    """backend/.env를 읽어 아직 없는 환경변수만 채운다 (외부 의존성 없이)."""
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

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")

# 무한 위임/루프 방지 — langgraph 그래프 스텝 상한
SUB_RECURSION_LIMIT = 12   # 서브에이전트: 도구 몇 번 쓰고 답하기에 충분
MAIN_RECURSION_LIMIT = 16  # 메인: 전문가 여러 명에게 순차 위임 가능

# ---------------------------------------------------------------------------
# 도메인(서브에이전트) 정의 — 모듈에 도구가 생기면 자동으로 전문가가 활성화된다
# ---------------------------------------------------------------------------

_SUB_PROMPT_BASE = """당신은 카페 운영 시스템 SimpleM의 '{title}'입니다.
주어진 도구만 사용해 요청을 처리하고, 결과를 한국어로 간결하게 정리해 보고하세요.

규칙:
- 도구가 store_id를 요구하면 반드시 '{store_id}'를 넣으세요.
- 도구 실행 결과에 있는 숫자·데이터를 지어내지 말고 그대로 사용하세요.
- 요청을 처리할 도구가 없으면 "이 요청은 제 담당 도구로는 처리할 수 없습니다"라고 보고하세요.
- 돈이 걸린 액션(발주·지급·신고)은 초안(draft_) 생성까지만 가능합니다. 초안을 만들었다면
  "전용 화면에서 확인 후 확정해야 한다"는 점을 보고에 포함하세요.
{extra}"""

_DOMAINS: list[dict[str, Any]] = [
    {
        "name": "inventory_expert",
        "title": "재고 전문가",
        "description": "재고 현황 조회, 재료 관리, 메뉴·레시피, 발주 관련 요청을 처리한다.",
        "modules": ["app.services.inventory_tools"],  # 백엔드 A — 도구 생기면 자동 활성화
        "extra": "",
    },
    {
        "name": "document_expert",
        "title": "서류 자동화 전문가",
        "description": (
            "카페 운영 서류를 만들고 관리한다: 발주서 초안, 재고실사표, 검수확인서, "
            "매입·매출 장부, 부가세 신고 참고자료, 임금명세서 초안·임금대장, 근로계약서 초안, "
            "생성된 문서 조회·수정, 보건증·위생교육·계약 갱신 만료 알림."
        ),
        "modules": ["app.services.ai.document_tools"],
        "extra": "- 문서를 수정할 때는 먼저 목록/조회 도구로 현재 내용을 확인한 뒤 전체 본문을 보내세요.",
    },
    {
        "name": "ocr_expert",
        "title": "OCR 문서 전문가",
        "description": (
            "영수증·거래명세서를 촬영해 만든 OCR 문서를 조회하고 품목·금액을 수정한다. "
            "(촬영 자체와 재고 반영 확정은 전용 화면에서만 가능)"
        ),
        "modules": ["app.services.ai.ocr_tools"],
        "extra": "- 문서 확정(재고 반영)은 도구로 불가능합니다 — 재고 화면에서 하도록 안내하세요.",
    },
    {
        "name": "operation_expert",
        "title": "운영·세무 전문가",
        "description": (
            "매출 예측, 운영 리포트 요약, 로스터리 원두 시세 비교, 세금 간이 추정과 "
            "관련 법령·자료 검색을 처리한다."
        ),
        "modules": [
            "app.services.operation.forecasting_tools",
            "app.services.operation.operation_tools",
            "app.services.operation.roastery_tools",
            "app.services.operation.tax_tools",
        ],
        "extra": "- 세금 추정치는 참고용이며 최종 신고는 세무사 확인이 필요하다고 항상 덧붙이세요.",
    },
    {
        "name": "report_expert",
        "title": "주간 리포트 전문가",
        "description": "주간 매출·재고 리포트를 생성하고 조회한다.",
        "modules": ["app.services.ai.report_tools"],  # 백엔드 B — 구현되면 자동 활성화
        "extra": "",
    },
]

_MAIN_PROMPT = """당신은 카페 사장님들을 위한 똑똑하고 친절한 AI 비서 '포슬이'입니다.
어려운 전문 용어 없이, 누구나 바로 이해할 수 있게 한국어 구어체로 대답합니다.

당신은 직접 데이터를 조회하지 않습니다. 대신 아래 전문가 팀을 부하 직원처럼 부릴 수 있습니다:
{experts}

[행동 규칙]
1. 매장 데이터가 필요한 요청은 반드시 알맞은 전문가에게 위임하세요. 위임할 때는 task에
   사장님의 요청을 구체적인 한국어 지시문으로 바꿔서 전달하세요.
   (예: "이번 달 김철수 월급 계산해줘" → document_expert에게 "2026년 7월 김철수 임금명세서 초안을 만들어줘")
2. 여러 영역에 걸친 질문이면 전문가를 차례로 호출해 결과를 종합하세요.
3. 전문가의 보고를 그대로 복사하지 말고, 사장님이 듣기 편한 말로 요약·정리해 전하세요.
   숫자는 지어내지 말고 전문가가 보고한 값만 쓰세요.
4. 인사말이나 일상 대화는 전문가 호출 없이 바로 답하세요.
5. 돈이 걸린 액션(발주·급여 지급·세금 신고)은 시스템 전체가 '초안 생성'까지만 지원합니다.
   초안이 만들어지면 "관리 > 서류 자동화 화면에서 확인 후 확정하세요"라고 안내하세요.
6. 오늘 날짜: {today} / 현재 매장: {store_id}

전문가가 처리하지 못한 요청은 솔직하게 "아직 지원하지 않는 기능"이라고 안내하세요."""


# ---------------------------------------------------------------------------
# 구성 요소 빌더
# ---------------------------------------------------------------------------

_model = None  # 모델 클라이언트는 프로세스당 1회만 생성


def _get_model():
    global _model
    if _model is None:
        from langchain_google_genai import ChatGoogleGenerativeAI

        _model = ChatGoogleGenerativeAI(
            model=GEMINI_MODEL,
            google_api_key=GEMINI_API_KEY,
            temperature=0.2,  # 도구 호출 일관성 우선
        )
    return _model


def _module_tools(module_path: str) -> list:
    """모듈에서 도구를 수집한다 (tool_registry와 같은 규칙: TOOLS 우선, 없으면 @tool 자동 수집)."""
    from langchain_core.tools import BaseTool

    try:
        module = importlib.import_module(module_path)
        tools = getattr(module, "TOOLS", None)
        if tools is None:
            tools = [v for v in vars(module).values() if isinstance(v, BaseTool)]
        return list(tools)
    except Exception:
        logger.exception("도구 모듈 로드 실패: %s — 해당 도구 없이 계속", module_path)
        return []


def _bind_store(t, store_id: str):
    """store_id 인자를 받는 도구는 모델이 뭐라 넣든 로그인 사용자 값으로 강제 덮어쓴다 (보안)."""
    from langchain_core.tools import StructuredTool

    if not (getattr(t, "args", None) and "store_id" in t.args):
        return t

    def _run(**kwargs):
        kwargs["store_id"] = store_id
        return t.invoke(kwargs)

    return StructuredTool(
        name=t.name,
        description=t.description,
        args_schema=t.args_schema,
        func=_run,
    )


def _build_subagent(domain: dict[str, Any], store_id: str):
    """도메인 하나의 서브에이전트를 만든다. 도구가 하나도 없으면 None (비활성 도메인)."""
    from langchain.agents import create_agent

    tools = [_bind_store(t, store_id) for m in domain["modules"] for t in _module_tools(m)]
    if not tools:
        return None
    prompt = _SUB_PROMPT_BASE.format(title=domain["title"], store_id=store_id, extra=domain["extra"])
    return create_agent(_get_model(), tools, system_prompt=prompt)


def _last_text(result: dict[str, Any]) -> str:
    """langgraph 결과에서 마지막 AI 메시지의 텍스트를 꺼낸다 (Gemini는 파트 리스트일 수 있음)."""
    content = result["messages"][-1].content
    if isinstance(content, list):
        return "".join(p.get("text", "") if isinstance(p, dict) else str(p) for p in content)
    return str(content)


def _make_delegate_tool(domain: dict[str, Any], subagent):
    """서브에이전트를 메인 에이전트의 도구 하나로 감싼다 (agent-as-tool)."""
    from langchain_core.tools import StructuredTool

    async def _delegate(task: str) -> str:
        logger.info("메인 → %s 위임: %s", domain["name"], task[:80])
        result = await subagent.ainvoke(
            {"messages": [{"role": "user", "content": task}]},
            config={"recursion_limit": SUB_RECURSION_LIMIT},
        )
        return _last_text(result)

    return StructuredTool.from_function(
        coroutine=_delegate,
        name=domain["name"],
        description=(
            f"{domain['title']}에게 작업을 맡긴다. {domain['description']} "
            "task에는 처리할 일을 구체적인 한국어 지시문으로 적는다."
        ),
    )


# ---------------------------------------------------------------------------
# 공개 인터페이스 — /chatbot/chat 엔드포인트가 호출한다
# ---------------------------------------------------------------------------

async def generate_response(
    user_message: str,
    store_id: str,
    history: Optional[list[dict[str, Any]]] = None,
) -> str:
    """멀티에이전트 실행: 서브에이전트 구성 → 메인 오케스트레이터가 위임 판단 → 최종 답변."""
    from datetime import date

    from langchain.agents import create_agent

    if not GEMINI_API_KEY:
        return "죄송합니다. 챗봇의 핵심 API 키(GEMINI_API_KEY)가 설정되어 있지 않아 대화가 불가능합니다. 시스템 관리자에게 문의해 주세요."

    # 1) 도메인별 서브에이전트 구성 (도구가 없는 도메인은 자동 제외)
    delegate_tools = []
    expert_lines = []
    for domain in _DOMAINS:
        subagent = _build_subagent(domain, store_id)
        if subagent is None:
            continue
        delegate_tools.append(_make_delegate_tool(domain, subagent))
        expert_lines.append(f"- {domain['name']} ({domain['title']}): {domain['description']}")

    if not delegate_tools:
        return "지금은 연결된 기능이 없어 일반 대화만 가능해요. 무엇이 궁금하신가요?"

    # 2) 메인 오케스트레이터 구성
    main = create_agent(
        _get_model(),
        delegate_tools,
        system_prompt=_MAIN_PROMPT.format(
            experts="\n".join(expert_lines),
            today=date.today().isoformat(),
            store_id=store_id,
        ),
    )

    # 3) 이전 대화 이력 + 현재 질문으로 실행
    messages: list[dict[str, str]] = []
    for h in history or []:
        role = "assistant" if h.get("role") in ("model", "assistant") else "user"
        text = h.get("text") or h.get("content") or ""
        if text:
            messages.append({"role": role, "content": text})
    messages.append({"role": "user", "content": user_message})

    try:
        result = await main.ainvoke(
            {"messages": messages},
            config={"recursion_limit": MAIN_RECURSION_LIMIT},
        )
        answer = _last_text(result).strip()
        return answer or "죄송해요, 답변을 만들지 못했어요. 조금 다르게 질문해 주시겠어요?"
    except Exception:
        logger.exception("멀티에이전트 실행 실패")
        return "앗! 답변을 준비하다가 문제가 생겼어요. 잠시 후 다시 물어봐 주세요."
