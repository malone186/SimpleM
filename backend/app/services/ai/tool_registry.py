"""전체 도구 등록 (공동 소유) — 각자 모듈 경로 한 줄만 알파벳순 추가

각 팀원은 자기 *_tools.py 모듈 경로를 _TOOL_MODULES에 알파벳순으로 한 줄 추가한다.
모듈에 TOOLS 리스트가 있으면 그것을 쓰고, 없으면 모듈 안의 @tool 객체를 자동 수집한다.
모듈 하나가 깨져도 나머지 도구는 정상 등록된다.
"""

import importlib
import logging

logger = logging.getLogger(__name__)

_TOOL_MODULES = [
    # "app.services.inventory_tools",            # 백엔드 A (구현 시 주석 해제)
    "app.services.ai.document_tools",            # 백엔드 B (문서 자동화 — 구현 예정)
    "app.services.ai.ocr_tools",                 # 백엔드 B
    "app.services.ai.price_tools",               # 백엔드 B (인터넷 가격 비교)
    "app.services.ai.report_tools",              # 백엔드 B (경영 리포트 — 일간·주간·월간)
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
