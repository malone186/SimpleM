"""전체 도구 등록 (공동 소유) — 각자 import 한 줄만 알파벳순 추가"""

# 1. 알파벳순 도구 임포트 추가
from app.services.operation.forecasting_tools import forecast_sales_tool, get_forecast_rag_documents_tool
from app.services.operation.operation_tools import get_operation_summary_tool, get_report_source_tool
from app.services.operation.roastery_tools import get_roastery_beans_price_tool
from app.services.operation.tax_tools import estimate_tax_tool, get_tax_rag_documents_tool

# 2. 챗봇이 이용할 최종 연동 도구 리스트 (알파벳순 유지)
tools = [
    estimate_tax_tool,
    forecast_sales_tool,
    get_forecast_rag_documents_tool,
    get_operation_summary_tool,
    get_report_source_tool,
    get_roastery_beans_price_tool,
    get_tax_rag_documents_tool
]
