"""전체 도구 등록 (공동 소유) — 각자 import 한 줄만 알파벳순 추가

각 팀원은 자기 *_tools.py 모듈에 `TOOLS` 리스트(langchain @tool)를 만들고,
아래 _TOOL_MODULES에 모듈 경로 한 줄을 알파벳순으로 추가한다.
모듈 하나가 깨져도 나머지 도구는 정상 등록된다.
"""

import importlib
import logging

logger = logging.getLogger(__name__)

_TOOL_MODULES = [
    # "app.services.inventory_tools",              # 백엔드 A
    "app.services.ai.document_tools",              # 백엔드 B (문서 자동화 — 구현 예정)
    "app.services.ai.ocr_tools",                   # 백엔드 B
    "app.services.ai.report_tools",                # 백엔드 B (주간 리포트 — 구현 예정)
    # "app.services.operation.forecasting_tools",  # 백엔드 C
    # "app.services.operation.operation_tools",    # 백엔드 C
    # "app.services.operation.roastery_tools",     # 백엔드 C
    # "app.services.operation.tax_tools",          # 백엔드 C
]


def get_all_tools() -> list:
    tools: list = []
    for module_path in _TOOL_MODULES:
        try:
            module = importlib.import_module(module_path)
            tools.extend(getattr(module, "TOOLS", []))
        except Exception:
            logger.exception("도구 모듈 로드 실패: %s — 해당 도구 없이 계속", module_path)
    return tools
