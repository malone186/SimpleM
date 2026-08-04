"""매장 데이터 통합 조회 챗봇 도구 (백엔드 B)

로직은 store_data_service에 있고 이 파일은 @tool 래퍼만 둔다.
전부 읽기 전용이라 챗봇이 마음껏 호출해도 데이터가 바뀌지 않는다.

store_id는 main_agent._bind_store가 로그인 사용자 값으로 강제 덮어쓴다.
"""

import json

from langchain_core.tools import tool

from app.services.ai import store_data_service


def _dump(data) -> str:
    return json.dumps(data, ensure_ascii=False, default=str)


@tool
def get_store_profile(store_id: str) -> str:
    """내 매장의 기본 정보를 조회한다 — 상호명, 사장님 이름, 연락처, 가입일,
    그리고 현재 등록된 재료·활성 메뉴·직원 수. 매장이 어떤 곳인지 파악할 때 먼저 쓴다."""
    return _dump(store_data_service.get_store_profile(store_id))


@tool
def get_sales_history(store_id: str, days: int = 14,
                      start_date: str = "", end_date: str = "") -> str:
    """실제 판매 원장을 조회한다 — 일별 매출액·판매 잔 수와 메뉴별 매출 순위.
    '지난주 매출', '어제 얼마 팔았어', '요즘 뭐가 제일 잘나가' 같은 질문에 쓴다.
    예측이 아니라 이미 일어난 실적이다.

    특정 날짜·기간을 물으면 days로 며칠 전인지 역산하지 말고 start_date/end_date에
    날짜(YYYY-MM-DD)를 그대로 넣어라. 어제 하루면 둘 다 어제 날짜를 넣는다.
    days는 '오늘부터 거슬러 N일'이라 days=1은 오늘 하루뿐이다 — 어제를 보려고
    days=1을 넣으면 오늘 치만 조회돼 '판매 없음'으로 오해하게 된다.
    응답의 start_date·end_date가 실제로 조회된 구간이니 그 기간을 밝혀 보고해라."""
    return _dump(store_data_service.get_sales_history(
        store_id, days=days, start_date=start_date, end_date=end_date))


@tool
def get_stock_movements(store_id: str, days: int = 7, ingredient_name: str = "") -> str:
    """재고 입출고 이력을 조회한다 — 언제 어떤 재료가 얼마나 들어오고(IN) 나갔는지(OUT),
    수동 조정(ADJUST)까지. ingredient_name을 주면 그 재료만 본다.
    '우유 언제 들어왔어', '재고가 왜 줄었지' 같은 질문에 쓴다."""
    return _dump(
        store_data_service.get_stock_movements(store_id, days=days, ingredient_name=ingredient_name)
    )


@tool
def get_price_trend(store_id: str, ingredient_name: str = "", days: int = 90) -> str:
    """재료 매입 단가의 변동 이력을 조회한다 — 재료별 최초·최신 단가와 변동률(%),
    변동 시점 목록. 인상률이 큰 재료부터 정렬된다.
    '요즘 뭐가 많이 올랐어', '원두 단가 추이' 같은 질문에 쓴다."""
    return _dump(
        store_data_service.get_price_trend(store_id, ingredient_name=ingredient_name, days=days)
    )


@tool
def get_purchase_orders(store_id: str, limit: int = 10, status: str = "") -> str:
    """발주 이력을 조회한다 — 발주 건별 상태(DRAFT 초안 / PENDING 승인대기 /
    CONFIRMED 발주완료), 총액, 품목 상세. status로 특정 상태만 걸러 볼 수 있다.
    '발주 넣은 거 어떻게 됐어', '아직 안 보낸 발주 있어' 같은 질문에 쓴다."""
    return _dump(store_data_service.get_purchase_orders(store_id, limit=limit, status=status))


@tool
def get_expenses(store_id: str, days: int = 30) -> str:
    """지출 내역을 조회한다 — 최근 N일(기본 30일)의 카테고리별 합계와 건별 목록.
    '이번 달 돈 어디에 썼어', '소모품비 얼마야' 같은 질문에 쓴다."""
    return _dump(store_data_service.get_expenses(store_id, days=days))


@tool
def get_staff_roster(store_id: str) -> str:
    """직원 명단을 조회한다 — 이름, 직책, 시급, 그리고 각자 신청한 기피/불가 시간
    (hard=배정 금지, soft=가급적 회피). '알바 누구 있어', '시급 얼마야',
    '누가 언제 못 나와' 같은 질문에 쓴다."""
    return _dump(store_data_service.get_staff_roster(store_id))


@tool
def get_work_schedules(store_id: str, start_date: str = "", end_date: str = "") -> str:
    """근무 스케줄을 조회한다 — 기간 내 직원별 배정 시간, 실제 출퇴근 기록, 완료 여부와
    직원별 총 근무시간 합계. 날짜를 비우면 이번 주(월~일)를 본다. 날짜는 YYYY-MM-DD.
    '이번 주 누가 나와', '지난주 몇 시간 일했어' 같은 질문에 쓴다."""
    return _dump(
        store_data_service.get_work_schedules(store_id, start_date=start_date, end_date=end_date)
    )


@tool
def get_payroll_history(store_id: str, limit: int = 20) -> str:
    """지금까지 계산된 급여 이력을 조회한다 — 직원별 정산 기간, 총 근무시간, 예상 급여액.
    '지난달 인건비 얼마 나갔어', '김철수 급여 계산한 적 있어' 같은 질문에 쓴다."""
    return _dump(store_data_service.get_payroll_history(store_id, limit=limit))


@tool
def get_notices_and_inquiries(store_id: str, limit: int = 10) -> str:
    """관리자 공지사항과 내가 남긴 1:1 문의의 답변 상태를 조회한다.
    '공지 뭐 왔어', '내 문의 답변 왔어?' 같은 질문에 쓴다."""
    return _dump(store_data_service.get_notices_and_inquiries(store_id, limit=limit))


TOOLS = [
    get_store_profile,
    get_sales_history,
    get_stock_movements,
    get_price_trend,
    get_purchase_orders,
    get_expenses,
    get_staff_roster,
    get_work_schedules,
    get_payroll_history,
    get_notices_and_inquiries,
]
