"""단골 회원 · 선불 충전 챗봇 도구 (백엔드 B)

[한글 주석] 여기엔 로직을 두지 않는다. membership_service를 부르고
JSON으로 감싸기만 하는 얇은 껍데기다 (팀 원칙).

[중요] 충전·차감·보정은 도구로 열지 않았다.
팀 체크리스트의 "돈이 걸린 액션은 초안만 반환한다" 원칙 때문이다.
챗봇이 말귀를 잘못 알아듣고 "김OO님 5만원 충전"을 실행해버리면
손님 돈이 걸린 사고가 된다. 잔액 변경은 사장님이 화면에서 직접 누른다.
이 도구들은 전부 조회 전용이다.
"""
import logging
from typing import Any, Dict, Optional

try:
    from langchain.tools import tool
except ImportError:
    try:
        from langchain_core.tools import tool
    except ImportError:
        def tool(func):
            return func

from app.core.database import SessionLocal
from app.services import membership_service as svc

logger = logging.getLogger(__name__)


def _fail(msg: str) -> Dict[str, Any]:
    return {"success": False, "data": {}, "documents": [], "message": msg}


def _visit_stats_bulk(db, customer_ids: list) -> Dict[int, Dict[str, Any]]:
    """여러 회원의 방문 통계를 쿼리 1번으로 — svc.visit_stats와 같은 규칙.

    회원 검색이 최대 10명을 돌려주는데 한 명마다 visit_stats(쿼리 1번)를 부르면
    챗봇 턴에 Neon 왕복이 10번(약 2초) 더 붙는다. 날짜 목록을 GROUP 없이 한 번에
    받아 파이썬에서 같은 계산(같은 날 여러 잔=1회, 중앙값 주기)을 한다.
    """
    import statistics

    from sqlalchemy import func as sa_func

    from app.models.membership import BalanceTransaction

    if not customer_ids:
        return {}
    # created_at은 timestamptz라 그냥 date()로 자르면 세션 기본 시간대(UTC) 기준이 된다.
    # 그러면 오늘 아침 KST 07:30 결제가 어제 22:30(UTC)로 잘려 '어제 온 손님'이 되고,
    # 아래에서 KST 오늘(svc._now())과 빼기 때문에 방문 간격·이탈 판정까지 흔들린다.
    # 카페 오픈 러시(00:00~09:00 KST)가 정확히 이 구간이다.
    # SQLite에는 timezone()이 없으므로 그때는 파이썬에서 KST로 옮긴다.
    is_pg = db.bind.dialect.name == "postgresql"
    day_col = (sa_func.date(sa_func.timezone("Asia/Seoul", BalanceTransaction.created_at))
               if is_pg else BalanceTransaction.created_at)
    rows = (
        db.query(BalanceTransaction.customer_id, day_col)
        .filter(BalanceTransaction.customer_id.in_(customer_ids),
                BalanceTransaction.tx_type == svc.TX_USE)
        .distinct()
        .all()
    )
    if not is_pg:
        # 원본 시각을 그대로 받았으므로 KST로 옮겨 날짜로 자르고, 같은 날 중복을 없앤다
        # (Postgres 경로의 date() + distinct와 결과를 맞춘다).
        from app.utils.datetime_kst import to_kst

        rows = sorted({(cid, to_kst(v).date()) for cid, v in rows if v is not None})
    dates_by_id: Dict[int, list] = {}
    for cid, d in rows:
        if d is None:
            continue
        iso = d.isoformat() if hasattr(d, "isoformat") else str(d)[:10]
        dates_by_id.setdefault(cid, []).append(iso)

    from datetime import date as _date

    today = svc._now().date()
    out: Dict[int, Dict[str, Any]] = {}
    for cid, isos in dates_by_id.items():
        isos.sort()
        ds = [_date.fromisoformat(s) for s in isos]
        intervals = [(ds[i] - ds[i - 1]).days for i in range(1, len(ds))
                     if (ds[i] - ds[i - 1]).days > 0]
        out[cid] = {
            "visit_count": len(ds),
            "days_since_visit": (today - ds[-1]).days,
            "median_interval_days": round(statistics.median(intervals), 1)
            if len(intervals) >= 2 else None,
        }
    return out


@tool
def get_churn_risk_customers_tool(store_id: str, limit: int = 10) -> Dict[str, Any]:
    """[한글 주석] 평소보다 오랫동안 안 오신 단골 손님 목록을 조회합니다.
    '요즘 안 오는 단골 있어?', '뜸해진 손님 알려줘' 같은 질문에 사용합니다.
    - store_id: 매장 식별자 (사장님 이메일)
    - limit: 조회 개수 (기본 10)
    """
    db = SessionLocal()
    try:
        rows = svc.find_churn_risk(db, store_id, limit=limit)
        items = [
            {
                "name": r["name"] or r["phone_masked"],
                "phone_masked": r["phone_masked"],
                "balance": f"{r['balance']:,}원",
                "visit_count": f"{r['visit_count']}회",
                "usual_interval": f"{r['median_interval_days']}일마다",
                "days_since_visit": f"{r['days_since_visit']}일째 안 옴",
                "overdue": f"평소의 {r['overdue_ratio']}배",
            }
            for r in rows
        ]
        return {
            "success": True,
            "data": {
                "count": len(items),
                "customers": items,
                "note": (
                    "각 손님의 평소 방문 주기(중앙값) 대비 2배 이상 지난 경우입니다. "
                    "잔액이 남은 분을 먼저 보여드립니다 — 연락할 명분이 되기 때문입니다."
                ),
            },
            "documents": [],
            "message": (
                f"평소보다 뜸해진 단골 {len(items)}명을 찾았습니다."
                if items else "아직 뜸해진 단골이 없습니다. (판단하려면 방문 3회 이상 이력이 필요합니다)"
            ),
        }
    except Exception as e:
        logger.error("get_churn_risk_customers_tool 오류: %s", str(e))
        return _fail(f"단골 조회 중 오류: {str(e)}")
    finally:
        db.close()


@tool
def get_prepaid_summary_tool(store_id: str, days: int = 30) -> Dict[str, Any]:
    """[한글 주석] 선불 충전 현황을 조회합니다. 충전액과 매출을 분리해서 보여줍니다.
    '충전 얼마나 됐어?', '선불 잔액 얼마 남았어?' 같은 질문에 사용합니다.
    - store_id: 매장 식별자 (사장님 이메일)
    - days: 조회 기간 (기본 30일)
    """
    db = SessionLocal()
    try:
        s = svc.get_prepaid_summary(db, store_id, days)
        return {
            "success": True,
            "data": {
                "customer_count": f"{s['customer_count']}명",
                "cash_in": f"{s['charged_total']:,}원",
                "credited": f"{s['credited_total']:,}원",
                "bonus_given": f"{s['bonus_given']:,}원",
                "revenue_recognized": f"{s['used_total']:,}원",
                "outstanding_liability": f"{s['active_balance_total']:,}원",
                "period": f"최근 {s['period_days']}일",
                "important_note": (
                    "충전액은 매출이 아닙니다. 아직 커피를 드리지 않았으므로 부채(선수금)이고, "
                    "커피가 나갈 때 매출로 잡힙니다. "
                    f"현재 갚아야 할 잔액은 {s['active_balance_total']:,}원입니다."
                ),
            },
            "documents": [],
            "message": f"최근 {days}일 선불 충전 현황입니다.",
        }
    except Exception as e:
        logger.error("get_prepaid_summary_tool 오류: %s", str(e))
        return _fail(f"충전 현황 조회 중 오류: {str(e)}")
    finally:
        db.close()


@tool
def find_customer_tool(store_id: str, query: Optional[str] = None) -> Dict[str, Any]:
    """[한글 주석] 단골 회원을 이름이나 전화번호 뒷자리로 검색해 잔액과 방문 이력을 봅니다.
    '김OO님 잔액 얼마야?', '7104 손님 정보' 같은 질문에 사용합니다.
    - store_id: 매장 식별자 (사장님 이메일)
    - query: 이름 또는 전화번호 뒷 4자리
    """
    db = SessionLocal()
    try:
        rows = svc.find_customers(db, store_id, query, limit=10)
        stats_by_id = _visit_stats_bulk(db, [c.id for c in rows])
        items = []
        for c in rows:
            st = stats_by_id.get(c.id) or {
                "visit_count": 0, "days_since_visit": None, "median_interval_days": None}
            items.append({
                "name": c.name or svc.mask_phone(c.phone),
                "phone_masked": svc.mask_phone(c.phone),
                "balance": f"{c.balance or 0:,}원",
                "visit_count": f"{st['visit_count']}회",
                "days_since_visit": (
                    f"{st['days_since_visit']}일 전" if st["days_since_visit"] is not None
                    else "방문 이력 없음"
                ),
                "usual_interval": (
                    f"{st['median_interval_days']}일마다"
                    if st["median_interval_days"] else "주기 계산 전 (3회 이상 필요)"
                ),
                "memo": c.memo,
            })
        return {
            "success": True,
            "data": {"count": len(items), "customers": items},
            "documents": [],
            "message": (
                f"회원 {len(items)}명을 찾았습니다."
                if items else f"'{query or ''}'에 해당하는 회원이 없습니다."
            ),
        }
    except Exception as e:
        logger.error("find_customer_tool 오류: %s", str(e))
        return _fail(f"회원 조회 중 오류: {str(e)}")
    finally:
        db.close()
