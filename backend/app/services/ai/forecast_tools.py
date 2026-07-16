"""판매량 예측 챗봇 도구 (백엔드 B) — AI-3

매장 POS 데이터 + 날씨·요일·공휴일·행사 반영 익일/금주 예측과 발주 추천.
(백엔드 C의 forecast_sales_tool은 판매 데이터를 직접 넘기는 시뮬레이션용 —
 이 도구는 DB에서 자동 조회하므로 챗봇 대화에서는 이쪽을 쓴다.)
"""

import json

from langchain_core.tools import tool

from app.services.ai import forecast_service


@tool
def forecast_sales_and_orders(store_id: str, days: int = 7, events_json: str = "") -> str:
    """매장의 판매 기록(POS)·요일 패턴·지역 날씨·공휴일을 반영해 익일과 금주(최대 14일)
    예상 판매량(잔 수·매출)을 시계열 모델로 예측하고, 레시피 기반 재료 소요량으로
    발주 추천까지 계산한다. 판매 기록이 14일 미만이면 예측 불가 안내를 돌려준다.
    events_json: 사장님이 말한 주변 행사 목록 JSON — 예:
    [{"name": "불꽃축제", "date": "2026-07-19", "boost_pct": 20}] (date 생략 시 기간 전체 적용)"""
    events = []
    if events_json.strip():
        try:
            parsed = json.loads(events_json)
            events = parsed if isinstance(parsed, list) else [parsed]
        except json.JSONDecodeError as e:
            return f"events_json 형식 오류: {e}"
    try:
        return json.dumps(
            forecast_service.forecast(store_id, days=days, events=events),
            ensure_ascii=False, default=str,
        )
    except forecast_service.ForecastError as e:
        return str(e)


TOOLS = [forecast_sales_and_orders]
