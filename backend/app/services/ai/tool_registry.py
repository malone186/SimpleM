"""전체 도구 등록 (공동 소유) — 각자 모듈 경로 한 줄만 알파벳순 추가

각 팀원은 자기 *_tools.py 모듈 경로를 _TOOL_MODULES에 알파벳순으로 한 줄 추가한다.
모듈에 TOOLS 리스트가 있으면 그것을 쓰고, 없으면 모듈 안의 @tool 객체를 자동 수집한다.
모듈 하나가 깨져도 나머지 도구는 정상 등록된다.
"""

import importlib
import logging

logger = logging.getLogger(__name__)

_TOOL_MODULES = [
    "app.services.inventory_tools",              # 백엔드 A (재고/메뉴/레시피 도구 세트 활성화)
    "app.services.ai.breakeven_tools",           # 백엔드 B (손익분기점 — 고정비 입력·본전 매출·목표이익 역산)
    "app.services.ai.briefing_tools",            # 백엔드 B (오늘 브리핑 — 어제 실적·오늘 근무·급한 일 3가지)
    "app.services.ai.document_tools",            # 백엔드 B (문서 자동화 — 발주서·장부·임금명세서·계약서·부가세)
    "app.services.ai.forecast_tools",            # 백엔드 B (판매 예측·발주 추천)
    "app.services.ai.insight_tools",             # 백엔드 B (선제 인사이트 — 놓친 일·곧 할 일 스캔)
    "app.services.ai.marketing_tools",           # 백엔드 B (홍보/마케팅 — AI 홍보 문구·홍보 이미지 생성)
    "app.services.ai.membership_tools",          # 백엔드 B (단골 회원·선불 충전 — 조회 전용)
    "app.services.ai.nearby_cafe_tools",         # 백엔드 B (주변 카페 상권 분석 — 네이버 지역·리뷰 수집)
    "app.services.ai.nearby_event_tools",        # 백엔드 B (주변 행사 — 축제·팝업 일정과 대비 조언)
    "app.services.ai.ocr_tools",                 # 백엔드 B
    "app.services.ai.pos_tools",                 # 백엔드 B (POS 실시간 연동 — 상태 조회·즉시 동기화)
    "app.services.ai.price_tools",               # 백엔드 B (인터넷 가격 비교)
    "app.services.ai.report_tools",              # 백엔드 B (경영 리포트 — 일간·주간·월간)
    "app.services.ai.sensor_tools",              # 백엔드 B (매장 IoT 센서 실시간 상태·발주 코치)
    "app.services.ai.settlement_tools",          # 백엔드 B (카드 정산 — 매출 기록·수수료·입금 예정일)
    "app.services.ai.staff_tools",               # 백엔드 B (직원 인건비 — 주휴수당·4대보험 사업주 부담)
    "app.services.ai.store_data_tools",          # 백엔드 B (매장 원천 데이터 통합 조회 — 매출·발주·지출·직원)
    "app.services.ai.todo_tools",                # 백엔드 B (할 일 목록 추가·조회·완료)
    "app.services.ai.web_search_tools",          # 백엔드 B (Tavily 웹 검색 통합)
    "app.services.operation.assistant_tools",    # 백엔드 B (음성 비서 — 브리핑·다음 할 일·완료/시작)
    "app.services.operation.bean_chatbot_tools", # 백엔드 C (원두 추천·리뷰 RAG·시세 챗봇 도구)
    "app.services.operation.forecasting_tools",  # 백엔드 C
    "app.services.operation.operation_tools",    # 백엔드 C
    "app.services.operation.roastery_tools",     # 백엔드 C
    "app.services.operation.tax_tools",          # 백엔드 C
]


def get_all_tools() -> list:
    from langchain_core.tools import BaseTool

    tools: list = []
    for module_path in _TOOL_MODULES:
        try:
            module = importlib.import_module(module_path)
            module_tools = getattr(module, "TOOLS", None)
            if module_tools is None:
                # TOOLS 리스트가 없는 모듈은 안의 @tool 객체를 자동 수집 (백엔드 C 방식 호환)
                module_tools = [v for v in vars(module).values() if isinstance(v, BaseTool)]
            tools.extend(module_tools)
        except Exception:
            logger.exception("도구 모듈 로드 실패: %s — 해당 도구 없이 계속", module_path)
    return tools
