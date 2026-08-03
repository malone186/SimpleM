"""매장 주변 행사 조회·대비 조언 (백엔드 B) — 매장 지도 화면의 '주변 행사' 섹션

행사 수집 자체는 새로 만들지 않는다. 예측(forecast_service)이 매출 보정을 위해 이미
세 소스에서 모으고 있고, 그 결과가 곧 "매장 반경 3km 안에서 곧 열리는 행사"다.
  · 한국관광공사 TourAPI (전국 축제, TOUR_API_KEY 있을 때)
  · 서울 열린데이터광장 문화행사 (서울 매장 한정, 키 없이도 샘플 동작)
  · 네이버 뉴스·블로그 검색 + Gemini 정리 (전국 — 공공 API가 놓치는 팝업·플리마켓)

다만 예측은 '날짜별 보정 행'이 필요해서 3일짜리 축제가 3줄로 들어온다. 화면은 반대로
'행사 하나 = 카드 하나'여야 하므로 여기서 같은 행사를 묶어 기간·거리·예상 영향으로 정리하고,
Gemini에게 "이 행사들에 우리 카페가 뭘 준비해야 하나"를 한 번에 물어 조언을 붙인다.
(Gemini 호출은 행사 건수와 무관하게 1회 — 팀 공유 키의 쿼터를 아낀다. 결과는 6시간 캐시.)

키가 없거나 수집이 실패해도 화면은 뜬다 — 행사 0건, 조언 없음으로 내려간다.
"""

import logging
import re
import time
from datetime import date, datetime
from typing import Any, Optional

from app.services.ai import forecast_service
from app.services.ai.nearby_cafe_service import _gemini_json
from app.services.ai.untrusted import quote_untrusted

logger = logging.getLogger(__name__)

DEFAULT_DAYS = 14        # 지도 화면 기본 조회 기간 — 2주면 "이번 주말 축제"가 다 들어온다
MAX_DAYS = 30
_INSIGHT_TTL = 6 * 3600  # 행사 목록 자체가 6시간 캐시(forecast_service)라 조언도 같은 주기

_insight_cache: dict[str, tuple[float, dict[str, Any]]] = {}


def _norm(text: str) -> str:
    """중복 판정용 — 소스마다 띄어쓰기가 달라 공백을 없애고 비교한다."""
    return re.sub(r"\s+", "", text or "")


def _dist_for_sort(v: Optional[float]) -> float:
    """비교·정렬용 거리 — 미상(None)만 맨 뒤로 보낸다.

    0.0km(반올림 전 50m 이내)는 실제로 '가장 가까움'이므로 falsy 취급하면 안 된다.
    """
    return 99.0 if v is None else v


# ---------------------------------------------------------------------------
# 1) 수집 결과를 '행사 단위'로 묶기
# ---------------------------------------------------------------------------

def find_nearby_events(lat: float, lon: float, days: int = DEFAULT_DAYS) -> dict[str, Any]:
    """오늘부터 days일 안에 매장 반경에서 열리는 행사 목록 (시작일 → 거리순).

    반환: {"today", "days", "radius_km", "count", "events": [...]}
    행사 하나: {name, place, source, start_date, end_date, dates, day_count,
               distance_km, lat, lon, boost_pct, d_day, ongoing}
      · d_day  : 시작까지 남은 일수 (0 = 오늘 시작/진행 중)
      · ongoing: 오늘 열리고 있는지
    """
    days = max(1, min(days, MAX_DAYS))
    today = datetime.now(forecast_service.KST).date()

    try:
        rows = forecast_service._fetch_nearby_events(lat, lon, today, days)
    except Exception:
        # 수집이 통째로 실패해도 지도 화면은 떠야 한다 (행사 0건으로)
        logger.warning("주변 행사 수집 실패 — 행사 없이 계속", exc_info=True)
        rows = []

    grouped: dict[tuple[str, str], dict[str, Any]] = {}
    for row in rows:
        name = (row.get("name") or "").strip()
        if not name:
            continue
        day_iso = row.get("date") or ""
        # 묶는 기준은 '이름'만이다. 같은 축제라도 소스마다 장소 표기가 달라
        # (예: "DDP 어울림광장" vs "동대문디자인플라자(DDP)") 장소까지 키에 넣으면
        # 같은 행사가 카드 두 장으로 갈라지고 기간도 쪼개진다.
        key = (_norm(name), "")
        ev = grouped.get(key)
        if ev is None:
            grouped[key] = {
                "name": name,
                "place": (row.get("place") or "").strip(),
                "source": row.get("source") or "",
                "dates": [day_iso] if day_iso else [],
                "distance_km": row.get("distance_km"),
                "lat": row.get("lat"),
                "lon": row.get("lon"),
                "boost_pct": row.get("boost_pct") or 0,
            }
            continue
        if day_iso and day_iso not in ev["dates"]:
            ev["dates"].append(day_iso)
        # 같은 행사가 여러 소스로 들어오면 더 가까운 좌표·장소·더 큰 부스팅을 남긴다
        if _dist_for_sort(row.get("distance_km")) < _dist_for_sort(ev["distance_km"]):
            ev["distance_km"] = row.get("distance_km")
            ev["lat"], ev["lon"] = row.get("lat"), row.get("lon")
            if (row.get("place") or "").strip():
                ev["place"] = row["place"].strip()
        ev["boost_pct"] = max(ev["boost_pct"], row.get("boost_pct") or 0)

    events: list[dict[str, Any]] = []
    for ev in grouped.values():
        ev["dates"].sort()
        if not ev["dates"]:
            continue
        start, end = ev["dates"][0], ev["dates"][-1]
        ev["start_date"], ev["end_date"] = start, end
        ev["day_count"] = len(ev["dates"])
        try:
            ev["d_day"] = (date.fromisoformat(start) - today).days
        except ValueError:
            ev["d_day"] = 0
        ev["ongoing"] = start <= today.isoformat() <= end
        events.append(ev)

    # 가까운 날짜부터, 같은 날이면 가까운 행사부터 (사장님이 대비할 순서 그대로)
    events.sort(key=lambda e: (e["start_date"], _dist_for_sort(e["distance_km"])))

    return {
        "today": today.isoformat(),
        "days": days,
        "radius_km": forecast_service.EVENT_RADIUS_KM,
        "count": len(events),
        "events": events,
    }


# ---------------------------------------------------------------------------
# 2) Gemini 조언 — "이 행사에 뭘 준비할까"
# ---------------------------------------------------------------------------

_EVENT_INSIGHT_SCHEMA = {
    "type": "object",
    "properties": {
        "headline": {"type": "string"},
        "impact_level": {"type": "string"},
        "summary": {"type": "string"},
        "peak_days": {"type": "array", "items": {"type": "string"}},
        "actions": {"type": "array", "items": {"type": "string"}},
        "event_tips": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"name": {"type": "string"}, "tip": {"type": "string"}},
                "required": ["name", "tip"],
            },
        },
    },
    "required": ["headline", "impact_level", "summary", "peak_days", "actions", "event_tips"],
}

_EVENT_INSIGHT_PROMPT = """너는 카페 사장님을 돕는 상권 분석가다.
아래는 내 매장 반경 {radius_km}km 안에서 앞으로 {days}일 안에 열리는 행사 목록이다.
행사로 손님이 얼마나 늘지, 그래서 무엇을 미리 준비해야 하는지를 한국어로 정리하라.

[내 매장]
상호: {store_name}
위치: {region}
업종/상권: {biz_type}
오늘: {today}

[주변 행사 {count}건]
{events}

[작성 규칙] 사장님은 바쁘다. 짧게, 실행할 수 있게 쓴다. 근거 없는 추측은 빼라.
행사 이름은 아래 목록에 있는 그대로 쓴다(새로 지어내지 않는다).

- headline: 이 기간을 한 문장으로 (30자 이내, 예: "주말 축제로 오후 손님 몰림")
- impact_level: "낮음" / "보통" / "높음" 중 하나 (거리·행사 규모·기간을 함께 본다)
- summary: 언제 어디서 얼마나 붐빌지 두 문장 이내(80자 이내)
- peak_days: 특히 붐빌 날짜 1~3개. "MM-DD(요일)" 형식 (예: "08-02(토)")
- actions: 미리 해 둘 일 3개. **한 항목 30자 이내, 동사로 끝낼 것**
  (예: "주말 우유 2배 발주하기", "오후 2시 알바 1명 추가 배치")
- event_tips: 행사별 대응 한 줄. name은 목록의 행사 이름 그대로, tip은 35자 이내
  (거리가 멀거나 영향이 적으면 tip에 "영향 적음"이라고 솔직히 쓴다)"""


def analyze_nearby_events(lat: float, lon: float, store_name: str = "내 매장",
                          biz_type: str = "", days: int = DEFAULT_DAYS,
                          region: str = "") -> dict[str, Any]:
    """주변 행사 목록 + '무엇을 준비할지' AI 조언 (매장 지도 화면용).

    반환: find_nearby_events 결과 + {"region", "insight": {...}|None}
          각 행사에는 insight의 조언이 "tip" 필드로 붙는다.
    Gemini가 실패하면 insight=None — 목록은 그대로 내려간다.
    """
    found = find_nearby_events(lat, lon, days=days)
    events = found["events"]

    if not region:
        try:
            geo = forecast_service._reverse_geocode(lat, lon)
            region = "" if geo.startswith("위도") else geo
        except Exception:
            region = ""
    found = {**found, "region": region}

    if not events:
        return {**found, "insight": None}

    cache_key = f"{round(lat, 3)},{round(lon, 3)}|{found['days']}|{found['today']}|{store_name}"
    hit = _insight_cache.get(cache_key)
    if hit and time.time() - hit[0] < _INSIGHT_TTL:
        return {**found, "events": _attach_tips(events, hit[1]), "insight": hit[1], "cached": True}

    # 행사 이름·장소는 뉴스/블로그에서 뽑아 온 남의 글이다 — 지시문이 섞여 있어도
    # 자료로만 읽히도록 경계로 감싼다 (untrusted.quote_untrusted).
    lines = "\n".join(
        f"- {e['name']} | {e['place'] or '장소 미상'} | {e['start_date']}~{e['end_date']}"
        f" ({e['day_count']}일) | {e['distance_km']}km | 출처 {e['source']}"
        for e in events[:15]
    )
    insight = _gemini_json(
        _EVENT_INSIGHT_PROMPT.format(
            radius_km=found["radius_km"], days=found["days"], store_name=store_name,
            region=region or "정보 없음", biz_type=biz_type or "미지정",
            today=found["today"], count=len(events),
            events=quote_untrusted(lines, max_len=4000),
        ),
        _EVENT_INSIGHT_SCHEMA,
    )
    if not insight:
        return {**found, "insight": None}

    _insight_cache[cache_key] = (time.time(), insight)
    return {**found, "events": _attach_tips(events, insight), "insight": insight}


def _attach_tips(events: list[dict[str, Any]], insight: Optional[dict[str, Any]]) -> list[dict[str, Any]]:
    """AI가 준 행사별 한 줄 조언을 이름으로 맞춰 각 행사에 붙인다 (못 찾으면 그냥 없음)."""
    tips = {_norm(t.get("name", "")): (t.get("tip") or "").strip()
            for t in (insight or {}).get("event_tips", []) if isinstance(t, dict)}
    if not tips:
        return events
    return [{**e, "tip": tips.get(_norm(e["name"]), "")} for e in events]
