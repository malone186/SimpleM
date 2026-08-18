"""챗봇 두뇌 (백엔드 B) — 멀티에이전트 오케스트레이션

구조 (supervisor 패턴, langchain v1 create_agent = langgraph 기반):

    사용자 질문
        ↓
    메인 에이전트 '브루' (오케스트레이터)
        ├─ inventory_expert  : 재고·재료·메뉴·발주  (백엔드 A 도구 — 구현되면 자동 활성화)
        ├─ data_expert       : 매장 원천 데이터 조회 + 선제 인사이트 (store_data_tools·insight_tools)
        ├─ document_expert   : 서류 자동화·갱신 알림 (document_tools 15종)
        ├─ ocr_expert        : 영수증/명세서 OCR 문서 조회·수정 (ocr_tools)
        ├─ market_expert     : 주변 카페·상권 분석 (nearby_cafe_tools — 네이버 지역·후기 수집)
        ├─ marketing_expert  : 홍보/마케팅 (marketing_tools — AI 홍보 문구·홍보 이미지 생성)
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
import time
from datetime import date
from pathlib import Path
from typing import Any, Optional

from app.services.ai.agents import runtime_stats
from app.services.ai.untrusted import UNTRUSTED_PROMPT_RULE
from app.utils.datetime_kst import today_kst

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
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-3.1-flash-lite")

# ---------------------------------------------------------------------------
# LangSmith 트레이싱 — .env에 LANGSMITH_API_KEY만 넣으면 자동 활성화된다.
# 켜지면 메인 위임·서브에이전트 도구 호출·프롬프트·토큰이 전부 smith.langchain.com에 기록된다.
# 키가 없으면 아무것도 하지 않으므로 팀원 환경에는 영향이 없다.
# ---------------------------------------------------------------------------
if os.getenv("LANGSMITH_API_KEY", "").strip():
    os.environ.setdefault("LANGSMITH_TRACING", "true")
    os.environ.setdefault("LANGCHAIN_TRACING_V2", "true")  # 구버전 langchain 호환 스위치
    os.environ.setdefault("LANGSMITH_PROJECT", "simplem-chatbot")
    logger.info("LangSmith 트레이싱 활성화 — 프로젝트: %s", os.environ["LANGSMITH_PROJECT"])

# 무한 위임/루프 방지 — langgraph 그래프 스텝 상한
SUB_RECURSION_LIMIT = 12   # 서브에이전트: 도구 몇 번 쓰고 답하기에 충분
MAIN_RECURSION_LIMIT = 16  # 메인: 전문가 여러 명에게 순차 위임 가능

# ---------------------------------------------------------------------------
# 메인 에이전트(오케스트레이터) 정의 — 이름·역할·설명의 단일 출처.
# 시스템 프롬프트와 관리자 콘솔 API(get_agent_overview)가 모두 여기서 읽는다.
# ---------------------------------------------------------------------------

_MAIN_AGENT: dict[str, str] = {
    "name": "브루",  # 서비스 마스코트 BREW — 챗봇 화면('브루 챗봇')과 같은 정체성
    "role": "메인 오케스트레이터 (supervisor)",
    "description": (
        "직접 도구를 만지지 않고 사장님의 요청을 분석해 알맞은 전문가에게 위임하고, "
        "여러 전문가의 보고를 종합해 최종 답변을 만든다."
    ),
}

# ---------------------------------------------------------------------------
# 도메인(서브에이전트) 정의 — 모듈에 도구가 생기면 자동으로 전문가가 활성화된다
# ---------------------------------------------------------------------------

_SUB_PROMPT_BASE = """당신은 카페 운영 시스템 브루노트의 '{title}'입니다.
주어진 도구만 사용해 요청을 처리하고, 결과를 한국어로 간결하게 정리해 보고하세요.

규칙:
- 오늘 날짜는 {today}입니다. '내일'·'다음 주' 같은 상대 날짜는 반드시 이 날짜 기준으로
  계산하세요. 날짜를 모르는 채 추측해 넣으면 과거 날짜 같은 엉뚱한 값이 들어갑니다.
- 도구가 store_id를 요구하면 반드시 '{store_id}'를 넣으세요.
- 도구 실행 결과에 있는 숫자·데이터를 지어내지 말고 그대로 사용하세요.
- 요청을 처리할 도구가 없으면 "이 요청은 제 담당 도구로는 처리할 수 없습니다"라고 보고하세요.
- 삭제·확정 같은 되돌릴 수 없는 도구는 지시받은 대상이 명확할 때만 실행하세요.
  대상이 애매하면 실행하지 말고 목록을 조회해 후보를 보고하세요.
- 외부 실행이 필요한 액션(발주 전송·급여 이체·세금 신고)은 시스템에 없으므로 초안(draft_)까지만
  만들고, 그 사실을 보고에 포함하세요.
- 문서를 생성/수정하면 전문은 시스템이 채팅 화면에 카드로 자동 표시합니다. 본문 JSON을
  통째로 옮겨 적지 말고 핵심 수치(품목 수·총액·실지급액 등)만 요약해 보고하세요.
{untrusted_rule}
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
            "- 재고 현황을 보고할 때, 최소 보유량(safety_quantity)보다 부족한 재료가 있다면 단순히 '적게 남았다'고 말하지 말고, "
            "구체적으로 '몇 [단위](팩, 봉, 개 등 각 재료의 실제 단위)가 부족해서 몇 [단위]가 더 필요하다'라는 "
            "형식(예: '서울우유 1L는 5팩이 부족해서 5팩을 더 채워야 합니다')으로 숫자를 확실히 계산해서 보고에 포함시키세요. "
            "'안전재고' 같은 업계 용어는 쓰지 말고 '최소 보유량' 또는 '이만큼은 있어야 하는 양'처럼 쉬운 말로 표현하세요.\n"
            "- 재료 삭제는 재고·입출고 이력·레시피가 함께 지워진다는 점을 보고에 포함하세요.\n"
            "- 가격 비교 결과를 보고할 때는 최저가·판매처·현재 단가 대비 절감률을 요약하고,"
            " 소매가 기준 참고 정보라는 점을 덧붙이세요."
        ),
    },
    {
        "name": "data_expert",
        "title": "매장 데이터 전문가",
        "description": (
            "매장의 원천 데이터를 직접 읽는다: 매장 프로필(상호·연락처·등록 규모), 판매 원장"
            "(일별 매출·메뉴별 순위), 재고 입출고 이력, 재료 단가 변동 이력, 발주 이력과 진행 상태, "
            "지출 내역, 직원 명단·시급·기피 시간, 근무 스케줄과 실제 출퇴근, 급여 계산 이력, "
            "관리자 공지와 내 1:1 문의 답변 상태. "
            "또한 사장님이 놓쳤거나 곧 해야 할 일을 매장 데이터에서 스스로 찾아낸다."
        ),
        "modules": [
            "app.services.ai.insight_tools",
            "app.services.ai.store_data_tools",
        ],
        "extra": (
            "- 이 도구들은 전부 읽기 전용이라 데이터를 바꾸지 않습니다. 필요하면 여러 번 조회하세요.\n"
            "- '얼마 팔았어' 같은 지난 실적 질문은 get_sales_history(실제 기록)를 쓰세요. "
            "예측은 제 담당이 아닙니다.\n"
            "- '놓친 거 있어?', '뭐 챙겨야 해?' 류의 포괄적인 질문은 get_proactive_insights를 쓰고, "
            "심각도(severity)가 high인 항목부터 보고하세요.\n"
            "- 인사이트를 보고할 때는 각 항목의 action 문구를 '이렇게 말씀해 주시면 바로 처리해 드려요' 식으로 "
            "함께 전하세요.\n"
            "- 조회 결과가 비어 있으면 없는 사실을 지어내지 말고 '기록이 없다'고 그대로 보고하세요."
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
        "extra": ("- 문서를 수정할 때는 반드시 get_generated_document로 현재 본문을 먼저 읽고,"
                  " 그 JSON에서 바꿀 값만 고쳐 전체를 그대로 돌려보내세요."
                  " 본문을 읽지 않고 update를 부르면 원래 품목·금액이 지워집니다."),
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
        # [상권 분석] 등록된 매장 고정 위치 기준으로 주변 카페·행사를 조사·분석하는 전문가
        "name": "market_expert",
        "title": "상권·경쟁·주변 행사 전문가",
        "description": (
            "매장 주변 상권을 조사한다 — 반경 안의 경쟁 카페 목록(네이버 지역정보), "
            "특정 카페의 후기 기반 강점·약점·대표 메뉴·가격대 분석, "
            "동네 전체의 경쟁 밀도·트렌드·기회·위협과 실행안 정리. "
            "또한 매장 반경에서 곧 열리는 축제·팝업·플리마켓·문화행사 일정을 조회한다 "
            "('이번 주말 근처에 무슨 행사 있어?', '주변에 축제 뭐 있어?')."
        ),
        "modules": ["app.services.ai.nearby_cafe_tools", "app.services.ai.nearby_event_tools"],
        "extra": (
            "- 기준 좌표는 사장님이 등록한 매장 위치입니다. 등록이 안 됐다는 안내가 오면 "
            "매장 지도 화면에서 위치를 등록하시라고 그대로 전하세요.\n"
            "- 분석 근거는 네이버 지역정보와 블로그 후기입니다 — 도구가 준 사실만 쓰고, "
            "후기가 없으면 '후기가 적어 판단이 어렵다'고 솔직히 보고하세요.\n"
            "- 경쟁 카페를 말할 때는 이름과 함께 우리 매장에서 몇 m인지 꼭 붙이세요.\n"
            "- 주변 행사는 list_nearby_events로 조회하고, 행사가 없으면 지어내지 말고 "
            "'예정된 행사가 없다'고 그대로 보고하세요."
        ),
    },
    {
        # [홍보/마케팅] 눈길 끄는 홍보 문구 + AI 홍보 이미지 생성 전문가
        "name": "marketing_expert",
        "title": "홍보·마케팅 전문가",
        "description": (
            "매장 홍보 콘텐츠를 만든다 — 인스타그램·블로그·현수막·안내 문자용 홍보 문구"
            "(헤드라인·캡션·해시태그·슬로건)와 AI 홍보 이미지 생성, 만든 홍보물 조회. "
            "'홍보 문구 만들어줘', '인스타에 올릴 글 써줘', '신메뉴 홍보 이미지 만들어줘', "
            "'홍보물 뭐 만들었더라' 같은 요청을 처리한다."
        ),
        "modules": ["app.services.ai.marketing_tools"],
        "extra": (
            "- 기본 흐름: create_promotion_content로 문구를 먼저 만들고, 사장님이 이미지도 "
            "원하면 그 문서 id로 create_promotion_image를 부르세요 — 문구와 어울리는 이미지가 나옵니다.\n"
            "- 사장님이 '이미지만' 원하면 문구 생성 없이 create_promotion_image에 request로 "
            "원하는 장면을 적어 바로 만드세요.\n"
            "- 이미지 생성은 수십 초가 걸립니다 — 문구와 이미지를 한 번에 요청받았을 때만 둘 다 만들고, "
            "애매하면 문구를 먼저 보여준 뒤 이미지를 만들지 여쭤보라고 보고하세요.\n"
            "- 이미지가 만들어지면 결과의 url(이미지 주소)을 보고에 반드시 포함하세요. "
            "카드에도 함께 표시되지만, url이 빠지면 사장님이 이미지를 못 찾습니다.\n"
            "- 홍보 문구는 매장의 실제 정보만 근거로 생성됩니다 — 할인·이벤트는 사장님이 "
            "말씀하신 경우에만 문구에 들어간다는 점을 기억하세요.\n"
            "- 이미지 결과의 provider가 pollinations면 글자 없는 이미지입니다 — 슬로건은 "
            "이미지에 새겨지지 않았으니 캡션·문구와 함께 쓰시라고 안내하세요."
        ),
    },
    {
        # membership_tools도 registry에만 있고 편성이 빠져 있었다 — sensor·pos와 같은 사고.
        # "요즘 안 오는 단골 있어?"에 답할 도구가 있는데도 챗봇은 못 쓰는 상태였다.
        "name": "membership_expert",
        "title": "단골 회원·선불 충전 전문가",
        "description": (
            "단골 회원과 선불 충전을 조회한다 — 평소보다 뜸해진(이탈 위험) 단골 목록, "
            "이름·전화 뒷자리로 회원 검색(잔액·방문 횟수·방문 주기), "
            "선불 충전 현황(충전액·지급 보너스·사용액·남은 잔액). "
            "'요즘 안 오는 단골 있어?', '김OO님 잔액 얼마야?', '충전 얼마나 됐어?' "
            "같은 요청을 처리한다."
        ),
        "modules": ["app.services.ai.membership_tools"],
        "extra": (
            "- 이 도구들은 전부 조회 전용입니다. 충전·차감·잔액 보정은 손님 돈이 걸린 일이라 "
            "도구로 열어두지 않았습니다 — 요청받으면 실행하지 말고 회원 화면에서 직접 "
            "눌러 주시라고 안내하세요.\n"
            "- 선불 충전액은 매출이 아니라 부채(선수금)입니다. 커피가 나갈 때 매출이 됩니다 — "
            "'충전 얼마나 됐어'에 답할 때 이 둘을 절대 섞지 말고, 남은 잔액이 갚아야 할 돈이라는 "
            "점을 밝히세요.\n"
            "- 손님 연락처는 가려진 형태로만 옵니다. 도구가 준 그대로 쓰고 복원하려 하지 마세요.\n"
            "- 이탈 위험은 그 손님의 평소 방문 주기와 비교한 추정입니다 — 단정하지 말고 "
            "'평소보다 뜸하다'는 사실과 마지막 방문 시점을 함께 전하세요.\n"
            "- 방문이 3회 미만이면 주기를 계산할 수 없습니다. 그럴 땐 계산된 척하지 말고 "
            "'아직 주기를 볼 만큼 방문 기록이 쌓이지 않았다'고 보고하세요."
        ),
    },
    {
        # 메뉴를 '바꾸기 전에' 답해야 하는 질문 — 재고 전문가(등록·조회)와 일부러 분리했다.
        # 가격을 올려도 되는지는 조회가 아니라 판단이고, 근거가 판매·원가 두 곳에 걸쳐 있다.
        "name": "menu_expert",
        "title": "메뉴 개선 전문가",
        "description": (
            "메뉴를 어떻게 개선할지 먼저 찾아 주고(추천), 사장님이 정한 안이 괜찮은지 점검한다. "
            "추천: 팔수록 손해인 메뉴의 적정 가격, 재료비 비중이 높은 메뉴의 인상 폭, "
            "안 나가는 메뉴 정리, 신메뉴 아이디어. "
            "점검: 가격 인상·인하, 메뉴 단종, 신메뉴 추가, 원가 절감의 효과와 위험. "
            "'메뉴 개선 추천해줘', '뭘 바꾸면 좋을까?', '신메뉴 뭐 넣을까?', "
            "'아메리카노 500원 올려도 될까?', '이 메뉴 빼도 돼?', '메뉴 구성 좀 봐줘' 같은 "
            "요청을 처리한다. 메뉴 등록·레시피 수정 자체는 재고 전문가 담당이다."
        ),
        "modules": ["app.services.ai.menu_review_tools"],
        "extra": (
            "- 무엇을 바꿀지 정해지지 않은 질문('뭘 바꾸면 좋을까')에는 suggest_menu_improvements를 "
            "쓰세요. 도구가 준 제안만 전하고, 목록에 없는 메뉴를 임의로 권하지 마세요.\n"
            "- 제안을 보고할 때는 why(왜 권하는지)를 근거로 함께 말하고, 급한 것 2~3개만 "
            "추리세요. 여섯 개를 다 늘어놓으면 하나도 실행되지 않습니다.\n"
            "- actionable이 false인 제안(원가 미등록)은 바로 적용할 수 없습니다. "
            "'이것부터 해야 나머지 계산이 선다'는 뜻으로 전하세요.\n"
            "- 가격 인상을 물으면 '얼마 더 번다'로 끝내지 말고 breakeven_drop_pct를 반드시 "
            "전하세요 — 사장님이 진짜 걱정하는 건 손님이 떨어지는 것입니다 "
            "(예: '판매가 13.9%, 52잔까지 줄어도 본전이에요'). '손익분기점'·'기여이익' 같은 용어 "
            "대신 '이만큼 줄어도 본전', '남는 돈'처럼 풀어 말하세요.\n"
            "- 손님이 얼마나 빠질지는 아무도 모릅니다. 추측한 이탈률로 계산하지 마세요.\n"
            "- 모든 계산은 '최근 판매량이 유지된다면'이라는 가정 위에 있습니다. 한 번은 밝히세요.\n"
            "- 원가(레시피)가 없는 메뉴는 도구가 마진을 비워서 줍니다. 0원으로 넘겨짚지 말고 "
            "'레시피를 넣으면 계산해 드릴 수 있다'고 안내하세요.\n"
            "- 신메뉴의 원가는 표준 레시피나 매장 평균으로 잡은 추정입니다(after.cost_source). "
            "추정임을 밝히고, 판매량은 알 수 없어 월 수익 합계에서 빠졌다는 점도 전하세요.\n"
            "- 이 도구는 계산만 합니다. 실제 가격 변경·단종은 메뉴 화면에서 사장님이 "
            "'적용'을 눌러야 반영된다고 안내하세요."
        ),
    },
    {
        "name": "operation_expert",
        "title": "운영·세무 전문가",
        "description": (
            "판매량 예측(익일·금주 — 날씨·요일·공휴일·행사 반영, 발주 추천 포함), "
            "운영 리포트 요약, 로스터리 원두 시세 비교, 세금 간이 추정 및 "
            "주요 세무 신고 기한(부가세·종소세·원천징수 일정) 조회를 처리한다."
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
        # POS 실시간 연동 — 레지스트리엔 있으나 편성이 빠져 챗봇이 못 쓰던 도구
        "name": "pos_expert",
        "title": "POS 연동 전문가",
        "description": (
            "매장 POS(Square 등) 연동 상태를 확인하고 즉시 동기화한다 — "
            "'포스 연동 잘 돼 있어?', '지금 매출 동기화해줘', '마지막으로 언제 동기화됐어?' "
            "같은 요청을 처리한다."
        ),
        "modules": ["app.services.ai.pos_tools"],
        "extra": (
            "- get_pos_status로 연동 여부·마지막 동기화 시각을 먼저 확인하고, 사장님이 "
            "동기화를 원하면 sync_pos_now를 부르세요.\n"
            "- 연동이 안 된 매장이라는 응답이 오면 지어내지 말고 'POS가 아직 연동되지 않았다'고 "
            "그대로 안내하고, 설정 화면에서 연결하시라고 전하세요."
        ),
    },
    {
        # 원두 추천·리뷰 RAG·시세 — 백엔드 C 도구지만 편성이 빠져 챗봇 사각지대였다
        "name": "bean_expert",
        "title": "원두 추천·구매 전문가",
        "description": (
            "로스터리 원두를 추천·검색하고, 리뷰 근거로 특성을 설명하며, 더 싼 대체 원두와 "
            "최저가를 찾아 준다 — '고소한 원두 추천해줘', '이 원두 리뷰 어때?', "
            "'○○ 원두 더 싼 데 있어?', '△△ 원두 최저가 얼마야?' 같은 요청을 처리한다."
        ),
        "modules": ["app.services.operation.bean_chatbot_tools"],
        "extra": (
            "- 추천·설명 근거는 수집된 로스터리 상품 정보와 리뷰입니다 — 도구가 준 사실만 쓰고, "
            "리뷰가 부족하면 '근거가 적다'고 솔직히 보고하세요.\n"
            "- 가격·최저가는 수집 시점 기준 참고값입니다. 금액을 말할 때 '수집 시점 기준'임을 "
            "한 번은 밝히세요.\n"
            "- 이 도구들은 시장(로스터리) 정보라 특정 매장에 묶이지 않습니다 — 매장 재고와 혼동하지 "
            "마세요(내 재고 질문은 재고 전문가 소관)."
        ),
    },
    {
        # sensor_tools는 registry에만 있고 여기 편성이 빠져 있어 챗봇이 못 쓰는 상태였다.
        # "지금 원두 얼마나 남았어?" 같은 실시간 질문에 답할 도구가 없었던 것 — 편성으로 해결.
        "name": "sensor_expert",
        "title": "매장 설비·센서 전문가",
        "description": (
            "매장 IoT 센서의 실시간 상태를 읽는다 — 원두 호퍼 잔량(카페인/디카페인), "
            "오늘 추출 잔 수, 소진 예상 시각, 우유 잔량, 냉장고 온도, 정수 수위, 머신 상태. "
            "'지금 원두 얼마나 남았어?', '냉장고 온도 어때?', '기계 상태 봐줘' 같은 "
            "실시간 질문과 센서 기반 발주 코치를 담당한다."
        ),
        "modules": ["app.services.ai.sensor_tools"],
        "extra": (
            "- 센서 값은 '지금 이 순간'의 측정치입니다 — 언제 기준인지(방금 측정)를 밝히세요.\n"
            "- 발주·준비·추천 질문('뭘 발주해야 해', '주말 준비')에는 반드시 get_sensor_order_coach를 "
            "쓰세요. 스냅샷만 보고 직접 판단하지 마세요 — 코치는 최근 7일 판매 추세까지 반영하지만 "
            "스냅샷은 지금 잔량뿐이라 '아직 충분해 보여도 주말에 모자라는' 경우를 놓칩니다.\n"
            "- 센서 기능이 꺼져 있거나 페어링이 안 된 매장이라는 응답이 오면, 지어내지 말고 "
            "센서 미연결 상태라고 그대로 안내하세요.\n"
            "- 재고 '장부' 수량과 센서 '실측' 잔량은 다를 수 있습니다 — 장부 질문이면 재고 전문가 "
            "소관이라고 보고하세요."
        ),
    },
    {
        "name": "report_expert",
        "title": "경영 리포트 전문가",
        "description": (
            "일간·주간·월간 AI 경영 리포트를 생성·조회한다 — 매출·매입·지출·인건비·수익 추정·"
            "재고 경고·발주 진행·갱신 서류를 한 문서로 통합 집계하고 해석까지 붙인다. "
            "'리포트 만들어줘', '이번 주 어땠어', '왜 이런지 분석해줘'처럼 여러 영역을 묶은 진단이 "
            "필요할 때만 쓴다. 매출·지출 같은 단일 수치를 그냥 확인하는 질문은 data_expert 담당이다."
        ),
        "modules": ["app.services.ai.report_tools"],
        "extra": (
            "- 리포트 생성은 집계 쿼리를 수십 번 도는 무거운 작업입니다. 단순 수치 조회 요청이 "
            "잘못 넘어왔다면 리포트를 만들지 말고 '이 요청은 매장 데이터 전문가 담당입니다'라고 보고하세요.\n"
            "- 리포트를 만들면 highlights의 사실을 근거로 사장님께 도움이 될 해석과 조언을 "
            "한두 문장 덧붙여 보고하세요 (예: 매출 하락 원인 추정, 발주·인건비 조정 제안).\n"
            "- 수치는 도구가 계산한 값만 쓰고, '언제' 리포트인지(기간)를 꼭 밝히세요.\n"
            "- 비교 문장을 쓸 때는 무엇과 무엇을 비교한 것인지 분명히 하세요 "
            "(예: '지난주가 그 전주보다 62.8% 감소'). 기준을 빼먹으면 앞뒤가 안 맞는 말이 됩니다.\n"
            "- 보고는 전부 한국어로 쓰세요. 도구 결과의 영문 키(total, change_pct, ai_advice 등)나 "
            "JSON 조각을 그대로 옮기지 말고, '매출', '증감률'처럼 사장님이 아는 말로 바꿔 전하세요."
        ),
    },
    {
        # 사장님이 가장 자주 하는 돈 질문 두 가지 — "카드 언제 들어와?"와 "인건비 얼마 나가?"
        "name": "settlement_expert",
        "title": "정산·인건비·손익 전문가",
        "description": (
            "카드 매출 정산과 인건비, 손익분기점을 담당한다: 현금·카드 일 매출 기록, 카드사별 입금 "
            "예정일과 수수료, 이번 주/미입금 대금, 현금·카드 비중, 지난주 같은 요일 대비 매출, "
            "직원별 고용형태·보험에 따른 월 인건비와 주급, 채용 조건 가정 시뮬레이션, "
            "월 고정비 입력과 손익분기점(본전 매출·하루 목표 잔 수·목표이익 역산). "
            "'카드 언제 들어와?', '오늘 현금 12만 카드 45만 팔았어', '이번 주 얼마 줘야 해?', "
            "'시급 11000에 주 20시간이면 얼마 나가?', '얼마 팔아야 본전이야?', "
            "'월 300 남기려면 얼마 팔아야 해?' 같은 요청을 처리한다."
        ),
        "modules": [
            "app.services.ai.breakeven_tools",
            "app.services.ai.settlement_tools",
            "app.services.ai.staff_tools",
        ],
        "extra": (
            "- 입금 예정일과 수수료는 매장 설정(수수료 구간·카드사별 입금 소요일) 기준 예상치입니다. "
            "금액을 보고할 때 '예상'임을 한 번은 밝히고, 통장과 다르면 설정에서 고칠 수 있다고 안내하세요.\n"
            "- 사장님이 매출 금액을 말하면 대화로만 답하지 말고 record_day_sales로 반드시 기록하세요. "
            "기록해야 입금 예정과 리포트에 반영됩니다.\n"
            "- 카드사를 말하지 않으면 임의로 정하지 말고 '카드사 미지정'으로 기록되며 입금일이 "
            "보수적으로(늦게) 잡힌다는 점을 알려주세요.\n"
            "- 인건비는 '직원이 받는 돈(gross_pay)'과 '매장에서 나가는 돈(total_cost)'이 다릅니다. "
            "사장님이 묻는 건 대개 후자이니 둘을 구분해 말하고, 주휴수당·사업주 보험 부담이 "
            "포함됐다는 사실을 밝히세요.\n"
            "- 보험 요율과 최저임금은 매년 바뀌는 고시 기준이라 추정치입니다. 확정 금액은 "
            "4대보험 고지서로 확인하라고 덧붙이세요.\n"
            "- 매출 비교는 어제가 아니라 '지난주 같은 요일' 기준입니다 — 요일마다 손님 수가 "
            "다르기 때문입니다. 비교 기준을 반드시 밝히세요.\n"
            "- 손익분기점은 get_breakeven_point를 쓰세요. 응답의 computed가 false면 숫자를 "
            "지어내지 말고 message를 그대로 전하며, needs에 적힌 값(고정비·변동비율)을 물어보세요.\n"
            "- 사장님이 고정비를 말하면(예: '임대료 200에 인건비 300이야') save_fixed_costs로 "
            "저장하세요. 저장해야 다음에 물어볼 때 바로 답할 수 있습니다.\n"
            "- 월 목표는 크게 느껴져 행동으로 안 이어집니다. 보고할 때 하루 목표 매출과 "
            "잔 수를 반드시 함께 말하세요.\n"
            "- 손익분기점은 '최근 판매 구조가 유지된다면'이라는 가정 위의 예상치임을 밝히세요."
        ),
    },
    {
        "name": "todo_expert",
        "title": "할 일 비서",
        "description": (
            "사장님의 할 일 목록(홈 화면)에 항목을 추가·조회하고 완료 처리한다. "
            "'잊지 말라고 해줘', '메모해줘', '할 일에 넣어줘', '오늘 뭐 해야 해?', "
            "'그거 했어' 같은 요청을 담당한다. 또한 '오늘 브리핑 해줘', '오늘 상황 정리해줘', "
            "'지금 급한 거 뭐야?', '다음 할 일 뭐야?', '그거 시작할게' 같은 요약·진행 요청도 "
            "처리한다 (어제 매출·오늘 근무·입금 예정을 묶은 아침 브리핑 포함)."
        ),
        "modules": [
            "app.services.ai.briefing_tools",
            "app.services.ai.todo_tools",
            "app.services.operation.assistant_tools",
        ],
        "extra": (
            "- 사장님이 나중에 할 일을 말하면 대화로만 답하지 말고 반드시 add_todo로 목록에 남기세요. "
            "말로만 '알겠습니다'라고 하면 홈 화면에는 아무것도 안 생깁니다.\n"
            "- title은 홈 화면에 한 줄로 보이므로 짧게 쓰고(예: '원두 발주'), 배경 설명은 note에 담으세요.\n"
            "- 재고 부족·서류 갱신은 홈 화면이 자동으로 잡아 주므로 할 일로 또 추가하지 마세요. "
            "중복해서 보이기만 합니다.\n"
            "- '오늘 뭐 해야 해?'·목록 조회는 todo 도구를, '다음 할 일'은 get_next_task_tool을 쓰세요. "
            "완료 처리는 한 가지 도구로만 하고(둘로 중복 처리하지 마세요), 대상이 애매하면 후보를 "
            "보여주며 되물으세요.\n"
            "- 브리핑 도구는 두 가지이고 답이 다릅니다. 매장 상황 전반을 묻는 "
            "'오늘 뭐부터 해야 해?'·'오늘 상황 정리해줘'·'지금 급한 거 뭐야?'는 get_today_briefing을 "
            "쓰세요 — 어제 매출·오늘 근무·오늘 입금 예정과 급한 일 3가지가 들어 있고, 아침 알림으로 "
            "나간 것과 같은 내용이라 사장님이 알림에서 본 것과 답이 일치합니다. "
            "할 일 진행 상황만 묻는 '오늘 뭐 했지?'는 get_voice_briefing_tool을 쓰세요. "
            "둘을 같이 부르지 마세요 — 같은 얘기가 두 번 나옵니다."
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
        "extra": (
            "- 검색 전에 사장님의 요청을 '무엇을 알고 싶은가'로 좁혀, 문장이 아닌 핵심 키워드 질의로 재구성하세요.\n"
            "  (예: '요즘 잘나가는 디저트 뭐야?' → query='2026 카페 디저트 트렌드 인기 메뉴')\n"
            "- 최신성이 중요한 질문(뉴스·가격·시세·트렌드·행사)은 time_range를 지정하고, 언론 보도가\n"
            "  필요하면 topic='news'를 쓰세요. 해외 정보는 country를 비우고 영어 질의로 검색하세요.\n"
            "- 첫 검색 결과가 질문에 대한 답을 담고 있지 않으면, 같은 질의를 반복하지 말고 키워드를\n"
            "  바꾸거나 좁혀서 최대 2회까지 다시 검색하세요.\n"
            "- 보고는 사장님의 질문에 대한 직접적인 답부터 쓰고, 그 근거를 이어서 정리하세요.\n"
            "  검색 결과에 없는 내용을 지어내지 말고, 못 찾았으면 못 찾았다고 보고하세요.\n"
            "- 참고한 출처 링크 주소들을 빠짐없이 정리하여 최종 답변에 함께 적어주세요."
        ),
    },
]

_MAIN_PROMPT = """당신은 카페 사장님들을 위한 AI 비서 '{agent_name}'입니다.
어려운 전문 용어 없이, 누구나 바로 이해할 수 있게 한국어 구어체로 대답합니다.

[말투 — 사장님은 당신의 상사입니다]
- 차분하고 공손한 존댓말로, 비서가 보고하듯 담백하게 말하세요. 들뜬 말투와 느낌표 남발은 금지.
- 사장님을 가르치려 들지 마세요. "잊지 말고 챙겨주세요", "~하셔야 해요" 같은 훈계·당부조 대신
  "~해 두시면 좋을 것 같아요", "확인해 보시겠어요?"처럼 조심스럽게 제안하세요.
- 적자·매출 하락 같은 안 좋은 소식은 밝게 포장하지 말고 담담하게 사실대로 전하세요.
  나쁜 숫자 앞에서 명랑한 말투는 실례입니다.
- 생색·잘난 척 금지: "제가 다 확인해 봤는데요", "아, 그리고" 같은 표현 없이 바로 내용을 말하세요.

당신은 직접 데이터를 조회하지 않습니다. 대신 아래 전문가 팀을 부하 직원처럼 부릴 수 있습니다:
{experts}

[행동 규칙]
1. 매장 데이터가 필요한 요청은 반드시 알맞은 전문가에게 위임하세요. 위임할 때는 task에
   사장님의 요청을 구체적인 한국어 지시문으로 바꿔서 전달하세요.
   (예: "이번 달 김철수 월급 계산해줘" → document_expert에게 "2026년 7월 김철수 임금명세서 초안을 만들어줘")
   숫자 하나를 확인하는 질문("매출 얼마야", "지출 얼마 썼어", "몇 시간 일했어")은 data_expert에게
   보내세요. report_expert는 여러 영역을 묶은 진단·해석이 필요할 때만 부릅니다 — 리포트 생성은
   무거워서 단순 조회에 쓰면 답이 느려지고 엉뚱한 항목까지 섞여 나옵니다.
   '만들어줘·써줘' 류의 콘텐츠 생성 요청(홍보 문구·홍보 이미지·발주서·명세서·계약서·리포트)은
   데이터 조회가 아니어도 반드시 담당 전문가에게 위임하세요. 당신이 직접 글을 지어 답하면
   그럴듯해 보여도 도구를 거치지 않은 것이라 아무 데도 저장되지 않고, 홍보물·문서 목록에도
   남지 않으며 카드로도 표시되지 않습니다 — 사장님은 나중에 "만들어 줬다던 게 어디에도
   없다"는 걸 발견하게 됩니다. (예: "인스타에 올릴 홍보 문구 써줘" → marketing_expert)
2. 여러 영역에 걸친 질문이면 전문가를 차례로 호출해 결과를 종합하세요.
3. 전문가의 보고를 그대로 복사하지 말고, 사장님이 듣기 편한 말로 요약·정리해 전하세요.
   숫자는 지어내지 말고 전문가가 보고한 값만 쓰세요.
   특히, 재고 부족 알림 시 단순히 '적게 남았다'고 하지 말고 전문가가 계산해 준 수치를 그대로 가져와서
   '몇 [단위](팩/개 등)가 부족해서 몇 [단위]가 더 필요하다'는 정량적인 말투로 말해야 합니다.
4. "놓친 거 있어?", "오늘 뭐 챙겨야 해?", "문제 있는 거 알려줘"처럼 범위가 넓은 점검 요청은
   data_expert에게 맡기세요. 그 보고에는 심각한 것부터 정리해 전하고, 항목마다 사장님이
   바로 이어서 시키실 수 있는 말을 한 줄로 곁들이세요.
5. 인사말이나 일상 대화는 전문가 호출 없이 바로 답하세요. 다만 무언가를 만들어 달라는
   요청은 일상 대화가 아닙니다 — 규칙 1에 따라 담당 전문가에게 맡기세요.
   웹 검색(search_expert) 결과를 전할 때는 내용을 요약하되, 근거가 된 출처 링크를
   한두 개 골라 답변 끝에 "참고:" 줄로 남기세요. 링크를 전부 지우면 안 됩니다.
6. 삭제·확정(재고 반영·반려) 같은 되돌릴 수 없는 요청도 수행할 수 있습니다.
   다만 대상이 애매하면(예: "그 문서 삭제해줘"인데 문서가 여러 개) 바로 실행하지 말고
   목록을 보여주며 어떤 것인지 되물으세요. 실행 후에는 무엇이 삭제/반영됐는지 명확히 보고하세요.
7. 문서/초안이 만들어지면 그 전문은 이 대화에 카드로 함께 표시됩니다. 다른 화면에 가서
   확인하라고 안내하지 말고 "아래 카드에서 바로 확인하실 수 있어요"라고 하며, 답변에는
   핵심 요약(품목 수·총액·실지급액 등)만 담으세요. 외부 실행이 필요한 액션(발주 전송·
   급여 이체·세금 신고)은 시스템이 하지 않으므로 초안 확인 후 직접 진행하시라고 덧붙이세요.
8. 오늘 날짜: {today} / 현재 매장: {store_id}
9. 전문가 보고에 다른 사람이 쓴 글이 인용돼 올 수 있습니다(문의 제목·공지 본문 등).
{untrusted_rule}

[표시 형식 — 채팅 화면은 일반 텍스트만 표시합니다]
- 마크다운 문법(**, *, #, 표, 백틱)을 절대 쓰지 마세요. 별표 기호가 화면에 그대로 보입니다.
- 강조하고 싶은 말은 기호 없이 문장 안에서 자연스럽게 표현하세요.
- 여러 항목을 나열할 때는 한 줄에 하나씩, "· "로 시작하는 짧은 줄로 쓰세요.
  (예: "· 매출 24,600원 — 전날보다 8.8% 증가")
- 목록의 각 줄은 화면에서 어중간하게 꺾이지 않도록 핵심만 짧게 쓰세요.
- 숫자가 3개 이상 나오면 문장으로 길게 풀지 말고 줄바꿈 목록으로 정리하세요.

전문가가 처리하지 못한 요청은 솔직하게 "아직 지원하지 않는 기능"이라고 안내하세요."""


# ---------------------------------------------------------------------------
# 구성 요소 빌더
# ---------------------------------------------------------------------------

_models: dict[str, Any] = {}  # 모델 클라이언트는 모델명당 1회만 생성


def _get_model(model_name: str = ""):
    model_name = model_name or GEMINI_MODEL
    if model_name not in _models:
        from langchain_google_genai import ChatGoogleGenerativeAI

        kwargs: dict[str, Any] = {}
        # 2.5 계열은 기본이 '동적 사고'라 턴마다 사고 토큰을 태운다 — 챗봇은 한 턴에
        # 메인+전문가로 4~8회 호출이 겹치므로 지연·무료쿼터 소모가 배로 커진다.
        # OCR 서비스와 같은 규칙으로 사고 예산을 끈다 (2.5 계열에만 적용).
        if model_name.startswith("gemini-2.5"):
            kwargs["thinking_budget"] = 0
        _models[model_name] = ChatGoogleGenerativeAI(
            model=model_name,
            google_api_key=GEMINI_API_KEY,
            temperature=0.2,  # 도구 호출 일관성 우선
            max_retries=2,  # 일일 쿼터 소진 429는 재시도로 안 풀린다 — 기본 6회 백오프(30초+) 방지
            **kwargs,
        )
    return _models[model_name]


def _is_quota_error(e: Exception) -> bool:
    s = f"{type(e).__name__}: {e}"
    return "RESOURCE_EXHAUSTED" in s or "429" in s


def _is_rate_limit(e: Exception) -> bool:
    """분당 요청 수 초과인지 (일일 할당량 소진과 구분해 안내 문구를 다르게 준다).

    무료 티어는 분당 15요청이라, 멀티에이전트가 한 턴에 메인+전문가로 여러 번 호출하면
    질문을 연달아 던질 때 쉽게 걸린다. 이건 잠시 뒤 저절로 풀리므로 '오늘 다 썼다'고
    안내하면 안 된다.

    일일 소진을 먼저 걸러낸다 — 구글은 하루치를 다 써도 RetryInfo("Please retry in 21s")를
    같이 준다. retryDelay만 보고 판단하면 하루 종일 "1분 뒤에 다시 해보세요"라고 안내하게
    되고(사장님은 계속 재시도), 관리자 콘솔 실패 사유도 '분당 제한'으로 잘못 찍힌다.
    실측(2026-08-05): quotaId=GenerateRequestsPerDayPerProjectPerModel-FreeTier + retryDelay 동봉.
    """
    s = f"{e}"
    if "PerDay" in s or "per day" in s.lower():
        return False
    return "PerMinute" in s or "RetryInfo" in s or "retryDelay" in s


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


def _bind_store(t, store_id: str, created_docs: list[dict[str, Any]], recorder=None):
    """모든 도구를 공통 래퍼로 감싼다 — 예외 안전망 + 문서 수집, 그리고 store_id 강제.

    · store_id 인자를 받는 도구는 모델이 뭐라 넣든 로그인 사용자 값으로 덮어쓴다 (보안).
    · store_id가 없는 도구(원두 검색·웹 검색 등)도 예외 안전망은 똑같이 필요하다 —
      예전엔 이런 도구를 감싸지 않고 그대로 돌려줘, 그 도구가 터지면 턴 전체가 죽고
      사장님은 "앗! 문제가 생겼어요"만 받았다. 이제는 어느 도구가 터져도 문자열로
      돌려줘 모델이 그 도구만 포기하고 대화를 이어갈 수 있다.
    · 결과가 문서 전문이면 created_docs에 모아 — 최종 응답에 카드로 실어 보낸다.
    · recorder가 있으면 어느 도구가 몇 번 불렸고 몇 번 실패했는지 계측한다
      (관리자 콘솔 AI 에이전트 탭. 없으면 계측만 건너뛴다).
    """
    from langchain_core.tools import StructuredTool

    # args_schema가 없는 특수 도구는 StructuredTool로 다시 감쌀 수 없으므로 원본을 쓴다
    if getattr(t, "args_schema", None) is None:
        return t
    has_store = bool(getattr(t, "args", None) and "store_id" in t.args)

    def _note(ok: bool):
        if recorder is not None:
            recorder.tool_called(t.name, ok)

    def _collect(result):
        doc = _extract_document(result)
        if doc and all(d["id"] != doc["id"] for d in created_docs):
            created_docs.append(doc)
        if recorder is not None:
            # 감사 규칙('근거 없는 금액')이 답변 속 숫자를 대조할 근거로 쓴다
            recorder.tool_output(result)
        return result

    def _run(**kwargs):
        if has_store:
            kwargs["store_id"] = store_id
        try:
            result = t.invoke(kwargs)
        except Exception as e:
            # 도구 하나의 예상 밖 예외(의존성 누락·외부 API 죽음 등)가 턴 전체를 죽이지
            # 않도록 문자열로 돌려준다. (각 도구의 자체 except가 1차 방어, 여기가 마지막 그물)
            logger.exception("도구 실행 실패: %s", t.name)
            _note(False)
            return f"도구 '{t.name}' 실행 실패: {type(e).__name__}"
        _note(True)
        return _collect(result)

    async def _arun(**kwargs):
        # async 도구(pos_tools 등)는 sync 경로(t.invoke)가 NotImplementedError라
        # 코루틴 경로가 반드시 있어야 한다. generate_response가 ainvoke를 쓰므로
        # 실제 실행은 이쪽을 탄다 — sync 도구도 ainvoke가 executor로 처리해 준다.
        if has_store:
            kwargs["store_id"] = store_id
        try:
            result = await t.ainvoke(kwargs)
        except Exception as e:
            logger.exception("도구 실행 실패: %s", t.name)
            _note(False)
            return f"도구 '{t.name}' 실행 실패: {type(e).__name__}"
        _note(True)
        return _collect(result)

    return StructuredTool(
        name=t.name,
        description=t.description,
        args_schema=t.args_schema,
        func=_run,
        coroutine=_arun,
    )


# ---------------------------------------------------------------------------
# 시스템 프롬프트 렌더링 — format 인자를 이 두 함수에만 둔다.
#
# 프롬프트에 {자리표시자}를 추가하고 format 인자를 빠뜨리면 KeyError로 모든 대화가
# 즉시 실패하는데, generate_response가 예외를 삼켜 "문제가 생겼어요"만 나가고
# /chatbot/agents 헬스체크는 여전히 정상을 보고한다 — 통째로 죽어도 신호가 없다.
# tests/test_agent_prompt_format.py가 이 함수들을 직접 호출해 그 사고를 막는다.
# ---------------------------------------------------------------------------

def render_main_prompt(experts: str, store_id: str) -> str:
    """메인 오케스트레이터(브루)의 시스템 프롬프트를 채운다."""
    return _MAIN_PROMPT.format(
        agent_name=_MAIN_AGENT["name"],
        experts=experts,
        today=today_kst().isoformat(),
        store_id=store_id,
        untrusted_rule=UNTRUSTED_PROMPT_RULE,
    )


def render_sub_prompt(domain: dict[str, Any], store_id: str) -> str:
    """서브에이전트(전문가) 하나의 시스템 프롬프트를 채운다.

    today: 메인 프롬프트에만 있던 오늘 날짜를 서브에도 넣는다 — 서브가 날짜를 모르면
    '내일 발주' 같은 상대 날짜를 환각으로 채워 과거 날짜가 저장되는 사고가 났다.
    """
    return _SUB_PROMPT_BASE.format(
        title=domain["title"],
        store_id=store_id,
        today=today_kst().isoformat(),
        untrusted_rule=UNTRUSTED_PROMPT_RULE,
        extra=domain["extra"],
    )


def _build_subagent(domain: dict[str, Any], store_id: str, created_docs: list[dict[str, Any]],
                    model_name: str = "", recorder=None):
    """도메인 하나의 서브에이전트를 만든다. 도구가 하나도 없으면 None (비활성 도메인)."""
    from langchain.agents import create_agent

    tools = [_bind_store(t, store_id, created_docs, recorder) for m in domain["modules"] for t in _module_tools(m)]
    if not tools:
        return None
    # today: 메인 프롬프트에만 있던 오늘 날짜를 서브에도 넣는다 — 서브가 날짜를 모르면
    # '내일 발주' 같은 상대 날짜를 환각으로 채워 과거 날짜가 저장되는 사고가 났다.
    return create_agent(_get_model(model_name), tools,
                        system_prompt=render_sub_prompt(domain, store_id))


def _last_text(result: dict[str, Any]) -> str:
    """langgraph 결과에서 마지막 AI 메시지의 텍스트를 꺼낸다 (Gemini는 파트 리스트일 수 있음)."""
    content = result["messages"][-1].content
    if isinstance(content, list):
        return "".join(p.get("text", "") if isinstance(p, dict) else str(p) for p in content)
    return str(content)


def _make_delegate_tool(domain: dict[str, Any], subagent, recorder=None):
    """서브에이전트를 메인 에이전트의 도구 하나로 감싼다 (agent-as-tool).

    위임 한 번이 곧 '전문가 호출 한 번'이라, 여기가 전문가별 호출 횟수·소요 시간을
    재는 유일하게 정확한 지점이다 (관리자 콘솔 AI 에이전트 탭).
    """
    from langchain_core.tools import StructuredTool

    async def _delegate(task: str) -> str:
        logger.info("메인 → %s 위임: %s", domain["name"], task[:80])
        started = time.perf_counter()
        try:
            result = await subagent.ainvoke(
                {"messages": [{"role": "user", "content": task}]},
                # run_name: LangSmith 트레이스 트리에서 어느 전문가의 실행인지 바로 보이게
                config={"recursion_limit": SUB_RECURSION_LIMIT, "run_name": domain["name"]},
            )
        except Exception:
            if recorder is not None:
                recorder.expert_called(domain["name"], (time.perf_counter() - started) * 1000, ok=False)
            raise
        if recorder is not None:
            recorder.expert_called(domain["name"], (time.perf_counter() - started) * 1000, ok=True)
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

def get_agent_overview() -> dict[str, Any]:
    """관리자 콘솔(3000)용 — 메인 에이전트와 서브에이전트 편성을 한눈에 보여준다.

    실제 대화 때와 같은 규칙(_module_tools)으로 도구를 로드해 보기 때문에,
    여기서 '활성'으로 나오면 챗봇에서도 그 전문가가 실제로 활성화된다.
    """
    runtime = runtime_stats.snapshot()
    # 전문가별 실행 실적을 편성표에 얹는다 — '있다'와 '실제로 쓰인다'는 다른 이야기다
    usage = {e["name"]: e for e in runtime.get("experts", [])}
    tool_usage = {t["name"]: t for t in runtime.get("tools", [])}

    experts: list[dict[str, Any]] = []
    total_tools = 0
    for domain in _DOMAINS:
        tools = []
        for module_path in domain["modules"]:
            for t in _module_tools(module_path):
                desc = (t.description or "").strip().splitlines()
                used = tool_usage.get(t.name)
                tools.append({
                    "name": t.name,
                    "description": desc[0][:120] if desc else "",
                    "module": module_path,
                    "calls": used["calls"] if used else 0,
                })
        total_tools += len(tools)
        stat = usage.get(domain["name"])
        experts.append({
            "name": domain["name"],
            "title": domain["title"],
            "description": domain["description"],
            "modules": domain["modules"],
            "active": bool(tools),
            "tool_count": len(tools),
            "tools": tools,
            "calls": stat["calls"] if stat else 0,
            "avg_ms": stat["avg_ms"] if stat else 0,
            "failures": stat["failures"] if stat else 0,
        })

    return {
        "main": {
            **_MAIN_AGENT,
            "model": GEMINI_MODEL,
            "api_key_set": bool(GEMINI_API_KEY),
            "recursion_limit": MAIN_RECURSION_LIMIT,
        },
        "sub_recursion_limit": SUB_RECURSION_LIMIT,
        "langsmith_enabled": bool(os.getenv("LANGSMITH_API_KEY", "").strip()),
        "active_experts": sum(1 for e in experts if e["active"]),
        "total_experts": len(experts),
        "total_tools": total_tools,
        "experts": experts,
        # 서버 시작 이후의 실제 실행 현황 (프로세스 메모리 기준 — 재시작하면 0부터)
        "runtime": runtime,
        # 기능 검증(QA) 멀티에이전트 편성 — 챗봇 편성과 별개로, 저장소 전체를 기능
        # 단위로 검증한 마지막 실행의 판정표. 콘솔이 하단에 함께 그린다.
        "qa_fleet": _qa_fleet_snapshot(),
    }


def _qa_fleet_snapshot() -> dict[str, Any]:
    from app.services.ai.agents import qa_fleet
    return qa_fleet.snapshot()


def _audit_turn_safely(store_id: str, question: str, answer: str, recorder, ms: float) -> None:
    """대화 한 턴을 감시 규칙으로 훑는다 (실패해도 대화에는 영향 없음).

    별도 함수로 뺀 이유: generate_response의 정상 반환 경로를 한 줄로 유지하려고.
    실패 경로(한도 소진·DB 다운)는 감사하지 않는다 — 그때 나가는 안내 문구는 챗봇의
    답변 품질과 무관해서, 감사하면 사고 후보가 안내 문구로 뒤덮인다.
    """
    try:
        from app.services.ai import answer_audit

        answer_audit.audit_turn(
            store_id, question, answer,
            tools=list(dict.fromkeys(recorder.tools)),
            experts=list(dict.fromkeys(recorder.experts)),
            expects_data=answer_audit.looks_like_store_question(question),
            ms=ms,
            # 이걸 안 넘기면 '근거 없는 금액' 규칙(w_unsupported_number)이 항상 침묵한다
            tool_output="\n".join(recorder.outputs),
        )
    except Exception:
        logger.debug("턴 자동 감사 실패", exc_info=True)


async def generate_response(
    user_message: str,
    store_id: str,
    history: Optional[list[dict[str, Any]]] = None,
) -> dict[str, Any]:
    """멀티에이전트 실행: 서브에이전트 구성 → 메인 오케스트레이터가 위임 판단 → 최종 답변.

    반환: {"text": 답변 텍스트, "documents": 이번 턴에 생성/수정된 문서 전문 리스트, "ok": bool}
    documents는 챗봇 화면이 말풍선 아래에 카드로 그대로 렌더링한다.
    ok=False면 이번 턴이 실제 AI 답변을 만들지 못한 것(키 없음·전문가 없음·예외) —
    호출부(/chat)가 이걸 보고 차감한 챗봇 쿼터를 되돌린다. 여기서 예외를 전부 삼켜
    정상 dict로 돌려주므로, ok 없이는 호출부의 환불(except)에 영영 도달하지 못한다.
    """
    from datetime import date

    from langchain.agents import create_agent

    # 실행 계측 — 이 턴에서 어느 전문가·도구가 불렸는지 모아 두었다가 끝에 한 번 기록한다
    started = time.perf_counter()
    recorder = runtime_stats.TurnRecorder()

    def _elapsed_ms() -> float:
        return (time.perf_counter() - started) * 1000

    if not GEMINI_API_KEY:
        runtime_stats.record_turn(store_id, _elapsed_ms(), "no_api_key", recorder, user_message)
        return {"text": "죄송합니다. 챗봇의 핵심 API 키(GEMINI_API_KEY)가 설정되어 있지 않아 대화가 불가능합니다. 시스템 관리자에게 문의해 주세요.", "documents": [], "ok": False}

    # created_docs: 이번 요청에서 문서 도구가 만든/수정한 문서 전문이 여기 모인다
    created_docs: list[dict[str, Any]] = []

    # 이전 대화 이력 + 현재 질문
    messages: list[dict[str, str]] = []
    for h in history or []:
        role = "assistant" if h.get("role") in ("model", "assistant") else "user"
        text = h.get("text") or h.get("content") or ""
        if text:
            messages.append({"role": role, "content": text})
    messages.append({"role": "user", "content": user_message})

    async def _run_turn(model_name: str) -> Optional[str]:
        """주어진 모델로 서브에이전트+메인을 구성해 한 턴을 실행한다. 활성 전문가가 없으면 None."""
        # 1) 도메인별 서브에이전트 구성 (도구가 없는 도메인은 자동 제외)
        delegate_tools = []
        expert_lines = []
        for domain in _DOMAINS:
            subagent = _build_subagent(domain, store_id, created_docs, model_name, recorder)
            if subagent is None:
                continue
            delegate_tools.append(_make_delegate_tool(domain, subagent, recorder))
            expert_lines.append(f"- {domain['name']} ({domain['title']}): {domain['description']}")

        if not delegate_tools:
            return None

        # 2) 메인 오케스트레이터 구성
        main = create_agent(
            _get_model(model_name),
            delegate_tools,
            system_prompt=render_main_prompt("\n".join(expert_lines), store_id),
        )

        # 3) 실행
        result = await main.ainvoke(
            {"messages": messages},
            config={
                "recursion_limit": MAIN_RECURSION_LIMIT,
                # LangSmith 분석용 — 대화 한 턴이 트레이스 하나로 묶이고, 매장·대화 길이로 필터 가능
                "run_name": "chatbot-turn",
                "tags": ["simplem", "chatbot"],
                "metadata": {"store_id": store_id, "history_turns": len(messages) - 1,
                             "model": model_name},
            },
        )
        return _last_text(result).strip()

    try:
        answer = await _run_turn(GEMINI_MODEL)

        if answer is None:
            runtime_stats.record_turn(store_id, _elapsed_ms(), "no_expert", recorder, user_message)
            return {"text": "지금은 연결된 기능이 없어 일반 대화만 가능해요. 무엇이 궁금하신가요?",
                    "documents": [], "ok": False}
        # 모델이 빈 답을 준 경우(answer == "")도 실패로 본다 — 사장님은 실질 답변을 못 받았다
        runtime_stats.record_turn(store_id, _elapsed_ms(), "ok" if answer else "empty", recorder, user_message)
        # [자동 감사] 감시 규칙으로 이 턴을 훑어, 어긴 게 있으면 사고 후보로 남긴다.
        # 정상 턴이면 정규식만 돌고 끝나므로 응답 시간에 영향이 없다(DB·LLM 접근 없음).
        _audit_turn_safely(store_id, user_message, answer or "", recorder, _elapsed_ms())
        return {"text": answer or "죄송해요, 답변을 만들지 못했어요. 조금 다르게 질문해 주시겠어요?",
                "documents": created_docs, "ok": bool(answer)}
    except Exception as e:
        logger.exception("멀티에이전트 실행 실패")
        # 429 — 분당 제한(잠시 뒤 풀림)과 일일 할당량 소진(내일까지 못 씀)은 안내가 달라야 한다
        if _is_quota_error(e):
            if _is_rate_limit(e):
                runtime_stats.record_turn(store_id, _elapsed_ms(), "rate_limit", recorder, user_message)
                return {"text": ("질문이 잠깐 몰려서 AI 응답이 잠시 제한됐어요. "
                                 "1분쯤 뒤에 다시 물어봐 주시면 정상적으로 답변드릴 수 있어요."),
                        "documents": created_docs, "ok": False}
            runtime_stats.record_turn(store_id, _elapsed_ms(), "quota", recorder, user_message)
            return {"text": ("오늘 사용할 수 있는 AI 응답 무료 사용량을 모두 써서 지금은 답변을 만들 수 없어요. "
                             "내일 다시 시도해 주시거나, 관리자에게 API 사용량 확인을 요청해 주세요."),
                    "documents": created_docs, "ok": False}
        # DB 연결 실패는 원인을 알려줘야 사용자가 조치할 수 있다 (공유 DB 호스트 꺼짐 등)
        if "OperationalError" in type(e).__name__ or "connection" in str(e).lower():
            runtime_stats.record_turn(store_id, _elapsed_ms(), "db", recorder, user_message)
            return {"text": ("지금 매장 데이터베이스에 연결할 수 없어서 데이터 조회를 못 하고 있어요. "
                             "DB 서버가 켜져 있는지 확인해 주세요. (일반 대화는 계속 가능해요)"),
                    "documents": created_docs, "ok": False}
        # 실패 전에 이미 만들어진 문서가 있으면 함께 보여준다 (문서는 DB에 저장된 상태)
        runtime_stats.record_turn(store_id, _elapsed_ms(), "error", recorder, user_message)
        return {"text": "앗! 답변을 준비하다가 문제가 생겼어요. 잠시 후 다시 물어봐 주세요.",
                "documents": created_docs, "ok": False}
