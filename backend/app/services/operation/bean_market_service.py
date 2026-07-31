"""원두 시세 분석 서비스 — 시세 포지션(횡단면) + 가격 이력(시계열)

[한글 주석] 왜 두 가지로 나뉘는가:

  1) 시세 포지션 (오늘 바로 가능)
     "이 원두, 비싼 거야?"는 과거가 없어도 답할 수 있다.
     같은 원산지의 다른 원두들과 g당 단가를 비교하면 되기 때문이다.
     599개 데이터가 이미 있으므로 즉시 계산된다.

  2) 가격 추이 (시간이 필요)
     "가격이 오르는 중인가?"는 과거 값이 있어야 한다.
     그런데 ProductOffer는 가격을 덮어써서 이력이 남지 않는다.
     그래서 snapshot_prices()로 매일 append해 두어야 하고,
     원두 가격은 월 단위로 느리게 움직이므로 최소 1~2주는 쌓여야 의미가 생긴다.

용량이 제각각(200g/500g)이라 절대가격은 비교 대상이 아니다.
모든 비교는 g당 단가(price_per_gram)로 정규화해서 수행한다.
"""
from datetime import datetime, timedelta
from statistics import mean, median
from typing import Any, Dict, List, Optional

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.roastery import BeanPriceHistory, ProductOffer, RoasteryBean

# 그룹 통계를 신뢰하려면 최소 이만큼의 표본이 필요하다.
# (원두 2개짜리 원산지의 '평균'은 평균이라 부를 수 없다)
MIN_GROUP_SIZE = 5


# ═══════════════════════════════════════════════════
# [한글 주석] 1. 시세 포지션 — 오늘 바로 계산되는 횡단면 비교
# ═══════════════════════════════════════════════════

def _percentile_rank(values: List[float], target: float) -> int:
    """target이 values 안에서 하위 몇 %에 위치하는지 (0~100).

    가격이므로 낮을수록 좋다 → 반환값이 작을수록 '싼 편'이다.
    """
    if not values:
        return 50
    cheaper = sum(1 for v in values if v < target)
    return round(cheaper / len(values) * 100)


def get_market_summary(db: Session) -> Dict[str, Any]:
    """원산지별 / 가공방식별 g당 단가 시세표를 만든다.

    화면은 이 통계 하나만 받아두면, 각 원두의 g당 단가와 비교해
    "시세보다 6% 저렴" 같은 판단을 즉시 내릴 수 있다.
    (원두마다 API를 부르지 않아도 되도록 그룹 통계만 반환한다)
    """
    rows = (
        db.query(
            RoasteryBean.country,
            RoasteryBean.process,
            RoasteryBean.price_per_gram,
        )
        .filter(RoasteryBean.price_per_gram.isnot(None))
        .filter(RoasteryBean.price_per_gram > 0)
        .all()
    )

    all_ppg = [r.price_per_gram for r in rows]

    def _stats(values: List[float]) -> Dict[str, Any]:
        vs = sorted(values)
        return {
            "count": len(vs),
            "avg": round(mean(vs), 1),
            "median": round(median(vs), 1),
            "min": round(vs[0], 1),
            "max": round(vs[-1], 1),
        }

    # ── 원산지별 ──
    by_country: Dict[str, List[float]] = {}
    for r in rows:
        key = (r.country or "").strip() or "미상"
        by_country.setdefault(key, []).append(r.price_per_gram)

    # ── 가공방식별 ──
    by_process: Dict[str, List[float]] = {}
    for r in rows:
        key = (r.process or "").strip()
        if not key:
            continue  # 가공방식은 결측이 많아 '미상' 그룹을 만들지 않는다
        by_process.setdefault(key, []).append(r.price_per_gram)

    return {
        "overall": _stats(all_ppg) if all_ppg else None,
        # 표본이 너무 적은 그룹은 통계로 쓰지 않는다 (오해 방지)
        "by_country": {
            k: _stats(v) for k, v in sorted(by_country.items()) if len(v) >= MIN_GROUP_SIZE
        },
        "by_process": {
            k: _stats(v) for k, v in sorted(by_process.items()) if len(v) >= MIN_GROUP_SIZE
        },
        "min_group_size": MIN_GROUP_SIZE,
        "generated_at": datetime.now(),
    }


def get_market_position(db: Session, bean_id: int) -> Optional[Dict[str, Any]]:
    """특정 원두가 같은 원산지 그룹에서 어느 가격대인지 판정한다.

    반환 예)
      {"peer_group": "에티오피아", "peer_count": 210,
       "price_per_gram": 49.0, "peer_avg": 52.3,
       "diff_pct": -6.3, "percentile": 30, "verdict": "저렴"}
    """
    bean = db.query(RoasteryBean).filter(RoasteryBean.id == bean_id).first()
    if not bean or not bean.price_per_gram:
        return None

    country = (bean.country or "").strip()
    peers = (
        db.query(RoasteryBean.price_per_gram)
        .filter(RoasteryBean.price_per_gram.isnot(None))
        .filter(RoasteryBean.price_per_gram > 0)
    )
    # 같은 원산지끼리 비교하는 게 기본. 표본이 부족하면 전체와 비교한다.
    peer_group = country or "전체"
    if country:
        same = peers.filter(RoasteryBean.country == country).all()
        if len(same) < MIN_GROUP_SIZE:
            same = peers.all()
            peer_group = "전체"
    else:
        same = peers.all()

    values = [r.price_per_gram for r in same]
    if not values:
        return None

    avg = mean(values)
    med = median(values)
    ppg = bean.price_per_gram

    # [한글 주석] 비교 기준은 평균이 아니라 '중앙값'을 쓴다.
    # 이 데이터에는 g당 2,000원대(200g에 40만원) 같은 극단값이 섞여 있어
    # 평균이 중앙값보다 40% 이상 부풀어 있다. 평균으로 판정하면 평범한 원두도
    # 전부 "저렴"으로 나온다. 중앙값은 이런 이상치에 흔들리지 않는다.
    basis = med if med else avg
    diff_pct = round((ppg - basis) / basis * 100, 1) if basis else 0.0
    pct = _percentile_rank(values, ppg)

    # 5% 이내는 '시세 수준'으로 본다 (미세한 차이를 과장하지 않기 위해)
    if diff_pct <= -5:
        verdict = "저렴"
    elif diff_pct >= 5:
        verdict = "비쌈"
    else:
        verdict = "시세 수준"

    return {
        "bean_id": bean.id,
        "peer_group": peer_group,
        "peer_count": len(values),
        "price_per_gram": round(ppg, 1),
        "peer_avg": round(avg, 1),
        "peer_median": round(med, 1),
        "compare_basis": "median",  # 화면이 무엇과 비교한 값인지 알 수 있게
        "diff_pct": diff_pct,
        "percentile": pct,  # 낮을수록 싼 편
        "verdict": verdict,
    }


# ═══════════════════════════════════════════════════
# [한글 주석] 2. 가격 이력 — 오늘부터 쌓아야 추이가 생긴다
# ═══════════════════════════════════════════════════

def snapshot_prices(db: Session, force: bool = False) -> Dict[str, Any]:
    """모든 원두의 현재 가격을 이력 테이블에 1회 기록한다 (하루 1회 호출 상정).

    같은 날 이미 기록했으면 건너뛴다(멱등) — 스케줄러가 중복 실행돼도 안전하다.
    force=True면 중복 검사를 무시하고 기록한다.
    """
    today_start = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)

    if not force:
        already = (
            db.query(func.count(BeanPriceHistory.id))
            .filter(BeanPriceHistory.recorded_at >= today_start)
            .scalar()
        )
        if already and already > 0:
            return {"recorded": 0, "skipped": True, "message": f"오늘 이미 {already}건 기록되어 있습니다."}

    beans = db.query(RoasteryBean).all()

    # 원두별 최저가 오퍼를 한 번에 모아둔다 (N+1 방지)
    offers = db.query(ProductOffer).all()
    lowest_by_bean: Dict[int, ProductOffer] = {}
    for o in offers:
        cur = lowest_by_bean.get(o.bean_id)
        if cur is None or (o.price or 0) < (cur.price or 0):
            lowest_by_bean[o.bean_id] = o

    recorded = 0
    for b in beans:
        offer = lowest_by_bean.get(b.id)
        price = (offer.price if offer and offer.price else b.price) or 0
        if price <= 0:
            continue  # 가격 없는 원두는 추이 대상이 아니다
        db.add(
            BeanPriceHistory(
                bean_id=b.id,
                price=price,
                price_per_gram=b.price_per_gram,
                source_site=(offer.source_site if offer else None),
                sold_out=bool(b.sold_out),
            )
        )
        recorded += 1

    db.commit()
    return {"recorded": recorded, "skipped": False, "message": f"원두 {recorded}건의 가격을 기록했습니다."}


def get_price_trend(db: Session, bean_id: int, days: int = 30) -> Dict[str, Any]:
    """특정 원두의 가격 추이를 반환한다.

    [한글 주석] 이력이 쌓이기 전에는 points가 0~1개다.
    그 상태를 '데이터 없음'으로 정직하게 알려주어야,
    화면이 한 점짜리 그래프를 추이처럼 그리는 일을 막을 수 있다.
    """
    since = datetime.now() - timedelta(days=days)
    rows = (
        db.query(BeanPriceHistory)
        .filter(BeanPriceHistory.bean_id == bean_id)
        .filter(BeanPriceHistory.recorded_at >= since)
        .order_by(BeanPriceHistory.recorded_at.asc())
        .all()
    )

    points = [
        {
            "recorded_at": r.recorded_at,
            "price": r.price,
            "price_per_gram": r.price_per_gram,
            "sold_out": r.sold_out,
        }
        for r in rows
    ]

    # 추이라고 부르려면 최소 2점이 필요하다
    ready = len(points) >= 2
    change_pct = None
    if ready:
        first, last = points[0]["price"], points[-1]["price"]
        if first:
            change_pct = round((last - first) / first * 100, 1)

    return {
        "bean_id": bean_id,
        "days": days,
        "points": points,
        "ready": ready,
        "change_pct": change_pct,
        "message": (
            None if ready else "가격 이력이 아직 부족합니다. 매일 기록이 쌓이면 추이가 표시됩니다."
        ),
    }
