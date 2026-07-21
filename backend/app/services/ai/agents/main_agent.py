"""챗봇 두뇌 (백엔드 B) — 멀티에이전트 오케스트레이션

구조 (supervisor 패턴, langchain v1 create_agent = langgraph 기반):

    사용자 질문
        ↓
    메인 에이전트 '포슬이' (오케스트레이터)
        ├─ inventory_expert  : 재고·재료·메뉴·발주  (백엔드 A 도구 — 구현되면 자동 활성화)
        ├─ document_expert   : 서류 자동화·갱신 알림 (document_tools 15종)
        ├─ ocr_expert        : 영수증/명세서 OCR 문서 조회·수정 (ocr_tools)
        ├─ operation_expert  : 매출 예측·운영 요약·원두 시세·세금 추정 (백엔드 C 도구)
        └─ report_expert     : 일간·주간·월간 경영 리포트 (report_tools — 전체 데이터 통합)

메인 에이전트는 실제 도구를 직접 만지지 않고 "어느 전문가에게 무엇을 맡길지"만 결정한다.
각 서브에이전트는 자기 도메인 도구만 들고 독립적으로 ReAct 루프를 돈다 — 도구 22종을
한 에이전트에 다 넣을 때보다 선택 정확도가 높고, 도메인별 지침을 따로 줄 수 있다.

안전 원칙 (PRD §5.3): 돈이 걸린 액션은 draft_/propose_ 초안 도구만 존재하며,
store_id는 모델이 뭐라 넣든 서버가 로그인 사용자 값으로 강제 덮어쓴다.
"""

import importlib
import json
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
- 삭제·확정 같은 되돌릴 수 없는 도구는 지시받은 대상이 명확할 때만 실행하세요.
  대상이 애매하면 실행하지 말고 목록을 조회해 후보를 보고하세요.
- 외부 실행이 필요한 액션(발주 전송·급여 이체·세금 신고)은 시스템에 없으므로 초안(draft_)까지만
  만들고, 그 사실을 보고에 포함하세요.
- 문서를 생성/수정하면 전문은 시스템이 채팅 화면에 카드로 자동 표시합니다. 본문 JSON을
  통째로 옮겨 적지 말고 핵심 수치(품목 수·총액·실지급액 등)만 요약해 보고하세요.
{extra}"""

_DOMAINS: list[dict[str, Any]] = [
    {
        "name": "inventory_expert",
        "title": "재고 전문가",
        "description": (
            "재고 현황 조회, 재료 등록, 재고 수량 조정(입고·차감), 재료 삭제, "
            "메뉴·레시피 조회, 재료의 인터넷 최저가 비교를 처리한다."
        ),
        "modules": ["app.services.ai.price_tools", "app.services.inventory_tools"],
        "extra": (
            "- 재료 삭제는 재고·입출고 이력·레시피가 함께 지워진다는 점을 보고에 포함하세요.\n"
            "- 가격 비교 결과를 보고할 때는 최저가·판매처·현재 단가 대비 절감률을 요약하고,"
            " 소매가 기준 참고 정보라는 점을 덧붙이세요."
        ),
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
            "영수증·거래명세서를 촬영해 만든 OCR 문서를 조회·수정하고, "
            "확정(재고 입고 반영)과 반려까지 처리한다. (촬영 자체는 재고 화면에서만 가능)"
        ),
        "modules": ["app.services.ai.ocr_tools"],
        "extra": "- 확정하면 품목이 실제 재고에 더해집니다 — 반영 결과(몇 개 품목 입고)를 보고하세요.",
    },
    {
        "name": "operation_expert",
        "title": "운영·세무 전문가",
        "description": (
            "판매량 예측(익일·금주 — 날씨·요일·공휴일·행사 반영, 발주 추천 포함), "
            "운영 리포트 요약, 로스터리 원두 시세 비교, 세금 간이 추정 및 주요 세무 신고 기한(부가세·종소세·원천징수 일정) 조회와 "
            "관련 법령·자료 검색을 처리한다."
        ),
        "modules": [
            "app.services.ai.forecast_tools",
            "app.services.operation.forecasting_tools",
            "app.services.operation.operation_tools",
            "app.services.operation.roastery_tools",
            "app.services.operation.tax_tools",
        ],
        "extra": (
            "- 판매량 예측은 forecast_sales_and_orders를 쓰세요 (DB에서 자동 조회).\n"
            "- 사장님이 주변 행사를 언급하면 events_json으로 넣어 부스팅을 반영하세요.\n"
            "- 예측 보고에는 근거(모델·날씨·보정 사유)와 발주 추천 요약을 포함하세요.\n"
            "- 세금 추정치는 참고용이며 최종 신고는 세무사 확인이 필요하다고 항상 덧붙이세요."
        ),
    },
    {
        "name": "report_expert",
        "title": "경영 리포트 전문가",
        "description": (
            "일간·주간·월간 AI 경영 리포트를 생성·조회한다 — 매출(증감·베스트 메뉴), "
            "매입, 지출, 인건비, 수익 추정, 재고 경고, 발주 진행, 갱신 서류를 통합 집계."
        ),
        "modules": ["app.services.ai.report_tools"],
        "extra": (
            "- 리포트를 만들면 highlights의 사실을 근거로 사장님께 도움이 될 해석과 조언을 "
            "한두 문장 덧붙여 보고하세요 (예: 매출 하락 원인 추정, 발주·인건비 조정 제안).\n"
            "- 수치는 도구가 계산한 값만 쓰고, '언제' 리포트인지(기간)를 꼭 밝히세요."
        ),
    },
    {
        # [한글 주석: 법령 RAG 검색 도구를 전담 제어하는 법률·노무 전문가 서브에이전트]
        "name": "law_expert",
        "title": "법률·노무 전문가",
        "description": (
            "카페 운영 관련 법령(근로기준법, 주휴수당, 휴게시간, 연장/야간 수당, 근로계약서,"
            "최저임금법, 상가임대차 계약 갱신/권리금, 식품위생법 보건증/위생교육 등) "
            "조문 검색과 법적 근거 기반 지침 제공을 처리한다."
        ),
        "modules": ["app.services.operation.law_tools"],
        "extra": (
            "- 법률 질문 답변 시 반드시 검색된 법령명, 조문번호, 출처, 시행일을 명확히 인용하여 작성하세요.\n"
            "- 검색된 결과 data가 비어있거나 부족하면 정보를 절대로 지어내지 말고 "
            "\"카페 운영 관련 법령 정보가 부족하여 명확한 답변이 어렵습니다.\"라고 솔직히 안내하세요.\n"
            "- 답변 마지막에는 반드시 '※ 본 답변은 제공된 법령 조문 기반 참고용 정보이며, 최종 법적 판단은 변호사나 노무사 등 전문가의 자문을 권장합니다.'라는 고지 문구를 포함하세요."
        ),
    },
    {
        # [한글 주석: Tavily Search API 도구를 전담 제어하여 외부 정보 검색을 처리할 실시간 웹 검색 전문가를 추가합니다]
        "name": "search_expert",
        "title": "실시간 웹 검색 전문가",
        "description": (
            "실시간 뉴스, 날씨, 트렌드, 일반 지식, 상식, 카페 운영 꿀팁 등 "
            "시스템 내부에 저장되어 있지 않은 외부의 모든 최신 정보 검색을 처리한다."
        ),
        "modules": ["app.services.ai.web_search_tools"],
        "extra": "- 검색 결과에 나타난 참고 링크(출처) 주소들을 빠짐없이 정리하여 최종 답변에 함께 적어주세요.",
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
5. 삭제·확정(재고 반영·반려) 같은 되돌릴 수 없는 요청도 수행할 수 있습니다.
   다만 대상이 애매하면(예: "그 문서 삭제해줘"인데 문서가 여러 개) 바로 실행하지 말고
   목록을 보여주며 어떤 것인지 되물으세요. 실행 후에는 무엇이 삭제/반영됐는지 명확히 보고하세요.
6. 문서/초안이 만들어지면 그 전문은 이 대화에 카드로 함께 표시됩니다. 다른 화면에 가서
   확인하라고 안내하지 말고 "아래 카드에서 바로 확인하실 수 있어요"라고 하며, 답변에는
   핵심 요약(품목 수·총액·실지급액 등)만 담으세요. 외부 실행이 필요한 액션(발주 전송·
   급여 이체·세금 신고)은 시스템이 하지 않으므로 초안 확인 후 직접 진행하시라고 덧붙이세요.
7. 오늘 날짜: {today} / 현재 매장: {store_id}

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


def _extract_document(result: Any) -> Optional[dict[str, Any]]:
    """도구 결과가 생성/수정된 문서 전문(JSON)이면 dict로 돌려준다 — 챗봇 화면 카드 표시용."""
    if not isinstance(result, str) or not result.lstrip().startswith("{"):
        return None
    try:
        data = json.loads(result)
    except (json.JSONDecodeError, ValueError):
        return None
    if isinstance(data, dict) and {"id", "kind", "title", "content"} <= data.keys():
        return data
    return None


def _bind_store(t, store_id: str, created_docs: list[dict[str, Any]]):
    """store_id 인자를 받는 도구는 모델이 뭐라 넣든 로그인 사용자 값으로 강제 덮어쓴다 (보안).

    같은 래퍼에서 결과가 문서 전문이면 created_docs에 모아 — 최종 응답에 카드로 실어 보낸다.
    """
    from langchain_core.tools import StructuredTool

    if not (getattr(t, "args", None) and "store_id" in t.args):
        return t

    def _run(**kwargs):
        kwargs["store_id"] = store_id
        result = t.invoke(kwargs)
        doc = _extract_document(result)
        if doc and all(d["id"] != doc["id"] for d in created_docs):
            created_docs.append(doc)
        return result

    return StructuredTool(
        name=t.name,
        description=t.description,
        args_schema=t.args_schema,
        func=_run,
    )


def _build_subagent(domain: dict[str, Any], store_id: str, created_docs: list[dict[str, Any]]):
    """도메인 하나의 서브에이전트를 만든다. 도구가 하나도 없으면 None (비활성 도메인)."""
    from langchain.agents import create_agent

    tools = [_bind_store(t, store_id, created_docs) for m in domain["modules"] for t in _module_tools(m)]
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
) -> dict[str, Any]:
    """멀티에이전트 실행: 서브에이전트 구성 → 메인 오케스트레이터가 위임 판단 → 최종 답변.

    반환: {"text": 답변 텍스트, "documents": 이번 턴에 생성/수정된 문서 전문 리스트}
    documents는 챗봇 화면이 말풍선 아래에 카드로 그대로 렌더링한다.
    """
    from datetime import date

    from langchain.agents import create_agent

    if not GEMINI_API_KEY:
        return {"text": "죄송합니다. 챗봇의 핵심 API 키(GEMINI_API_KEY)가 설정되어 있지 않아 대화가 불가능합니다. 시스템 관리자에게 문의해 주세요.", "documents": []}

    # 1) 도메인별 서브에이전트 구성 (도구가 없는 도메인은 자동 제외)
    #    created_docs: 이번 요청에서 문서 도구가 만든/수정한 문서 전문이 여기 모인다
    created_docs: list[dict[str, Any]] = []
    delegate_tools = []
    expert_lines = []
    for domain in _DOMAINS:
        subagent = _build_subagent(domain, store_id, created_docs)
        if subagent is None:
            continue
        delegate_tools.append(_make_delegate_tool(domain, subagent))
        expert_lines.append(f"- {domain['name']} ({domain['title']}): {domain['description']}")

    if not delegate_tools:
        return {"text": "지금은 연결된 기능이 없어 일반 대화만 가능해요. 무엇이 궁금하신가요?", "documents": []}

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
        return {"text": answer or "죄송해요, 답변을 만들지 못했어요. 조금 다르게 질문해 주시겠어요?",
                "documents": created_docs}
    except Exception as e:
        logger.exception("멀티에이전트 실행 실패")
        # DB 연결 실패는 원인을 알려줘야 사용자가 조치할 수 있다 (공유 DB 호스트 꺼짐 등)
        if "OperationalError" in type(e).__name__ or "connection" in str(e).lower():
            return {"text": ("지금 매장 데이터베이스에 연결할 수 없어서 데이터 조회를 못 하고 있어요. "
                             "DB 서버가 켜져 있는지 확인해 주세요. (일반 대화는 계속 가능해요)"),
                    "documents": created_docs}
        # 실패 전에 이미 만들어진 문서가 있으면 함께 보여준다 (문서는 DB에 저장된 상태)
        return {"text": "앗! 답변을 준비하다가 문제가 생겼어요. 잠시 후 다시 물어봐 주세요.",
                "documents": created_docs}
