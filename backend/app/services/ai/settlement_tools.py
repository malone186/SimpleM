"""카드 정산 챗봇 도구 (백엔드 B) — "카드 대금 언제 얼마 들어와?"에 답한다

사장님이 가장 자주 하는 돈 질문이 "이번 주에 얼마 들어와?"인데, 카드사마다 입금일이
달라 직접 세기 번거롭다. 매출 입력만 되어 있으면 브루가 바로 계산해 준다.

매출 기록(save_day)은 사장님이 말한 금액을 그대로 장부에 남기는 행위라 draft_ 없이
바로 저장한다 — 돈이 나가는 액션(발주·지급)이 아니라 사실 기록이기 때문이다.
store_id는 main_agent의 _bind_store가 로그인 사용자 값으로 강제로 덮어쓴다.
"""

import json
from datetime import date

from langchain_core.tools import tool

from app.services.ai import settlement_service
from app.utils.datetime_kst import today_kst


def _dump(data) -> str:
    return json.dumps(data, ensure_ascii=False, default=str)


@tool
def get_card_deposits(store_id: str, ahead_days: int = 21) -> str:
    """앞으로 통장에 들어올 카드 대금을 날짜별로 알려준다. '카드 언제 들어와?',
    '이번 주에 얼마 들어와?', '입금 예정 알려줘'처럼 물을 때 쓴다.
    날짜별 실입금액(net)과 그 안에 섞인 카드사, 떼인 수수료를 함께 준다.
    금액은 매장 수수료율 설정과 카드사별 입금 소요일을 적용한 예상치다."""
    return _dump(settlement_service.upcoming_deposits(store_id, ahead_days=ahead_days))


@tool
def get_day_sales(store_id: str, target_date: str = "") -> str:
    """특정 날짜의 현금·카드 매출 입력 내용과 그날 카드 수수료·입금 예정일을 조회한다.
    '어제 얼마 팔았지?', '오늘 카드 얼마야?'처럼 물을 때 쓴다.
    target_date는 YYYY-MM-DD, 비우면 오늘이다."""
    return _dump(settlement_service.get_day(store_id, target_date or today_kst().isoformat()))


@tool
def record_day_sales(store_id: str, cash: int = 0, card: int = 0,
                     target_date: str = "", cups: int = 0) -> str:
    """하루치 매출을 장부에 기록한다. 사장님이 '오늘 현금 12만원 카드 45만원 팔았어'처럼
    말하면 쓴다. 그 날짜의 기존 입력은 덮어쓴다(수정 = 재입력).
    카드사를 나눠 말하지 않았으면 card에 총액을 넣는다 — 입금일은 보수적으로 계산된다.
    cups(잔 수)는 사장님이 말했을 때만 넣고, 아니면 0으로 둔다.
    저장 후 그날의 수수료와 입금 예정일을 돌려주므로 그대로 알려 주면 된다."""
    target = target_date or today_kst().isoformat()
    cards = [{"issuer": "unknown", "amount": int(card), "card_type": "credit"}] if card > 0 else []
    try:
        return _dump(settlement_service.save_day(
            store_id, target, cash=int(cash),
            cash_cups=int(cups) if cups else None, cards=cards))
    except settlement_service.SettlementError as e:
        return str(e)


@tool
def get_sales_summary(store_id: str, days: int = 28) -> str:
    """최근 기간의 매출 요약을 준다 — 현금/카드 비중, 카드사별 비중, 카드 수수료 총액,
    그리고 오늘이 '지난주 같은 요일'보다 얼마나 늘었는지(줄었는지).
    '요즘 장사 어때?', '지난주보다 나아졌어?', '수수료 얼마나 나가?'에 쓴다.
    어제 대비가 아니라 지난주 같은 요일과 비교한다 — 요일마다 손님 수가 다르기 때문이다."""
    return _dump(settlement_service.period_summary(store_id, days=days))


TOOLS = [get_card_deposits, get_day_sales, record_day_sales, get_sales_summary]
