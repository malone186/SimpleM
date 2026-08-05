"""푸시 알림 규칙 엔진 (백엔드 B) — 무엇을 언제 보낼지 결정한다

판단 기준은 "앱을 닫아둔 사이에 놓치면 손해가 나는가"다.
  1. compliance — 갱신 임박 서류 (D-30/D-7/D-1/만료). 놓치면 과태료.
  2. report     — 경영 리포트 도착. 본문에 숫자를 담아 열기 전에 이미 정보가 되게 한다.
  3. stock      — 재고 '이미 부족'이 아니라 '며칠 뒤 소진 예상'. 발주 리드타임 확보용.
  4. sensor     — 냉장고 온도 이탈 등 설비 이상. 유일하게 방해금지를 뚫는다.
  5. report     — 마감 리포트. 하루를 닫는 습관을 만든다.
  6. stock      — 원두 시세 하락. 지금이 사 둘 때인지 알려준다.
  7~8. nearby   — 주변 상권 변화. 곧 열리는 행사(무엇을 준비할지 AI 플랜 포함)와
                  경쟁 카페 개업·폐업. 화면을 안 열면 영영 모르고 지나가는 정보다.
  9. briefing   — 아침 브리핑. 오픈 시각에 어제 실적과 오늘 급한 일을 한 장으로.
  10. insight   — 위 규칙이 담당하지 않는 나머지 영역(정산 미입력·뜸해진 단골·POS 연동
                  끊김·팔수록 손해인 메뉴 등)의 '지금 조치' 건. 발동 조건은 전부
                  insight_service에 있고 여기서는 무엇을 언제 내보낼지만 정한다.

새 알림을 붙일 때는 규칙 함수를 늘리기 전에 insight_service에 스캐너를 먼저 넣는다 —
그래야 같은 근거가 알림·홈 할 일·챗봇·아침 브리핑에 동시에 반영된다.

발송은 push_service가 하고, 여기서는 규칙 판정 · 묶음 · 중복 방지만 한다.
중복 방지는 SentNotification의 (store_id, dedupe_key) 유니크 제약에 맡긴다 —
스케줄러가 재시도되거나 두 번 겹쳐 돌아도 같은 사건은 한 번만 나간다.
"""

import logging
import threading
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
# 안전재고를 따로 설정하지 않은 재료에 적용할 기본 부족 기준
# (프론트 OrderScreen의 DEFAULT_LOW_STOCK과 같은 값이어야 화면과 알림이 어긋나지 않는다)
DEFAULT_LOW_STOCK = 3

# 설비 이상은 상황이 계속되면 다시 알려야 하지만, 매 시간 울리면 안 된다
SENSOR_COOLDOWN_HOURS = 6

# 발송 이력 보관 기간. 중복 방지용이라 기간이 지난 사건은 다시 나갈 일이 없다
# (가장 긴 주기가 서류 D-30이므로 90일이면 충분히 여유롭다).
SENT_HISTORY_DAYS = 90

# 주변 소식(행사·경쟁 카페)을 내보낼 가장 이른 시각 (KST). 급한 일이 아니라 영업 준비를
# 시작할 무렵에 하나만 간다 — 새벽에 "근처에 카페가 생겼어요"는 아무 쓸모가 없다.
NEARBY_HOUR = 10
# 행사 알림을 보낼 D-day 지점. 준비할 시간이 있는 한 번(D-7 이내 첫 감지)과
# 바로 전날 한 번이면 충분하다. 그 사이 매일 보내면 알림을 끈다.
EVENT_MILESTONES = [1, 7]

# 리포트를 내보낼 가장 이른 시각 (KST). 스케줄러를 매시간으로 돌리면 그날 첫 실행이
# 00:00이라 리포트가 자정에 나간다 — 방해금지 기본값이 꺼져 있어 그것으로도 못 막는다.
# 프론트 AlertsWatcher의 REPORT_HOUR와 같은 값이어야 한다.
REPORT_HOUR = 9

# 아침 브리핑을 내보낼 가장 이른 시각 (KST). 매장 오픈 시각을 알면 그쪽을 쓰고,
# 모르거나 새벽 오픈이면 이 값으로 — 문 열기 전에 도착해야 준비에 쓸 수 있다.
BRIEFING_FALLBACK_HOUR = 8

# 선제 인사이트 푸시에서 '전용 규칙이 이미 담당하는' 영역은 뺀다.
# (재고=규칙 3, 서류=규칙 1, 설비=규칙 4, 주변 상권=규칙 7·8)
INSIGHT_PUSH_SKIP_CATEGORIES = {"inventory", "document", "market"}
# 한 번 실행에 내보낼 인사이트 푸시 개수 — 여러 건이 한꺼번에 울리면 알림을 꺼 버린다
INSIGHT_PUSH_MAX = 2


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


def purge_old_history(db, days: int = SENT_HISTORY_DAYS) -> int:
    """오래된 발송 이력을 지우고 지운 개수를 돌려준다 — 안 지우면 무한히 쌓인다."""
    from app.models.ai import SentNotification

    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    n = db.query(SentNotification).filter(SentNotification.sent_at < cutoff).delete()
    db.commit()
    if n:
        logger.info("오래된 발송 이력 %d건 정리 (%d일 경과)", n, days)
    return n


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
    sent = push_service.send_to_store(db, store_id, title, body, payload, urgent=urgent)

    if sent == 0:
        # 한 대도 못 보냈다 — FCM 장애이거나 등록된 토큰이 전부 죽은 상태다.
        # 이력을 남겨두면 이 사건은 영영 안 나간다(D-7 서류 알림이 통째로 증발한다).
        # 예약을 취소해 다음 실행에서 다시 시도하게 한다.
        #
        # 무한 재시도가 되지 않는 이유: 죽은 토큰은 send_to_store가 그 자리에서 지우고,
        # 매장에 토큰이 하나도 안 남으면 run_all의 순회 대상에서 빠진다. 푸시 미설정
        # 상태는 run_all이 앞에서 걸러낸다.
        db.delete(row)
        db.commit()
        logger.warning("발송 0건 — 이력 취소하고 다음 실행에 재시도 (%s / %s)", store_id, dedupe_key)
        return False

    return True


def _dispatch_bundle(db, store_id: str, category: str, dedupe_keys: list[str],
                     title: str, body: str, data: dict[str, Any], urgent: bool = False) -> bool:
    """여러 사건을 알림 '한 건'으로 묶어 보낸다. 실제로 보냈으면 True.

    사건마다 따로 쏘면 몇 초 사이에 알림이 여러 개 몰려 폰에서 서로 묻힌다 —
    실측으로 주변 소식 3건을 연달아 보냈더니 사장님 폰에는 하나만 떴다(FCM은 3건 다
    수락했는데도). 재고 알림이 진작부터 품목을 묶어 보내던 것과 같은 이유다.

    중복 방지는 사건별로 그대로 유지한다: 아직 안 보낸 키만 골라 이력을 남기고,
    발송은 그 묶음에 대해 한 번만 한다.
    """
    from sqlalchemy.exc import IntegrityError

    from app.models.ai import SentNotification

    fresh = [k for k in dedupe_keys if not _already_sent(db, store_id, k)]
    if not fresh:
        return False

    rows = [SentNotification(store_id=store_id, dedupe_key=k, category=category,
                             title=title, body=body) for k in fresh]
    db.add_all(rows)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        return False  # 다른 실행이 선점 — 그쪽이 보낸다

    payload = {"category": category, **{k: str(v) for k, v in data.items()}}
    if push_service.send_to_store(db, store_id, title, body, payload, urgent=urgent) == 0:
        # 한 대도 못 보냈다 — 예약을 취소해 다음 실행에서 다시 시도한다 (_dispatch와 같은 이유)
        for row in rows:
            db.delete(row)
        db.commit()
        logger.warning("발송 0건 — 이력 취소하고 다음 실행에 재시도 (%s / %s)", store_id, fresh)
        return False
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

        # screen은 프론트 RootNavigator의 실제 라우트 이름이어야 한다 — 'Documents'(복수)로
        # 보내던 시절엔 탭해도 이동이 조용히 실패했다. 라우트는 'Document'(단수)다.
        # 서류마다 tag를 나눈다 — 같은 날 두 건이 만료되면 category가 같아 하나로 덮인다
        if _dispatch(db, store_id, "compliance", f"compliance:{item['id']}:{milestone}",
                     title, body, {"screen": "Document", "item_id": item["id"],
                                   "tag": f"compliance_{item['id']}"}):
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

    if now.hour < REPORT_HOUR:
        return []  # 아직 이른 시각 — 이력을 남기지 않으므로 오늘 늦게 실행되면 그때 나간다

    period_type = "daily" if settings.report_frequency == "daily" else "weekly"
    if period_type == "weekly" and now.weekday() != 0:
        return []  # 주간은 월요일에만

    from app.services.ai import report_service

    # 리포트는 '끝난 기간'을 다뤄야 한다. 기준일을 오늘로 두면 월요일 아침에 뽑은 주간
    # 리포트가 '오늘 시작한 이번 주'가 되어, 매출 0원짜리 리포트에 "지난주" 딱지가 붙는다.
    # 하루 물려 어제를 기준으로 잡으면 daily=어제, weekly=지난주(월~일)가 된다.
    ref = now.date() - timedelta(days=1)
    *_, period = report_service._period_range(period_type, ref)

    # 무거운 작업(집계·문서 갱신) '전에' 중복부터 판정한다 — 스케줄러가 매시간 돌아도
    # 이미 보낸 기간이면 여기서 끝나므로 재계산이 반복되지 않는다.
    dedupe_key = f"report:{period_type}:{period}"
    if _already_sent(db, store_id, dedupe_key):
        return []

    try:
        # 알림보다 리포트가 먼저 있어야 한다 — 탭해서 들어갔는데 없으면 안 되므로
        # 여기서 확실히 생성/갱신한다.
        report = report_service.generate_management_report(
            store_id, period_type=period_type, reference_date=ref.isoformat(), force_refresh=True)
    except Exception:
        logger.exception("리포트 알림용 생성 실패 (%s, %s)", store_id, period_type)
        return []

    content = report.get("content") or {}
    label = "어제" if period_type == "daily" else "지난주"
    title = f"📊 {label} 경영 리포트가 나왔어요"

    if _dispatch(db, store_id, "report", dedupe_key,
                 title, _report_body(content),
                 {"screen": "Dashboard", "period_type": period_type}):
        return [dedupe_key]
    return []


# ---------------------------------------------------------------------------
# 규칙 3 — 재고 소진 임박
# ---------------------------------------------------------------------------

def _scan_low_quantity(db, store_id: str) -> list[dict]:
    """소비 이력과 무관하게 '남은 수량 자체가 적은' 재료를 찾는다.

    안전재고를 설정한 재료는 그 기준으로, 설정하지 않은 재료(대부분)는 DEFAULT_LOW_STOCK
    기준으로 본다. 예측 기반 알림이 데이터 부족으로 침묵하는 매장을 위한 안전망이다.
    """
    from app.models.inventory import Ingredient, Stock

    try:
        rows = (
            db.query(Stock, Ingredient.name, Ingredient.unit)
            .join(Ingredient, Stock.ingredient_id == Ingredient.id)
            .filter(Ingredient.store_id == store_id)
            .all()
        )
    except Exception:
        logger.exception("재고 수량 스캔 실패 (%s)", store_id)
        return []

    out = []
    for stock, name, unit in rows:
        current = float(stock.current_quantity or 0)
        threshold = float(stock.safety_quantity or 0) or DEFAULT_LOW_STOCK
        if current < threshold:
            out.append({
                "ingredient": name,
                "unit": unit,
                "current_quantity": current,
                "threshold": threshold,
                "days_until_stockout": None,
            })
    out.sort(key=lambda r: r["current_quantity"])
    return out


def check_stock(db, store_id: str, settings, now: datetime) -> list[str]:
    """'이미 부족'이 아니라 '며칠 뒤 소진'을 알린다 — 그래야 발주할 시간이 남는다.

    품목별로 따로 보내지 않고 하루 한 번 묶는다. 개별 발송하면 알림을 꺼 버린다.
    """
    if not settings.stock_alert:
        return []

    # 중복 판정을 예측보다 앞에 둔다 — forecast()는 SARIMAX 적합(CPU)에 날씨·지오코딩
    # 외부 호출까지 도는 데다 자기 캐시를 읽지 않는다. 하루 한 번 보내는 알림 때문에
    # 매 스케줄러 틱마다 이걸 돌릴 이유가 없다.
    dedupe_key = f"stock:{now.date().isoformat()}"
    if _already_sent(db, store_id, dedupe_key):
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

    # 소진 예측은 최근 소비 이력이 있어야 나온다 — 판매를 앱에 안 넣는 매장에서는
    # 예측이 통째로 비어 알림이 한 번도 안 간다. 사장님이 원한 건 거창한 예측이 아니라
    # "몇 개 밑으로 떨어지면 알려 달라"였으므로, 절대 수량 기준을 함께 본다.
    low_items = _scan_low_quantity(db, store_id)
    known = {r.get("ingredient") for r in urgent_items}
    for it in low_items:
        if it["ingredient"] not in known:
            urgent_items.append(it)

    if not urgent_items:
        return []

    # 소진일을 아는 품목이 먼저, 그 다음이 '수량이 적다'만 아는 품목
    urgent_items.sort(key=lambda r: (r.get("days_until_stockout") is None,
                                     r.get("days_until_stockout") or 0))
    head = urgent_items[0]

    def _label(r: dict) -> str:
        d = r.get("days_until_stockout")
        if d is not None:
            # '예가체프 3일'만으로는 뭐가 3일인지 안 읽힌다
            return f"{r['ingredient']} {d:.0f}일 뒤 바닥"
        return f"{r['ingredient']} {r.get('current_quantity', 0):g}{r.get('unit', '')} 남음"

    parts = [_label(r) for r in urgent_items[:3]]
    more = len(urgent_items) - 3

    title = f"📦 {head['ingredient']} 곧 떨어져요"
    body = " · ".join(parts) + (f" 외 {more}종" if more > 0 else "") + " — 오늘 발주하면 안 끊겨요."

    # 발주 화면은 앱에서 빠졌다 — 같은 내용을 다루는 재고 화면으로 보낸다
    if _dispatch(db, store_id, "stock", dedupe_key,
                 title, body, {"screen": "Inventory"}):
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
        # 설비마다 tag를 나눈다 — 냉장고와 제빙기가 동시에 이상이면 하나로 덮인다
        if _dispatch(db, store_id, "sensor", key, f"🚨 {fault['title']}",
                     f"{fault['reason']} {fault['action']}",
                     {"screen": "Dashboard", "tag": f"sensor_{fault['source']}"}, urgent=True):
            sent.append(key)
    return sent


# ---------------------------------------------------------------------------
# 실행 진입점 — 스케줄러(Cloud Scheduler 등)가 부른다
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# 규칙 5 — 오늘 마감 리포트 (매장 마감 시간 이후 하루 한 번)
# ---------------------------------------------------------------------------

def _closing_send_hour(db, store_id: str) -> int:
    """마감 리포트 발송 시각 = 매장 마감 시간. 프로필이 없거나 새벽 마감(자정 넘김)이면
    22시로 — 날짜 경계를 넘기면 dedupe(하루 1회)와 '오늘 매출' 집계가 어긋난다."""
    try:
        from app.models.ai import StoreProfile

        profile = db.get(StoreProfile, store_id)
        if profile and profile.close_hour:
            h = _parse_hhmm(profile.close_hour)
            if h is not None:
                hour = h // 60
                if 6 <= hour <= 23:
                    return hour
    except Exception:
        pass
    return 22


def check_closing(db, store_id: str, settings, now: datetime) -> list[str]:
    """마감 후 '오늘 하루' 요약 한 장 — 매출(어제 대비)·베스트 메뉴·재고 주의.

    매출이 아직 입력되지 않은 날은 요약 대신 입력 리마인더를 보낸다(같은 dedupe 키) —
    이 알림의 목적이 '하루를 닫는 습관'이라 빈 날에도 한 번은 두드린다.
    """
    if not settings.report_alert:
        return []
    if now.hour < _closing_send_hour(db, store_id):
        return []

    today = now.date()
    dedupe_key = f"closing:{today.isoformat()}"
    if _already_sent(db, store_id, dedupe_key):
        return []

    # ① 오늘/어제 매출 — 정산 입력(현금+카드)이 원본, 없으면 메뉴별 판매(Sale) 합계로
    total = prev_total = 0
    try:
        from app.services.ai import settlement_service

        day = settlement_service.get_day(store_id, today.isoformat())
        total = int(day.get("total") or 0)
        prev = settlement_service.get_day(store_id, (today - timedelta(days=1)).isoformat())
        prev_total = int(prev.get("total") or 0)
    except Exception:
        logger.debug("마감 리포트: 정산 조회 실패 — Sale 합계로 폴백", exc_info=True)

    best_menu, menu_qty, sale_total = "", 0, 0
    try:
        from sqlalchemy import func as sa_func

        from app.models.inventory import Menu, Sale

        rows = (
            db.query(Menu.name, sa_func.sum(Sale.quantity), sa_func.sum(Sale.total_price))
            .join(Menu, Sale.menu_id == Menu.id)
            .filter(Sale.store_id == store_id,
                    Sale.sold_at >= today.isoformat(),
                    Sale.sold_at < (today + timedelta(days=1)).isoformat())
            .group_by(Menu.name)
            .order_by(sa_func.sum(Sale.quantity).desc())
            .all()
        )
        if rows:
            best_menu, menu_qty = rows[0][0], int(rows[0][1] or 0)
            sale_total = sum(int(r[2] or 0) for r in rows)
    except Exception:
        logger.debug("마감 리포트: Sale 집계 실패", exc_info=True)

    if total <= 0:
        total = sale_total

    lines: list[str] = []
    if total > 0:
        head = f"오늘 매출 ₩{total:,}"
        if prev_total > 0:
            pct = round((total - prev_total) / prev_total * 100)
            head += f" (어제 대비 {'+' if pct >= 0 else ''}{pct}%)"
        lines.append(head)
        if best_menu:
            lines.append(f"베스트 메뉴 {best_menu} {menu_qty}잔")
    else:
        lines.append("오늘 매출이 아직 입력되지 않았어요. 30초면 끝나요 ☕")

    try:
        low = _scan_low_quantity(db, store_id)[:2]
        if low:
            lines.append("재고 주의: " + ", ".join(
                f"{r['ingredient']} {r['current_quantity']:g}{r['unit']}" for r in low))
    except Exception:
        pass

    if _dispatch(db, store_id, "report", dedupe_key,
                 "🌙 오늘 마감 리포트", "\n".join(lines), {"screen": "Dashboard"}):
        return [dedupe_key]
    return []


# ---------------------------------------------------------------------------
# 규칙 6 — 원두 시세 하락 (전 매장 공통 시장 소식, 하루 한 번)
# ---------------------------------------------------------------------------

def check_bean_price(db, store_id: str, settings, now: datetime) -> list[str]:
    """생두모아 시세를 갱신해 크게 내린 원두가 있으면 알린다 — 구매(발주) 계열이라
    stock_alert 설정을 따른다. 하락이 없는 날은 침묵(이력도 안 남겨 내일 다시 본다)."""
    if not settings.stock_alert:
        return []
    if now.hour < 10:  # 시세 갱신은 오전 장 이후에
        return []

    dedupe_key = f"beanprice:{now.date().isoformat()}"
    if _already_sent(db, store_id, dedupe_key):
        return []

    try:
        from app.services.ai import bean_price_watch_service

        drops = bean_price_watch_service.get_today_drops(db)
    except Exception:
        logger.exception("원두 시세 확인 실패 (%s)", store_id)
        return []
    if not drops:
        return []

    top = drops[0]
    body = f"{top['name']} −{top['drop_pct']:g}% ({top['old_price']:,}→{top['new_price']:,}원/kg)"
    if len(drops) > 1:
        body += f" 외 {len(drops) - 1}건 하락"

    if _dispatch(db, store_id, "stock", dedupe_key,
                 "📉 원두 시세가 내렸어요", body,
                 {"screen": "BeanOperation"}):
        return [dedupe_key]
    return []


# ---------------------------------------------------------------------------
# 규칙 7 — 주변 행사 D-day (무엇을 준비할지 AI 플랜을 함께 보낸다)
# ---------------------------------------------------------------------------

def _pending_event(db, store_id: str, now: datetime) -> Optional[dict[str, Any]]:
    """지금 알릴 만한 행사 하나와 그 준비 플랜. 없으면 None.

    한 번에 행사 하나만 고른다(가장 영향이 큰 것). 축제 시즌에 다섯 건이 한꺼번에
    울리면 알림을 끄기 때문이다 — 나머지는 "외 N건"으로만 알리고 화면에서 본다.
    """
    from app.services.ai import nearby_watch_service

    point = nearby_watch_service.store_point(db, store_id)
    if not point:
        return None  # 매장 위치 미등록 — 알릴 반경 자체가 없다

    try:
        events = nearby_watch_service.pick_alert_events(*point)
    except Exception:
        logger.exception("주변 행사 조회 실패 (%s)", store_id)
        return None
    if not events:
        return None

    from app.services.ai.nearby_event_service import _norm

    # 아직 안 보낸 행사 중 영향이 가장 큰 것 하나. 행사별로 '준비 구간(D-7)'과 '전날(D-1)'에
    # 한 번씩 나가도록 dedupe 키에 구간을 넣는다 — 서류 알림(D-30/D-7/D-1)과 같은 방식이다.
    for event in events:
        d_day = 0 if event.get("ongoing") else max(0, event.get("d_day") or 0)
        milestone = next((m for m in EVENT_MILESTONES if d_day <= m), None)
        if milestone is None:
            continue
        key = f"event:{_norm(event.get('name', ''))[:60]}:{event.get('start_date')}:D-{milestone}"
        if _already_sent(db, store_id, key):
            continue

        # AI 플랜은 '보낼 것이 확정된 뒤'에만 만든다 — 이미 보낸 행사에 Gemini를 태우지 않는다
        plan = None
        try:
            plan = nearby_watch_service.plan_for_store(db, store_id, event)
        except Exception:
            logger.exception("행사 대비 플랜 생성 실패 (%s / %s)", store_id, event.get("name"))

        when = "오늘부터" if event.get("ongoing") or d_day == 0 else f"D-{d_day}"
        title = f"🎪 {when} · {event.get('name')}"
        if event.get("distance_km") is not None:
            title += f" ({event['distance_km']}km)"

        if plan:
            body = nearby_watch_service.plan_summary_line(plan)
        else:
            # 플랜을 못 만들어도 알림은 나간다 — 행사가 열린다는 사실 자체가 정보다
            body = (f"{event.get('place') or '주변'}에서 "
                    f"{event.get('start_date')}~{event.get('end_date')} 열려요.")
        others = len(events) - 1
        if others > 0:
            body += f" · 주변 행사 {others}건 더"

        return {"key": key, "title": title[:200], "line": body, "event": event}
    return None


# ---------------------------------------------------------------------------
# 규칙 8 — 주변 카페 개업 · 폐업
# ---------------------------------------------------------------------------

def _pending_cafe(db, store_id: str, now: datetime) -> dict[str, Any]:
    """반경 안 카페를 훑어 아직 안 알린 개업·폐업을 돌려준다.

    스캔 자체가 여기 있다 — 관측 대장(nearby_cafe_watch)이 매일 갱신돼야 '어제와 비교'가
    성립하기 때문이다. 하루 한 번만 돌도록 날짜 키로 잠근다.

    보낼 목록은 스캔 결과가 아니라 대장의 '아직 안 알린 변화'에서 가져온다 —
    지도 화면의 백그라운드 스캔이 먼저 돌아 변화를 확정해 버린 날에도 알림이 나가야 한다.

    반환: {"keys": [...], "lines": [...], "opened": [...], "closed": [...]}
    """
    empty: dict[str, Any] = {"keys": [], "lines": [], "opened": [], "closed": []}

    from app.services.ai import nearby_watch_service

    point = nearby_watch_service.store_point(db, store_id)
    if not point:
        return empty

    today = now.date().isoformat()
    scan_key = f"cafescan:{today}"

    # ① 오늘 아직 안 훑었으면 훑는다 (하루 한 번 — 네이버 검색 13회짜리 작업이다)
    if not _already_sent(db, store_id, scan_key):
        try:
            result = nearby_watch_service.scan_cafe_changes(
                db, store_id, *point,
                exclude_name=nearby_watch_service.store_name_of(db, store_id),
                today=now.date())
        except Exception:
            logger.exception("주변 카페 감시 실패 (%s)", store_id)
            db.rollback()
            return empty

        # 스캔이 성공했으면 '오늘은 돌았다'고 기록한다. 발송 이력 테이블을 그대로 쓰지만
        # 이 키는 알림이 아니라 잠금이므로 푸시로 나가지 않는다.
        # (부실한 스캔이면 기록하지 않아 다음 실행에서 다시 시도한다)
        if result.get("skipped") is None:
            from sqlalchemy.exc import IntegrityError

            from app.models.ai import SentNotification

            db.add(SentNotification(store_id=store_id, dedupe_key=scan_key, category="nearby",
                                    title="[내부] 주변 카페 스캔", body=""))
            try:
                db.commit()
            except IntegrityError:
                db.rollback()

    # ② 보낼 것은 대장에서 고른다 — 스캔을 누가 돌렸든(지도 화면 백그라운드 포함) 유실되지 않게
    pending = nearby_watch_service.pending_changes(db, store_id)

    keys: list[str] = []
    lines: list[str] = []
    opened, closed = pending["opened"], pending["closed"]

    if opened:
        head = opened[0]
        line = f"☕ 새로 생김: {head['name']} ({head['distance_m']}m"
        line += f", {len(opened) - 1}곳 더)" if len(opened) > 1 else ")"
        lines.append(line)
        keys.append(f"cafeopen:{today}:{len(opened)}")

    if closed:
        head = closed[0]
        line = f"🏚 없어진 듯: {head['name']} ({head['distance_m']}m"
        line += f", {len(closed) - 1}곳 더)" if len(closed) > 1 else ")"
        lines.append(line)
        keys.append(f"cafeclose:{today}:{len(closed)}")

    return {"keys": keys, "lines": lines, "opened": opened, "closed": closed}


def check_nearby(db, store_id: str, settings, now: datetime) -> list[str]:
    """규칙 7·8 — 주변 소식(곧 열리는 행사 + 경쟁 카페 개업·폐업)을 **한 건**으로 보낸다.

    행사와 카페 변화를 따로 쏘던 시절엔 몇 초 사이에 알림 두세 개가 몰려 폰에서 서로
    묻혔다(실측: 3건을 보냈는데 하나만 떴다). 사장님 입장에서도 "오늘 주변 소식"은
    한 덩어리로 읽는 편이 낫다. 제목은 가장 시급한 것(행사)이 가져가고, 나머지는 본문에 줄로 붙는다.
    """
    if not getattr(settings, "nearby_alert", True):
        return []
    if now.hour < NEARBY_HOUR:
        return []

    from app.services.ai import nearby_watch_service

    event = _pending_event(db, store_id, now)
    cafe = _pending_cafe(db, store_id, now)

    keys = ([event["key"]] if event else []) + cafe["keys"]
    if not keys:
        return []

    if event:
        title = event["title"]
        lines = [event["line"], *cafe["lines"]]
    else:
        # 행사가 없으면 카페 변화가 제목을 가져간다
        title = ("☕ 근처에 카페가 새로 생겼어요" if cafe["opened"]
                 else "🏚 근처 카페가 문을 닫은 것 같아요")
        lines = cafe["lines"]
        # 폐업은 검색에서 사라진 것에 근거한 '추정'이다 — 단정하면 신뢰가 깎인다
        if cafe["closed"] and not cafe["opened"]:
            lines.append("검색에서 사라졌어요(추정). 손님이 넘어올 기회예요.")

    data = {"screen": "StoreMap", "tag": "nearby"}
    if event:
        data["event_name"] = event["event"].get("name") or ""
        data["start_date"] = event["event"].get("start_date") or ""
    if cafe["keys"]:
        data["focus"] = "changes"

    if not _dispatch_bundle(db, store_id, "nearby", keys, title, "\n".join(lines), data):
        return []

    # 알림이 실제로 나간 뒤에만 '알림 완료'로 표시한다 (발송 실패면 다음 실행에서 재시도)
    if cafe["opened"]:
        nearby_watch_service.mark_notified(
            db, store_id, [c["place_key"] for c in cafe["opened"]], "opened")
    if cafe["closed"]:
        nearby_watch_service.mark_notified(
            db, store_id, [c["place_key"] for c in cafe["closed"]], "closed")
    return keys


# ---------------------------------------------------------------------------
# 규칙 9 — 아침 브리핑 (하루의 시작에 한 번, 오늘 할 일을 먼저 정리해 준다)
# ---------------------------------------------------------------------------

def _briefing_send_hour(db, store_id: str) -> int:
    """브리핑 발송 시각 = 매장 오픈 시각(문 열기 전에 읽어야 준비에 쓴다).

    프로필이 없거나 새벽 오픈(자정 넘김)이면 기본값으로 — 새벽 5시에 울리면 안 된다.
    """
    try:
        from app.models.ai import StoreProfile

        profile = db.get(StoreProfile, store_id)
        if profile and profile.open_hour:
            minutes = _parse_hhmm(profile.open_hour)
            if minutes is not None:
                hour = minutes // 60
                if 6 <= hour <= 12:
                    return hour
    except Exception:
        pass
    return BRIEFING_FALLBACK_HOUR


def check_briefing(db, store_id: str, settings, now: datetime) -> list[str]:
    """오늘의 브리핑 — 어제 실적 한 줄 + 지금 가장 급한 일 둘.

    리포트(규칙 2)가 '끝난 기간의 성적표'라면 이건 '오늘 무엇을 할지'다. 그래서 마감이
    아니라 오픈 시각에 나가고, 본문에 조치할 일이 들어간다. 리포트 수신 설정을 따른다 —
    사장님이 '경영 리포트 알림'을 끄면 아침 브리핑도 함께 조용해지는 편이 자연스럽다.
    """
    if not settings.report_alert:
        return []
    if now.hour < _briefing_send_hour(db, store_id):
        return []

    dedupe_key = f"briefing:{now.date().isoformat()}"
    if _already_sent(db, store_id, dedupe_key):
        return []

    from app.services.ai import briefing_service

    try:
        # deep=True — 하루 한 번 도는 자리라, 무거운 스캐너(단골 이탈·원두 시세)도 여기서 갱신한다.
        # 이 결과가 캐시에 남아 앱이 인사이트를 폴링할 때 곧바로 보인다.
        briefing = briefing_service.build(store_id, force_refresh=True, deep=True)
    except Exception:
        logger.exception("아침 브리핑 생성 실패 (%s)", store_id)
        return []

    # 어제 매출도 없고 챙길 일도 없으면 보내지 않는다 — 할 말이 없는 알림은 신뢰를 깎는다
    if not briefing.get("priorities") and not (briefing["facts"]["yesterday_sales"]["total"] > 0):
        return []

    if _dispatch(db, store_id, "briefing", dedupe_key,
                 f"☕ 오늘의 브리핑 · {briefing['headline']}"[:200],
                 briefing_service.push_body(briefing),
                 {"screen": "Dashboard", "tag": "briefing"}):
        return [dedupe_key]
    return []


# ---------------------------------------------------------------------------
# 규칙 10 — 선제 인사이트 (전용 규칙이 없는 나머지 영역을 전부 덮는다)
# ---------------------------------------------------------------------------

# 인사이트 영역 → 탭했을 때 열릴 화면 (프론트 RootNavigator의 실제 라우트 이름)
INSIGHT_SCREEN = {
    "inventory": "Inventory",
    "document": "Document",
    "market": "StoreMap",
    "settlement": "Dashboard",
    "customer": "Membership",
    "marketing": "Marketing",
    "system": "Settings",
    "forecast": "Dashboard",
    "menu": "Cost",
    "order": "Inventory",
    "staff": "Staff",
    "tax": "Document",
    "sales": "Dashboard",
    "data": "Dashboard",
    "reward": "Shop",
}

INSIGHT_ICON = {
    "settlement": "💳", "customer": "🙋", "marketing": "📣", "system": "🔌",
    "forecast": "🔮", "menu": "🧮", "order": "🚚", "staff": "👥",
    "tax": "🧾", "sales": "📉", "data": "✏️", "reward": "🎁",
}


def check_insights(db, store_id: str, settings, now: datetime) -> list[str]:
    """정산 미입력·뜸해진 단골·POS 연동 끊김·팔수록 손해인 메뉴처럼, 전용 알림 규칙이
    없는 영역의 '지금 조치' 건을 내보낸다.

    같은 사건을 두 번 보내지 않도록 dedupe 키에 인사이트 key를 그대로 쓴다 —
    상황이 바뀌면 key가 달라져 새 알림이 되고, 그대로면 영영 한 번만 나간다.
    사장님이 앱에서 확인/미루기 한 건은 스캔 단계에서 이미 빠져 있다.
    """
    if not getattr(settings, "insight_alert", True):
        return []
    if now.hour < REPORT_HOUR:
        return []  # 새벽에 "원가율이 높아요"는 쓸모가 없다

    from app.services.ai import insight_service

    try:
        # 브리핑(규칙 9)이 이미 돌았다면 그 결과가 캐시에 있어 여기서는 다시 계산하지 않는다
        scan = insight_service.scan(store_id)
    except Exception:
        logger.exception("인사이트 알림 스캔 실패 (%s)", store_id)
        return []

    picked: list[dict[str, Any]] = []
    for item in scan.get("insights", []):
        if len(picked) >= INSIGHT_PUSH_MAX:
            break
        if item.get("severity") != "high":
            continue  # medium 이하는 앱을 열었을 때 보면 되는 일이다
        if (item.get("category") or "") in INSIGHT_PUSH_SKIP_CATEGORIES:
            continue
        picked.append(item)

    if not picked:
        return []

    # 여러 건이어도 알림은 한 장으로 묶는다 — 몇 초 사이에 두 개를 쏘면 폰에서 하나가 묻힌다
    head = picked[0]
    category = head.get("category") or ""
    title = f"{INSIGHT_ICON.get(category, '🔔')} {head['title']}"[:200]
    body = (head.get("body") or "")[:250]
    if len(picked) > 1:
        body += f"\n· {picked[1]['title']}"

    keys = [f"insight:{i['key']}"[:120] for i in picked]
    if _dispatch_bundle(db, store_id, "insight", keys, title, body,
                        {"screen": INSIGHT_SCREEN.get(category, "Dashboard"),
                         "tag": f"insight_{category}"}):
        return keys
    return []


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
    sent += check_closing(db, store_id, settings, now)      # 규칙 5 — 마감 리포트
    sent += check_bean_price(db, store_id, settings, now)   # 규칙 6 — 원두 시세 하락
    sent += check_nearby(db, store_id, settings, now)       # 규칙 7·8 — 주변 소식 (한 건으로 묶어서)
    briefed = check_briefing(db, store_id, settings, now)   # 규칙 9 — 아침 브리핑
    sent += briefed
    # 브리핑이 방금 나갔으면 인사이트 푸시는 다음 실행으로 미룬다 — 브리핑 본문에 이미
    # 같은 우선순위가 담겨 있고, 몇 초 사이 두 건을 쏘면 폰에서 하나가 묻힌다.
    if not briefed:
        sent += check_insights(db, store_id, settings, now)  # 규칙 10 — 나머지 영역의 '지금 조치'
    return {"store_id": store_id, "sent": sent}


def _warm_forecast_caches(store_ids: list[str]) -> None:
    """오늘 치 예측을 미리 계산해 DB 캐시(ai_warm_cache)에 넣어 둔다.

    아침에 앱을 처음 켜는 사장님이 SARIMAX 적합과 외부 API 왕복을 기다리게 하지 않으려는
    것이다(실측 7.0초). 이 크론은 매시간 도는데, 오늘 것이 이미 있으면 바로 넘어가므로
    실제 계산은 매장당 하루 한 번이다.

    좌표는 계정에 등록된 매장 고정 위치를 쓴다 — 앱이 예측을 부를 때와 같은 좌표여야
    같은 캐시에 걸린다(예전엔 좌표 없이 계산해 서울시청 기준 캐시가 따로 생겼다).
    """
    from app.models.user import User
    from app.services.ai import forecast_service

    try:
        with document_service._session() as db:
            rows = db.query(User.email, User.store_lat, User.store_lon).filter(
                User.email.in_(store_ids)
            ).all()
        coords = {email: (lat, lon) for email, lat, lon in rows}
    except Exception:
        logger.exception("예측 예열 — 매장 좌표 조회 실패")
        coords = {}

    warmed = 0
    for store_id in store_ids:
        lat, lon = coords.get(store_id, (None, None))
        try:
            if forecast_service.peek_forecast_cache(store_id, lat, lon) is not None:
                continue  # 오늘 만든 예측이 이미 있다
            forecast_service.refresh_forecast_background(store_id, lat, lon)
            warmed += 1
        except Exception:
            logger.exception("예측 예열 실패 (%s)", store_id)
    if warmed:
        logger.info("예측 예열 완료 — 매장 %d곳", warmed)


def run_all(now: Optional[datetime] = None) -> dict[str, Any]:
    """푸시 토큰이 등록된 모든 매장을 순회한다.

    토큰이 없는 매장은 건너뛴다 — 보낼 곳이 없는데 예측·리포트 생성 비용을 치를 이유가 없다.
    한 매장이 실패해도 나머지는 계속 돈다.
    """
    from app.models.ai import DeviceToken

    now = now or datetime.now(KST)

    # FCM 자격증명이 없으면 아무것도 하지 않는다. 발송이 전부 0건이 되는데,
    # _dispatch가 0건을 '실패'로 보고 이력을 취소하므로 매 실행마다 리포트 생성과
    # 재고 예측만 반복하게 된다 (보내지도 못하면서).
    if not push_service.is_configured():
        logger.info("FCM 미설정 — 알림 실행 건너뜀")
        return {"ran_at": now.isoformat(), "skipped": "push_unconfigured",
                "stores": 0, "sent_total": 0, "results": []}

    with document_service._session() as db:
        # 순회 전에 청소한다 — 죽은 토큰을 먼저 걷어내야 '보낼 곳 없는 매장'에
        # 예측·리포트 비용을 치르지 않는다. 둘 다 타임스탬프 조건 DELETE 한 번씩이다.
        try:
            push_service.purge_stale_tokens(db)
            purge_old_history(db)
        except Exception:
            logger.exception("정리 작업 실패 — 알림 발송은 계속 진행한다")
            db.rollback()

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

    # 예측 예열은 크론 응답을 붙잡지 않는다 — 매장이 늘면 몇 분씩 걸릴 수 있고,
    # 스케줄러는 응답이 늦으면 실패로 보고 다시 부른다.
    if store_ids:
        threading.Thread(target=_warm_forecast_caches, args=(store_ids,),
                         name="forecast-warm", daemon=True).start()

    return {"ran_at": now.isoformat(), "stores": len(results), "sent_total": total, "results": results}
