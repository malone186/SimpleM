"""경영 리포트 챗봇 도구 (백엔드 B)

일간·주간·월간 경영 리포트 — 매출·매입·지출·인건비·재고·발주·갱신 서류를 통합 집계.
생성된 리포트 전문은 챗봇 화면에 카드로 자동 표시된다 (main_agent가 수집).
"""

import json

from langchain_core.tools import tool

from app.services.ai import report_service


def _dump(data) -> str:
    return json.dumps(data, ensure_ascii=False, default=str)


# 챗봇 화면 카드·LLM에는 보여줄 필요 없는 내부 관리용 키 (조언 캐시 무효화용)
_INTERNAL_KEYS = ("ai_advice_hash", "ai_advice_at", "ai_advice_version")


def _strip_internal(doc: dict) -> dict:
    """문서 전문에서 내부 키를 뺀 사본을 돌려준다 — 저장본은 건드리지 않는다."""
    content = doc.get("content")
    if isinstance(content, dict) and any(k in content for k in _INTERNAL_KEYS):
        doc = {**doc, "content": {k: v for k, v in content.items() if k not in _INTERNAL_KEYS}}
    return doc


@tool
def create_management_report(store_id: str, period_type: str = "weekly",
                             reference_date: str = "") -> str:
    """경영 리포트를 생성한다 — 매출(증감·베스트 메뉴), 매입, 기타 지출, 인건비 추정,
    수익 추정, 재고 경고, 진행 중 발주, 갱신 임박 서류를 한 번에 통합 집계.
    "리포트/경영 리포트/일간(주간·월간) 리포트 보여줘"는 물론, "품목별 상세 표",
    "메뉴별 매출 상세", "무엇이 얼마나 팔렸는지" 같은 요청도 이 도구로 처리한다
    (리포트에 매출순 품목별 판매 수량·금액 상세가 포함됨).
    period_type: daily(하루) / weekly(그 주 월~일) / monthly(그 달).
    reference_date: 기준일 YYYY-MM-DD — 생략하면 오늘. 예: 지난주 리포트는 지난주 아무 날짜나 넣는다."""
    try:
        return _dump(_strip_internal(report_service.generate_management_report(
            store_id, period_type=period_type, reference_date=reference_date or None)))
    except report_service.ReportError as e:
        return str(e)


@tool
def list_management_reports(store_id: str, period_type: str = "") -> str:
    """생성된 경영 리포트 목록을 조회한다. period_type(daily/weekly/monthly)으로 필터 가능,
    빈 값이면 전체. 각 리포트의 id·기간·생성일을 돌려준다."""
    docs = report_service.list_management_reports(store_id, period_type=period_type or None)
    if not docs:
        return "생성된 경영 리포트가 없습니다. create_management_report로 만들 수 있습니다."
    brief = [{"id": d["id"], "title": d["title"], "period": d["period"],
              "period_type": d["content"].get("period_type"), "created_at": d["created_at"]}
             for d in docs]
    return _dump(brief)


@tool
def get_management_report(store_id: str, doc_id: str) -> str:
    """경영 리포트 하나의 전문을 조회한다. doc_id는 list_management_reports로 확인한다."""
    from app.services.ai import document_service

    try:
        return _dump(_strip_internal(document_service.get_document(store_id, doc_id)))
    except document_service.DocumentError as e:
        return str(e)


TOOLS = [create_management_report, get_management_report, list_management_reports]
