"""푸시 알림 규칙 엔진 (백엔드 B) — 무엇을 언제 보낼지 결정한다

Tier 1 네 종류만 다룬다. 판단 기준은 "앱을 닫아둔 사이에 놓치면 손해가 나는가"다.
  1. compliance — 갱신 임박 서류 (D-30/D-7/D-1/만료). 놓치면 과태료.
  2. report     — 경영 리포트 도착. 본문에 숫자를 담아 열기 전에 이미 정보가 되게 한다.
  3. stock      — 재고 '이미 부족'이 아니라 '며칠 뒤 소진 예상'. 발주 리드타임 확보용.
  4. sensor     — 냉장고 온도 이탈 등 설비 이상. 유일하게 방해금지를 뚫는다.

발송은 push_service가 하고, 여기서는 규칙 판정 · 묶음 · 중복 방지만 한다.
중복 방지는 SentNotification의 (store_id, dedupe_key) 유니크 제약에 맡긴다 —
스케줄러가 재시도되거나 두 번 겹쳐 돌아도 같은 사건은 한 번만 나간다.
"""

import logging
from datetime import date, datetime, timedelta, timezone
from typing import Any, Optional

from app.services.ai import document_service, push_service

logger = logging.getLogger(__name__)

KST = timezone(timedelta(hours=9))

# 갱신 서류를 알릴 시점 — 이 며칠 남았을 때 딱 한 번씩 보낸다.
# 매일 보내면 무시하게 되고, 한 번만 보내면 잊는다.
# 오름차순이어야 한다 — 아래에서 '남은 일수를 담는 가장 좁은 구간'을 앞에서부터 찾는다.
COMPLIANCE_MILESTONES = [1, 7, 30]

# 재고 소진 알림 기준 — 이 일수 이내로 떨어질 품목만 (발주하고 받는 데 걸리는 시간)
STOCK_LEAD_DAYS = 3

# 설비 이상은 상황이 계속되면 다시 알려야 하지만, 매 시간 울리면 안 된다
SENSOR_COOLDOWN_HOURS = 6


# ---------------------------------------------------------------------------
# 설정 · 방해금지
# ---------------------------------------------------------------------------

def get_settings(db, store_id: str):
    """매장 알림 설정 (없으면 기본값 행을 만들어 돌려준다)."""
    from app.models.ai import NotificationSetting

    row = db.get(NotificationSetting, store_id)
    if row is None:
        row = NotificationSetting(store_id=store_id)
        db.add(row)
        db.commit()
        db.refresh(row)
    return row


def _parse_hhmm(s: str) -> Optional[int]:
    """'HH:MM' → 자정 기준 분. 형식이 틀리면 None."""
    try:
        h, m = (s or "").strip().split(":")
        h, m = int(h), int(m)
    except (ValueError, AttributeError):
        return None
    if not (0 <= h <= 23 and 0 <= m <= 59):
        return None
    return h * 60 + m


def in_dnd_window(now: datetime, start: str, end: str) -> bool:
    """방해금지 구간 판정 — 22:00~08:00처럼 자정을 넘기는 구간도 처리.

    프론트 AlertsWatcher.isInDndWindow와 같은 규칙이다. 푸시는 서버가 보내므로
    같은 판정이 서버에도 있어야 한다.
    """
    s, e = _parse_hhmm(start), _parse_hhmm(end)
    if s is None or e is None or s == e:
        return False
    cur = now.hour * 60 + now.minute
    return (s <= cur < e) if s < e else (cur >= s or cur < e)


# ---------------------------------------------------------------------------
# 발송 (중복 방지 포함)
# ---------------------------------------------------------------------------

def _already_sent(db, store_id: str, dedupe_key: str) -> bool:
    from app.models.ai import SentNotification

    return db.query(SentNotification).filter(
        SentNotification.store_id == store_id,
        SentNotification.dedupe_key == dedupe_key,
    ).first() is not None


def _dispatch(db, store_id: str, category: str, dedupe_key: str, title: str, body: str,
              data: dict[str, Any], urgent: bool = False) -> bool:
    """중복이 아니면 발송하고 이력을 남긴다. 실제로 보냈으면 True."""
    from sqlalchemy.exc import IntegrityError

    from app.models.ai import SentNotification

    if _already_sent(db, store_id, dedupe_key):
        return False

    # 이력을 '먼저' 커밋한다 — 스케줄러가 동시에 두 번 돌아도 유니크 제약에 걸려
    # 한쪽만 살아남고, 그쪽만 발송한다. 발송 후에 기록하면 그 사이에 중복이 나간다.
    row = SentNotification(store_id=store_id, dedupe_key=dedupe_key, category=category,
                           title=title, body=body)
    db.add(row)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        return False  # 다른 실행이 선점 — 그쪽이 보낸다

    payload = {"category": category, **{k: str(v) for k, v in data.items()}}
    push_service.send_to_store(db, store_id, title, body, payload, urgent=urgent)
    return True


# ---------------------------------------------------------------------------
# 규칙 1 — 갱신 임박 서류
# ---------------------------------------------------------------------------

def check_compliance(db, store_id: str, settings) -> list[str]:
    """D-30/D-7/D-1/만료 시점에 한 번씩. 놓치면 과태료라 가장 확실한 푸시 대상."""
    if not settings.compliance_alert:
        return []

    sent: list[str] = []
    for item in document_service.get_upcoming_renewals(store_id):
        days_left = item["days_left"]
        if days_left < 0:
            milestone = "expired"
            title = f"🗂 {item['name']} 만료됨"
            body = f"{item['expiry_date']}로 만료된 상태예요. 갱신 후 앱에 새 만료일을 넣어 주세요."
        else:
            # 남은 일수를 담는 '가장 좁은' 구간 하나만 (D-30 → D-7 → D-1 순으로 좁아진다).
            # 가장 넓은 구간을 고르면 D-30을 보낸 뒤 D-7·D-1이 같은 키로 묶여
            # 정작 급할 때 알림이 안 나간다. 스케줄러가 하루 쉬어 D-7을 건너뛰어도
            # 다음 실행의 D-6이 같은 구간이라 자리를 대신 채운다.
            hit = next((m for m in COMPLIANCE_MILESTONES if days_left <= m), None)
            if hit is None:
                continue
            milestone = f"D-{hit}"
            when = "오늘까지" if days_left == 0 else f"{days_left}일 남았어요"
            title = f"🗂 {item['name']} 갱신 {when}"
            body = f"{item['expiry_date']} 만료예요. 미리 예약해 두시면 마음이 편해요."

        if _dispatch(db, store_id, "compliance", f"compliance:{item['id']}:{milestone}",
                     title, body, {"screen": "Documents", "item_id": item["id"]}):
            sent.append(f"compliance:{item['name']}:{milestone}")
    return sent


# ---------------------------------------------------------------------------
# 규칙 2 — 경영 리포트 도착
# ---------------------------------------------------------------------------

def _report_body(content: dict[str, Any]) -> str:
    """푸시 본문 — 열기 전에 이미 정보가 되도록 숫자를 담는다.

    'AI 리포트가 준비됐어요' 같은 빈 껍데기는 알림을 끄게 만든다. 브루의 조언(ai_advice)
    첫 문장이 있으면 그걸 덧붙인다 — 이미 만들어 저장해 둔 문장이라 추가 비용이 없다.
    """
    sales = content.get("sales") or {}
    profit = content.get("profit") or {}
    total = sales.get("total") or 0
    change = sales.get("change_pct")

    head = f"매출 {total:,}원"
    if change is not None:
        head += f" ({'▲' if change >= 0 else '▼'}{abs(change)}%)"
    if profit.get("estimated_profit") is not None:
        p = profit["estimated_profit"]
        head += f" · {'순이익' if p >= 0 else '적자'} {abs(p):,}원"

    advice = (content.get("ai_advice") or "").strip()
    if advice:
        # 첫 문장만 — 알림은 두 줄 넘으면 잘린다
        first = advice.split(". ")[0].rstrip(".").strip()
        if first:
            return f"{head}\n{first}."
    return head


def check_report(db, store_id: str, settings, now: datetime) -> list[str]:
    """설정된 주기(매일/매주 월요일)에 맞춰 리포트를 발행하고 알린다."""
    if not settings.report_alert:
        return []

    period_type = "daily" if settings.report_frequency == "daily" else "weekly"
    if period_type == "weekly" and now.weekday() != 0:
        return []  # 주간은 월요일에만

    from app.services.ai import report_service

    try:
        # 알림보다 리포트가 먼저 있어야 한다 — 탭해서 들어갔는데 없으면 안 되므로
        # 여기서 확실히 생성/갱신한다.
        report = report_service.generate_management_report(
            store_id, period_type=period_type, force_refresh=True)
    except Exception:
        logger.exception("리포트 알림용 생성 실패 (%s, %s)", store_id, period_type)
        return []

    content = report.get("content") or {}
    period = content.get("period") or ""
    label = "오늘" if period_type == "daily" else "지난주"
    title = f"📊 {label} 경영 리포트가 나왔어요"

    if _dispatch(db, store_id, "report", f"report:{period_type}:{period}",
                 title, _report_body(content),
                 {"screen": "Dashboard", "period_type": period_type}):
        return [f"report:{period_type}:{period}"]
    return []


# ---------------------------------------------------------------------------
# 규칙 3 — 재고 소진 임박
# ---------------------------------------------------------------------------

def check_stock(db, store_id: str, settings, now: datetime) -> list[str]:
    """'이미 부족'이 아니라 '며칠 뒤 소진'을 알린다 — 그래야 발주할 시간이 남는다.

    품목별로 따로 보내지 않고 하루 한 번 묶는다. 개별 발송하면 알림을 꺼 버린다.
    """
    if not settings.stock_alert:
        return []

    from app.services.ai import forecast_service

    try:
        recs = forecast_service.forecast(store_id).get("order_recommendations") or []
    except Exception:
        logger.exception("재고 소진 예측 실패 (%s)", store_id)
        return []

    urgent_items = [
        r for r in recs
        if r.get("days_until_stockout") is not None and r["days_until_stockout"] <= STOCK_LEAD_DAYS
    ]
    if not urgent_items:
        return []

    urgent_items.sort(key=lambda r: r["days_until_stockout"])
    head = urgent_items[0]
    parts = [f"{r['ingredient']} {r['days_until_stockout']:.0f}일" for r in urgent_items[:3]]
    more = len(urgent_items) - 3

    title = f"📦 {head['ingredient']} 소진 임박"
    body = " · ".join(parts) + (f" 외 {more}종" if more > 0 else "") + " 뒤 소진 예상이에요. 오늘 발주하면 안 끊겨요."

    if _dispatch(db, store_id, "stock", f"stock:{now.date().isoformat()}",
                 title, body, {"screen": "Order"}):
        return [f"stock:{len(urgent_items)}종"]
    return []


# ---------------------------------------------------------------------------
# 규칙 4 — 설비 이상 (유일하게 방해금지를 뚫는다)
# ---------------------------------------------------------------------------

def check_sensor(db, store_id: str, settings, now: datetime) -> list[str]:
    """냉장고 온도 이탈 등 urgent 항목. 식자재 폐기로 직결돼 밤에도 알려야 한다."""
    if not settings.sensor_alert:
        return []

    from app.services.ai import sensor_service

    try:
        if not sensor_service.is_feature_enabled(store_id):
            return []
        items = sensor_service.get_recommendations(store_id).get("items") or []
    except Exception:
        logger.exception("센서 상태 조회 실패 (%s)", store_id)
        return []

    # 설비 이상만 — 호퍼 재장전 같은 urgent는 영업 중 화면에서 보면 되는 일이라 제외한다
    faults = [i for i in items if i.get("priority") == "urgent" and i.get("source") in ("온도센서", "수위센서")]
    if not faults:
        return []

    # 상황이 계속되면 다시 알리되 쿨다운을 둔다 (매 실행마다 울리지 않게)
    bucket = now.replace(minute=0, second=0, microsecond=0)
    bucket = bucket - timedelta(hours=bucket.hour % SENSOR_COOLDOWN_HOURS)

    sent: list[str] = []
    for fault in faults[:2]:
        key = f"sensor:{fault['source']}:{bucket.isoformat()}"
        if _dispatch(db, store_id, "sensor", key, f"🚨 {fault['title']}",
                     f"{fault['reason']} {fault['action']}",
                     {"screen": "Dashboard"}, urgent=True):
            sent.append(key)
    return sent


# ---------------------------------------------------------------------------
# 실행 진입점 — 스케줄러(Cloud Scheduler 등)가 부른다
# ---------------------------------------------------------------------------

def run_for_store(db, store_id: str, now: Optional[datetime] = None) -> dict[str, Any]:
    """한 매장의 Tier 1 규칙을 모두 평가하고 발송한다."""
    now = now or datetime.now(KST)
    settings = get_settings(db, store_id)
    if not settings.push_enabled:
        return {"store_id": store_id, "skipped": "push_disabled", "sent": []}

    sent: list[str] = []

    # 설비 이상은 방해금지와 무관하게 먼저 본다 — 뚫고 나가야 하는 유일한 종류
    sent += check_sensor(db, store_id, settings, now)

    # 나머지는 방해금지 구간이면 '이력을 남기지 않고' 건너뛴다 →
    # 구간이 끝난 뒤 첫 실행에서 밀린 알림이 그대로 나간다 (프론트와 같은 동작)
    if settings.dnd_enabled and in_dnd_window(now, settings.dnd_start, settings.dnd_end):
        return {"store_id": store_id, "skipped": "dnd", "sent": sent}

    sent += check_compliance(db, store_id, settings)
    sent += check_report(db, store_id, settings, now)
    sent += check_stock(db, store_id, settings, now)
    return {"store_id": store_id, "sent": sent}


def run_all(now: Optional[datetime] = None) -> dict[str, Any]:
    """푸시 토큰이 등록된 모든 매장을 순회한다.

    토큰이 없는 매장은 건너뛴다 — 보낼 곳이 없는데 예측·리포트 생성 비용을 치를 이유가 없다.
    한 매장이 실패해도 나머지는 계속 돈다.
    """
    from app.models.ai import DeviceToken

    now = now or datetime.now(KST)
    with document_service._session() as db:
        store_ids = [r[0] for r in db.query(DeviceToken.store_id).distinct().all()]

        results = []
        for store_id in store_ids:
            try:
                results.append(run_for_store(db, store_id, now))
            except Exception:
                logger.exception("알림 실행 실패 (%s)", store_id)
                results.append({"store_id": store_id, "error": True, "sent": []})

    total = sum(len(r.get("sent", [])) for r in results)
    logger.info("푸시 알림 실행 완료 — 매장 %d곳, 발송 %d건", len(results), total)
    return {"ran_at": now.isoformat(), "stores": len(results), "sent_total": total, "results": results}
