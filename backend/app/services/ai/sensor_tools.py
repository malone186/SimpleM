"""매장 IoT 센서 챗봇 도구 (백엔드 B)

사장님이 챗봇에서 "지금 원두 얼마나 남았어?", "우유 부족해?" 같은 질문을 하면
센서 라이브 스냅샷과 발주 코치 추천을 그대로 조회해서 답할 수 있게 한다.
"""

import json

from langchain_core.tools import tool

from app.services.ai import sensor_service


@tool
def get_store_sensor_status(store_id: str) -> str:
    """매장 IoT 센서 실시간 상태 조회 — 원두 호퍼 잔량(카페인/디카페인, 무게센서),
    오늘 추출 잔 수, 소진 예상 시각, 우유 잔량, 냉장고 온도, 정수 수위, 머신 추출 상태.
    '원두 얼마나 남았어', '우유 부족해?', '기계 상태 어때' 류 질문에 사용한다."""
    try:
        return json.dumps(sensor_service.get_live_snapshot(store_id), ensure_ascii=False, default=str)
    except Exception as e:
        return f"센서 상태 조회 실패: {e}"


@tool
def get_sensor_order_coach(store_id: str) -> str:
    """센서 + 최근 7일 판매 데이터 기반 발주·운영 추천(AI 발주 코치) 조회.
    각 항목은 근거 수치와 실행 액션을 담는다. '뭘 발주해야 해?', '주말 준비 뭐 하면 돼?'
    류 질문에 사용한다. LLM 추가 호출 없이 규칙 기반으로 계산된다."""
    try:
        return json.dumps(sensor_service.get_recommendations(store_id), ensure_ascii=False, default=str)
    except Exception as e:
        return f"발주 코치 조회 실패: {e}"


TOOLS = [get_store_sensor_status, get_sensor_order_coach]
