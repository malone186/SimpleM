"""주변 상권 변화 감시 (백엔드 B) — 행사가 다가오면 알리고, 카페가 생기거나 없어지면 알린다

기존 nearby_cafe_service / nearby_event_service는 "지금 주변에 무엇이 있나"를 보여 준다.
사장님이 그 화면을 열어야만 알 수 있다는 뜻이다. 여기서는 그걸 뒤집어,

  1) 카페  — 매일 한 번 반경을 훑어 어제와 비교한다 → 신규 개업 · 폐업 추정  (scan_cafe_changes)
  2) 행사  — 다가오는 행사 중 아직 안 알린 것을 고르고                       (pick_alert_events)
             그 행사에 무슨 이벤트를 하고 무엇을 준비할지 AI가 짜 준다        (plan_event_promotion)

판정은 여기서 하고, 실제 푸시 발송은 notification_service가 한다(규칙 7·8).
카페 관측 결과는 nearby_cafe_watch 테이블에 남아 매장 지도 화면의 '상권 변화' 카드도 읽는다.

[한 번에 판정하지 않는 이유]
네이버 지역검색은 키워드당 상위 5건만 주고 429(초당 제한)도 섞인다. 어제 보이던 가게가
오늘 결과에서 빠지는 일이 정상적으로 일어난다. 그래서
  · 신규: 두 번 연속 관측돼야 '생겼다'고 본다
  · 폐업: 세 번 연속 사라져야 '없어진 것 같다'고 본다 (그마저도 '추정'이라고 말한다)
게다가 이번 스캔이 통째로 부실하면(수집 0건이거나 평소의 절반 미만) 비교 자체를 건너뛴다.
"""

import logging
import re
import time
from datetime import date, datetime, timedelta, timezone

KST = timezone(timedelta(hours=9))


def _today_kst() -> date:
    """개업/폐업 판정 카운터의 '오늘'은 반드시 KST 기준이어야 한다.

    date.today()는 서버 타임존을 따르는데, 알림 크론은 KST 날짜를
    넘겨준다. 두 경로가 섞이면 00~09시 KST 사이에 서로 다른 '오늘'을 쓰게 되어
    같은 영업일에 seen/miss 카운터가 두 번 오르고, 2회 확인·3회 실종 판정이
    몇 시간 만에 끝나 버린다 — 그 오탐을 막으려고 만든 카운터인데.
    """
    return datetime.now(KST).date()
from typing import Any, Optional

from app.services.ai import nearby_cafe_service, nearby_event_service
from app.services.ai.nearby_cafe_service import _gemini_json
from app.services.ai.untrusted import quote_untrusted

logger = logging.getLogger(__name__)

# 감시 반경 — 지도 화면 기본값(1km)과 같다. 이보다 넓히면 "우리 손님을 나눠 갖는 가게"가
# 아닌 곳까지 들어와 알림이 소음이 된다.
WATCH_RADIUS_M = 1000
WATCH_LIMIT = 30

NEW_CONFIRM_SCANS = 2     # 이만큼 연속 관측되면 '신규 개업'으로 인정
CLOSE_CONFIRM_SCANS = 3   # 이만큼 연속 사라지면 '폐업 추정'으로 인정

# 이번 스캔을 믿을지 판단하는 최소 수집 비율 — 관측 중인 카페 수 대비 이 비율보다 적게
# 걷히면 API가 부실했던 날로 보고 비교를 통째로 건너뛴다 (miss_count도 올리지 않는다).
HEALTHY_SCAN_RATIO = 0.6

# 행사 알림 지평선 — 이 안에 시작하는 행사만 알린다. 2주 전에 알려 봐야 잊는다.
EVENT_ALERT_DAYS = 7

# 카페 변화를 '아직 알릴 만한 소식'으로 볼 기간. 푸시가 꺼져 있던 두 달치가
# 어느 날 한꺼번에 울리는 일을 막는다.
NOTIFY_WINDOW_DAYS = 14

_PLAN_TTL = 12 * 3600
_plan_cache: dict[str, tuple[float, dict[str, Any]]] = {}

# 같은 매장의 스캔을 짧은 간격으로 반복하지 않기 위한 프로세스 내 쿨다운
# (지도 화면을 여러 번 열어도 네이버를 다시 훑지 않게)
_SCAN_COOLDOWN_SEC = 3600
_last_scan_attempt: dict[str, float] = {}


def _place_key(name: str, address: str) -> str:
    """같은 가게를 같은 줄로 모으는 키 — 공백·대소문자 차이를 흡수한다."""
    return re.sub(r"\s+", "", f"{name}|{address}").lower()[:200]


def _linked_place(db, store_id: str) -> Optional[dict[str, str]]:
    """사장님이 '이게 내 가게'라고 지정한 네이버 장소 (없으면 None)."""
    from app.models.ai import CafeReviewLink

    try:
        row = db.get(CafeReviewLink, store_id)
        if row and row.place_name:
            return {"name": row.place_name, "address": row.place_address or ""}
    except Exception:
        logger.debug("내 카페 지정 조회 실패 — 제외 없이 계속", exc_info=True)
    return None


# ---------------------------------------------------------------------------
# 1) 카페 개업 · 폐업 감시
# ---------------------------------------------------------------------------

def scan_cafe_changes(db, store_id: str, lat: float, lon: float,
                      exclude_name: str = "", today: Optional[date] = None,
                      radius_m: int = WATCH_RADIUS_M) -> dict[str, Any]:
    """반경 안의 카페를 훑어 관측 대장을 갱신하고, 확정된 변화를 돌려준다.

    반환: {"scanned": n, "opened": [...], "closed": [...], "baseline": bool, "skipped": str|None}
      · opened  — 이번 스캔에서 '신규 개업'으로 확정된 가게 (아직 알림 안 나간 것만)
      · closed  — 이번 스캔에서 '폐업 추정'으로 확정된 가게
      · baseline — 첫 스캔이라 전부 '원래 있던 가게'로 기록만 하고 알리지 않았다는 뜻

    하루에 여러 번 불러도 안전하다: 같은 날짜로는 seen/miss 카운트를 올리지 않는다.
    """
    from app.models.ai import NearbyCafeWatch

    today = today or _today_kst()
    today_iso = today.isoformat()

    rows = db.query(NearbyCafeWatch).filter(NearbyCafeWatch.store_id == store_id).all()
    by_key = {r.place_key: r for r in rows}
    baseline = not rows

    try:
        found = nearby_cafe_service.find_nearby_cafes(
            lat, lon, radius_m=radius_m, limit=WATCH_LIMIT, exclude_name=exclude_name,
            # '내 카페'로 지정한 장소도 함께 제외한다 — 안 그러면 내 매장이 검색에서
            # 며칠 빠지는 날 "내 카페가 문을 닫은 것 같아요"라는 알림이 나간다.
            exclude_place=_linked_place(db, store_id))
    except nearby_cafe_service.NearbyCafeError as e:
        logger.info("주변 카페 감시 건너뜀 (%s): %s", store_id, e)
        return {"scanned": 0, "opened": [], "closed": [], "baseline": baseline, "skipped": "collect_failed"}

    cafes = found.get("cafes") or []
    open_rows = [r for r in rows if r.status == "open"]

    # 부실한 스캔으로 멀쩡한 가게를 폐업 처리하지 않는다 (429가 섞이면 결과가 반 토막 난다)
    if not cafes or (open_rows and len(cafes) < len(open_rows) * HEALTHY_SCAN_RATIO):
        logger.info("주변 카페 감시 결과가 부실해 비교 생략 (%s): 수집 %d건 / 관측 중 %d곳",
                    store_id, len(cafes), len(open_rows))
        return {"scanned": len(cafes), "opened": [], "closed": [], "baseline": baseline,
                "skipped": "unreliable_scan"}

    opened: list[dict[str, Any]] = []
    closed: list[dict[str, Any]] = []
    seen_keys: set[str] = set()

    for cafe in cafes:
        key = _place_key(cafe["name"], cafe.get("address", ""))
        seen_keys.add(key)
        row = by_key.get(key)

        if row is None:
            row = NearbyCafeWatch(
                store_id=store_id, place_key=key, name=cafe["name"][:150],
                address=(cafe.get("address") or "")[:200], category=(cafe.get("category") or "")[:100],
                lat=cafe.get("lat"), lon=cafe.get("lon"), distance_m=cafe.get("distance_m") or 0,
                status="open", seen_count=1, miss_count=0,
                first_seen=today_iso, last_seen=today_iso,
                # 첫 스캔에 걷힌 가게들은 '원래 있던 가게'다 — 알림에도, 변화 목록에도 넣지 않는다
                is_baseline=baseline, open_notified=baseline,
            )
            db.add(row)
            by_key[key] = row
            continue

        # 하루에 여러 번 돌아도 카운트는 하루 한 번만 오른다
        if row.last_seen != today_iso:
            row.seen_count = (row.seen_count or 0) + 1
            row.last_seen = today_iso
        row.miss_count = 0
        row.distance_m = cafe.get("distance_m") or row.distance_m
        if cafe.get("lat") and cafe.get("lon"):
            row.lat, row.lon = cafe["lat"], cafe["lon"]
        if row.status == "closed":
            # 폐업으로 봤던 가게가 다시 잡혔다 — 검색이 잠깐 놓쳤던 것이므로 조용히 되돌린다.
            # (다시 열었다고 알리면, 원인이 대개 검색 흔들림이라 알림만 왕복한다)
            logger.info("폐업 추정 철회 — 다시 검색됨 (%s / %s)", store_id, row.name)
            row.status, row.closed_on, row.close_notified = "open", None, False

        if (row.status == "open" and not row.open_notified
                and row.seen_count >= NEW_CONFIRM_SCANS and row.first_seen != row.last_seen):
            opened.append(_as_change(row, "opened"))

    # 이번에 안 잡힌 가게들 — 연속으로 사라져야 폐업으로 본다
    for row in open_rows:
        if row.place_key in seen_keys:
            continue
        if row.last_seen == today_iso:
            continue  # 오늘 이미 처리한 행 (같은 날 두 번째 스캔)
        row.miss_count = (row.miss_count or 0) + 1
        row.last_seen = today_iso
        if row.miss_count >= CLOSE_CONFIRM_SCANS:
            row.status = "closed"
            row.closed_on = today_iso
            if not row.close_notified:
                closed.append(_as_change(row, "closed"))

    db.commit()
    return {"scanned": len(cafes), "opened": opened, "closed": closed,
            "baseline": baseline, "skipped": None}


def _as_change(row, kind: str) -> dict[str, Any]:
    """관측 행 → 화면·알림이 쓰는 변화 항목."""
    return {
        "kind": kind,                      # opened | closed
        "name": row.name,
        "address": row.address or "",
        "category": row.category or "",
        "distance_m": row.distance_m or 0,
        "lat": row.lat,
        "lon": row.lon,
        "first_seen": row.first_seen or "",
        "last_seen": row.last_seen or "",
        "closed_on": row.closed_on,
        "place_key": row.place_key,
    }


def pending_changes(db, store_id: str, days: int = NOTIFY_WINDOW_DAYS) -> dict[str, Any]:
    """확정됐지만 아직 알리지 않은 변화 (알림 규칙 8이 실제로 보낼 목록).

    scan_cafe_changes가 그 자리에서 돌려주는 '이번 스캔의 변화'만 보면 알림이 샌다:
    지도 화면을 열면 백그라운드 스캔이 먼저 돌 수 있고, 그러면 변화는 대장에 확정돼 있는데
    정작 스케줄러의 스캔은 아무 변화도 못 보고 지나간다(그 가게는 이미 처리된 상태다).
    그래서 '누가 찾았든 아직 안 알린 것'을 여기서 다시 모은다.

    너무 오래된 변화는 뺀다 — 푸시가 꺼져 있던 두 달치가 어느 날 한꺼번에 울리면 안 된다.
    """
    from app.models.ai import NearbyCafeWatch

    since = (_today_kst() - timedelta(days=max(1, days))).isoformat()
    rows = db.query(NearbyCafeWatch).filter(NearbyCafeWatch.store_id == store_id).all()

    opened = [_as_change(r, "opened") for r in rows
              if r.status == "open" and not r.is_baseline and not r.open_notified
              and r.seen_count >= NEW_CONFIRM_SCANS
              and r.first_seen != r.last_seen and r.first_seen >= since]
    closed = [_as_change(r, "closed") for r in rows
              if r.status == "closed" and not r.close_notified and (r.closed_on or "") >= since]

    opened.sort(key=lambda c: c["distance_m"])   # 가까운 곳이 먼저 — 알림 본문의 대표가 된다
    closed.sort(key=lambda c: c["distance_m"])
    return {"opened": opened, "closed": closed}


def mark_notified(db, store_id: str, place_keys: list[str], kind: str) -> None:
    """알림이 실제로 나간 가게에 표시를 남긴다 — 같은 변화가 다시 나가지 않게."""
    from app.models.ai import NearbyCafeWatch

    if not place_keys:
        return
    field = "open_notified" if kind == "opened" else "close_notified"
    rows = (db.query(NearbyCafeWatch)
            .filter(NearbyCafeWatch.store_id == store_id,
                    NearbyCafeWatch.place_key.in_(place_keys))
            .all())
    for row in rows:
        setattr(row, field, True)
    db.commit()


def recent_changes(db, store_id: str, days: int = 30) -> dict[str, Any]:
    """최근 days일 안에 확정된 개업·폐업 목록 (지도 화면 '상권 변화' 카드용).

    외부 호출을 하지 않는 순수 DB 조회다 — 화면이 기다릴 일이 없다.
    """
    from app.models.ai import NearbyCafeWatch

    since = (_today_kst() - timedelta(days=max(1, days))).isoformat()
    rows = db.query(NearbyCafeWatch).filter(NearbyCafeWatch.store_id == store_id).all()

    opened = [_as_change(r, "opened") for r in rows
              if r.status == "open" and not r.is_baseline
              and r.seen_count >= NEW_CONFIRM_SCANS
              and r.first_seen >= since and r.first_seen != r.last_seen]
    # 폐업은 기준선 가게도 그대로 알린다 — '원래 있던 가게가 없어진 것'이야말로 진짜 변화다
    closed = [_as_change(r, "closed") for r in rows
              if r.status == "closed" and (r.closed_on or "") >= since]

    # 최근에 생긴 것부터, 같은 날이면 가까운 곳부터 (사장님이 신경 쓸 순서 그대로)
    opened.sort(key=lambda c: (c["first_seen"], -c["distance_m"]), reverse=True)
    closed.sort(key=lambda c: (c["closed_on"] or "", -c["distance_m"]), reverse=True)

    last_scan = max((r.last_seen or "" for r in rows), default="")
    first_scan = min((r.first_seen or "" for r in rows if r.first_seen), default="")
    return {
        "days": days,
        "tracked": sum(1 for r in rows if r.status == "open"),
        "last_scan": last_scan,
        "first_scan": first_scan,
        # 아직 기준선만 있는 상태 — '변화 없음'이 아니라 '이제 막 보기 시작했다'는 뜻이다.
        # 화면이 이 둘을 같은 문구로 말하면, 관측 첫날 사장님은 기능이 죽은 줄 안다.
        "baseline_only": bool(rows) and all(r.is_baseline for r in rows),
        "opened": opened,
        "closed": closed,
        "count": len(opened) + len(closed),
    }


def scan_if_stale(db, store_id: str, lat: float, lon: float, exclude_name: str = "",
                  force: bool = False) -> Optional[dict[str, Any]]:
    """마지막 스캔이 오늘이 아니면 한 번 훑는다 (지도 화면을 열 때 백그라운드로 호출).

    푸시(FCM)가 설정되지 않은 환경에서도 상권 변화가 쌓이게 하는 경로다 —
    스케줄러만 믿으면 데모 계정에서는 대장이 영원히 비어 있다.
    """
    from app.models.ai import NearbyCafeWatch

    now = time.time()
    last_try = _last_scan_attempt.get(store_id, 0.0)
    if not force and now - last_try < _SCAN_COOLDOWN_SEC:
        return None

    today_iso = _today_kst().isoformat()
    if not force:
        latest = (db.query(NearbyCafeWatch.last_seen)
                  .filter(NearbyCafeWatch.store_id == store_id)
                  .order_by(NearbyCafeWatch.last_seen.desc())
                  .first())
        if latest and latest[0] == today_iso:
            return None

    _last_scan_attempt[store_id] = now
    try:
        return scan_cafe_changes(db, store_id, lat, lon, exclude_name=exclude_name)
    except Exception:
        logger.exception("주변 카페 감시 스캔 실패 (%s)", store_id)
        db.rollback()
        return None


# ---------------------------------------------------------------------------
# 2) 다가오는 행사 고르기
# ---------------------------------------------------------------------------

def pick_alert_events(lat: float, lon: float,
                      horizon_days: int = EVENT_ALERT_DAYS) -> list[dict[str, Any]]:
    """지금 알릴 만한 행사만 골라 영향이 큰 순으로 돌려준다.

    기준은 '얼마나 곧, 얼마나 가까이, 얼마나 크게'다:
      · 이미 끝났거나 horizon_days보다 먼 행사는 뺀다 (오늘 진행 중인 행사는 남긴다)
      · 부스팅(예상 매출 영향)이 크고 가까운 순으로 정렬
    """
    found = nearby_event_service.find_nearby_events(lat, lon, days=max(horizon_days, 7))
    picked = [e for e in found.get("events", []) if 0 <= e.get("d_day", 99) <= horizon_days or e.get("ongoing")]
    picked.sort(key=lambda e: (-(e.get("boost_pct") or 0),
                               nearby_event_service._dist_for_sort(e.get("distance_km")),
                               e.get("d_day", 99)))
    return picked


# ---------------------------------------------------------------------------
# 3) 행사 대비 AI 플랜 — "그때 무슨 이벤트를 하고 뭘 준비할까"
# ---------------------------------------------------------------------------

_EVENT_PLAN_SCHEMA = {
    "type": "object",
    "properties": {
        "headline": {"type": "string"},
        "impact_level": {"type": "string"},
        "expected_change": {"type": "string"},
        "busy_window": {"type": "string"},
        "promotions": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "title": {"type": "string"},
                    "detail": {"type": "string"},
                    "why": {"type": "string"},
                },
                "required": ["title", "detail", "why"],
            },
        },
        "menu_idea": {"type": "string"},
        "prep_actions": {"type": "array", "items": {"type": "string"}},
        "stock_prep": {"type": "array", "items": {"type": "string"}},
        "staffing": {"type": "string"},
        "promo_copy": {"type": "string"},
    },
    "required": ["headline", "impact_level", "expected_change", "busy_window",
                 "promotions", "menu_idea", "prep_actions", "stock_prep",
                 "staffing", "promo_copy"],
}

_EVENT_PLAN_PROMPT = """너는 카페 사장님의 마케팅·운영 참모다.
매장 근처에서 곧 행사가 열린다. 이 행사에 맞춰 **무슨 이벤트를 하고 무엇을 준비할지** 짜라. 한국어.

[내 매장]
상호: {store_name}
위치: {region}
업종/상권: {biz_type}
영업시간: {hours}
오늘: {today}

[다가오는 행사]
{event}

[다른 주변 행사]
{others}

[작성 규칙] 사장님은 바쁘고, 준비할 시간은 {d_day}일뿐이다.
당장 실행할 수 있는 것만 쓴다. 큰 비용이 드는 건 제안하지 않는다(현수막 제작·인테리어 등 제외).
행사 이름은 위에 적힌 그대로 쓴다. 근거 없는 숫자는 지어내지 않는다.

- headline: 이 행사에 대한 한 줄 요약 (30자 이내, 예: "토요일 오후 나들이 손님 몰림")
- impact_level: "낮음" / "보통" / "높음" 중 하나 (거리·규모·기간을 함께 본다)
- expected_change: 손님이 어떻게 달라질지 한 문장 (40자 이내, 확실하지 않으면 "예상" 이라고 밝힌다)
- busy_window: 특히 붐빌 날짜·시간대 (예: "8/9(토) 14~18시")
- promotions: 이번 행사에 걸 이벤트 2~3개.
    title은 15자 이내 이벤트 이름, detail은 실행 방법 40자 이내(가격·조건을 구체적으로),
    why는 왜 먹힐지 25자 이내
    (예: title "행사 팔찌 할인", detail "행사 팔찌·티켓 보여주면 아메리카노 500원 할인")
- menu_idea: 행사 기간에 낼 한정 메뉴 하나 (35자 이내, 기존 재료로 만들 수 있는 것)
- prep_actions: 행사 전에 해 둘 일 3개. **한 항목 30자 이내, '~하기'로 끝낼 것**
  (예: "우유 평소 2배 발주하기", "행사 할인 안내문 붙이기")
- stock_prep: 미리 넉넉히 확보할 재료 2~3개. **한 항목 20자 이내** (예: "우유 평소 2배")
- staffing: 인력 배치 한 줄 (30자 이내, 예: "토요일 14~18시 알바 1명 추가")
- promo_copy: 인스타·매장 앞에 그대로 쓸 홍보 문구 한 줄 (40자 이내, 이모지 1개까지)"""


def plan_event_promotion(event: dict[str, Any], store_name: str = "내 매장", biz_type: str = "",
                         region: str = "", hours: str = "", others: Optional[list[dict[str, Any]]] = None,
                         today: Optional[str] = None) -> Optional[dict[str, Any]]:
    """행사 하나에 맞춘 이벤트·준비 플랜을 AI가 짠다 (실패하면 None — 화면은 목록만 보여 준다).

    Gemini 호출 1회. 같은 행사·같은 매장이면 12시간 캐시한다 (팀 공유 키 쿼터 절약).
    """
    name = (event.get("name") or "").strip()
    if not name:
        return None

    today = today or _today_kst().isoformat()
    # 프롬프트에 들어가는 값은 전부 키에 넣는다 — 예전엔 store_name만 넣어서, 상호를
    # 등록 안 한 매장끼리(둘 다 기본값 '내 매장') 또는 같은 프랜차이즈끼리 남의 플랜을
    # 그대로 받았다. 업종·지역·영업시간이 다른데 08시 오픈 기준 인력 계획이 내려오는 식.
    cache_key = f"{store_name}|{biz_type}|{region}|{hours}|{name}|{event.get('start_date')}|{today}"
    hit = _plan_cache.get(cache_key)
    if hit and time.time() - hit[0] < _PLAN_TTL:
        return {**hit[1], "cached": True}

    d_day = event.get("d_day")
    d_day_text = "0(오늘)" if not d_day else str(d_day)
    event_line = (
        f"- {name} | {event.get('place') or '장소 미상'} | "
        f"{event.get('start_date')}~{event.get('end_date')} ({event.get('day_count') or 1}일) | "
        f"매장에서 {event.get('distance_km')}km | "
        f"{'진행 중' if event.get('ongoing') else f'D-{d_day_text}'} | 출처 {event.get('source') or '미상'}"
    )
    other_lines = "\n".join(
        f"- {e.get('name')} | {e.get('start_date')}~{e.get('end_date')} | {e.get('distance_km')}km"
        for e in (others or [])[:4] if e.get("name") != name
    ) or "(없음)"

    # 행사명·장소는 뉴스/블로그에서 뽑아 온 남의 글이다 — 지시문이 섞여 있어도 자료로만 읽히게 감싼다
    plan = _gemini_json(
        _EVENT_PLAN_PROMPT.format(
            store_name=store_name, region=region or "정보 없음", biz_type=biz_type or "카페",
            hours=hours or "정보 없음", today=today, d_day=d_day_text,
            event=quote_untrusted(event_line, max_len=1000),
            others=quote_untrusted(other_lines, max_len=1000),
        ),
        _EVENT_PLAN_SCHEMA,
    )
    if not plan:
        return None

    _plan_cache[cache_key] = (time.time(), plan)
    return plan


def plan_for_store(db, store_id: str, event: dict[str, Any]) -> Optional[dict[str, Any]]:
    """매장 정보(상호·업종·영업시간·지역)를 채워 plan_event_promotion을 부르는 편의 함수."""
    from app.models.ai import StoreProfile
    from app.models.user import User

    user = db.query(User).filter(User.email == store_id).first()
    profile = db.get(StoreProfile, store_id)

    region = ""
    if user and user.store_lat is not None and user.store_lon is not None:
        try:
            region = nearby_cafe_service._region_names(user.store_lat, user.store_lon).get("full", "")
        except Exception:
            region = ""

    hours = ""
    if profile:
        hours = f"{profile.open_hour}~{profile.close_hour}"

    return plan_event_promotion(
        event,
        store_name=(user.store_name or user.name or "내 매장") if user else "내 매장",
        biz_type=(profile.business_type if profile else "") or (getattr(user, "store_biz_type", "") or ""),
        region=region,
        hours=hours,
    )


def event_promo_topic(event: dict[str, Any], plan: Optional[dict[str, Any]] = None) -> str:
    """행사 + 준비 플랜을 홍보 문구 생성기(marketing_service)에 넘길 '홍보 주제' 한 덩어리로.

    준비 플랜에는 이미 이 행사에 걸 이벤트·한정 메뉴·한 줄 홍보 문구가 들어 있다. 그걸 버리고
    "행사 홍보해줘"라고만 시키면 카피라이터가 전혀 다른 이벤트를 지어내, 사장님이 방금 본
    플랜과 어긋난 홍보물이 나온다. 그래서 플랜의 알맹이를 그대로 재료로 넘긴다.

    행사 이름·장소는 뉴스·블로그에서 긁어 온 남의 글이다 — 이 문자열을 프롬프트에 넣는 쪽
    (generate_promotion_copy)에서 사장님 요청 칸에 들어가므로, 여기서는 길이만 제한하고
    지시문처럼 보이는 문장을 만들지 않는다.
    """
    plan = plan or {}
    name = (event.get("name") or "").strip()[:80]
    place = (event.get("place") or event.get("host") or "").strip()[:60]
    period = f"{event.get('start_date') or ''}~{event.get('end_date') or ''}".strip("~")

    parts = [f"매장 근처에서 열리는 행사 '{name}' 기간에 맞춘 홍보"]
    if period:
        parts.append(f"행사 기간 {period}")
    if place:
        parts.append(f"장소 {place}")
    if event.get("distance_km") is not None:
        parts.append(f"매장에서 {event['distance_km']}km")

    promo = (plan.get("promotions") or [{}])[0]
    if promo.get("title"):
        parts.append(f"진행할 이벤트: {promo['title']} — {(promo.get('detail') or '')[:60]}")
    if plan.get("menu_idea"):
        parts.append(f"행사 기간 한정 메뉴: {plan['menu_idea'][:50]}")
    if plan.get("busy_window"):
        parts.append(f"특히 붐빌 때: {plan['busy_window'][:30]}")
    if plan.get("promo_copy"):
        parts.append(f"사장님이 쓰려던 문구: {plan['promo_copy'][:60]}")

    # 관광객·행사 참여자를 향한 홍보라는 점은 카피의 톤을 크게 바꾼다 (단골 대상 홍보와 다르다)
    parts.append("행사에 온 방문객이 우리 매장으로 들르게 만드는 것이 목표")
    return " / ".join(parts)[:900]


def plan_summary_line(plan: dict[str, Any]) -> str:
    """푸시 본문 한 줄 — 열기 전에 이미 '무엇을 하면 되는지'가 보이게 한다."""
    promo = (plan.get("promotions") or [{}])[0]
    parts = [p for p in (plan.get("headline"), promo.get("title") and f"제안: {promo['title']}") if p]
    first_action = (plan.get("prep_actions") or [None])[0]
    if first_action and len(" · ".join(parts)) < 45:
        parts.append(first_action)
    return " · ".join(parts)


def store_point(db, store_id: str) -> Optional[tuple[float, float]]:
    """매장 고정 위치 (없으면 None) — 감시는 기기 GPS가 아니라 등록된 매장 좌표만 쓴다."""
    from app.models.user import User

    user = db.query(User).filter(User.email == store_id).first()
    if user and user.store_lat is not None and user.store_lon is not None:
        return float(user.store_lat), float(user.store_lon)
    return None


def store_name_of(db, store_id: str) -> str:
    from app.models.user import User

    user = db.query(User).filter(User.email == store_id).first()
    if not user:
        return ""
    return user.store_name or user.name or ""


__all__ = [
    "scan_cafe_changes", "scan_if_stale", "recent_changes", "mark_notified",
    "pick_alert_events", "plan_event_promotion", "plan_for_store", "plan_summary_line",
    "store_point", "store_name_of",
]
