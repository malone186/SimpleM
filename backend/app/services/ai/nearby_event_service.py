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

import hashlib
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


# 이름 맨 앞의 주최기관 대괄호 — "[마포구립서강도서관] 8월/청년 Book C클래스"의 앞부분
_HOST_PREFIX = re.compile(r"^\s*[\[(<【]\s*([^\]\)>】]{2,30}?)\s*[\])>】]\s*")
# "8월/", "8월 " 같은 월 표기 접두사 — 기간은 따로 보여주므로 이름에 있을 필요가 없다
_MONTH_PREFIX = re.compile(r"^\s*\d{1,2}\s*월\s*[/·\-]?\s*")
# 잘린 꼬리에 남는 매달린 기호 — 반드시 뒤쪽만 깎는다. 양쪽을 깎으면 "[동굴로]"의
# 여는 괄호까지 사라져 "동굴로]"가 된다(실제로 그렇게 나왔다).
_DANGLING_TAIL = " \t-–—~/,·|:;(<[【&+"
_DANGLING_HEAD = " \t-–—~/,·|:;&+"
# 화면·알림 제목에 들어갈 최대 길이. 이보다 길면 단어 경계에서 자르고 말줄임을 붙인다.
DISPLAY_LIMIT = 34


def clean_event_name(raw: str) -> tuple[str, str]:
    """행사 제목을 사람이 읽을 이름으로 다듬는다. 반환: (이름, 주최기관)

    수집원이 네이버 뉴스·블로그 글 제목이라 "[마포구립서강도서관] 8월/청년 Book C클래스
    [떠나고, 쓰다 -" 같은 모양으로 들어온다. 이대로 두면 알림 제목과 지도 카드에 그대로
    나가서 무슨 행사인지 읽히지 않는다.

      · 맨 앞 대괄호(주최기관)는 떼어 host로 돌려준다 — 버리지 않는다(화면에서 따로 쓸 수 있게)
      · "8월/" 같은 월 표기는 뗀다 (기간은 카드에 이미 있다)
      · 닫히지 않은 괄호가 남으면(잘린 흔적) 그 앞까지만 쓴다
      · 매달린 기호(- ~ , 등)로 끝나면 지운다

    다듬은 결과가 너무 짧아지면(2자 미만) 원본을 그대로 쓴다 — 이름을 잃는 것보다 낫다.
    """
    text = (raw or "").strip()
    if not text:
        return "", ""

    host = ""
    m = _HOST_PREFIX.match(text)
    # 대괄호를 뗀 뒤에도 이름이 남을 때만 뗀다 ("[동굴로]"처럼 그것 자체가 이름이면 유지)
    if m and len(text[m.end():].strip()) >= 4:
        host = m.group(1).strip()
        text = text[m.end():]

    text = _MONTH_PREFIX.sub("", text)

    # 열린 괄호가 닫히지 않았다면 잘린 것이다 — 그 앞까지만 남긴다
    for open_ch, close_ch in (("[", "]"), ("(", ")"), ("【", "】"), ("<", ">")):
        pos = text.rfind(open_ch)
        if pos > 0 and close_ch not in text[pos:]:
            text = text[:pos]

    text = re.sub(r"\s+", " ", text).lstrip(_DANGLING_HEAD).rstrip(_DANGLING_TAIL).strip()
    if len(text) < 2:
        return (raw or "").strip(), host

    # 너무 길면 말줄임보다 '뒤에 붙은 부제 괄호'를 먼저 뗀다 —
    # "청년 Book C클래스 [떠나고, 쓰다 - 여행 에세이…"보다 "청년 Book C클래스"가 읽힌다.
    # (짧은 이름의 괄호는 이름의 일부이므로 건드리지 않는다: "차슬아 개인전 [동굴로]")
    while len(text) > DISPLAY_LIMIT:
        trimmed = re.sub(r"\s*[\[(【<][^\[(【<]*[\])】>]\s*$", "", text).strip()
        if trimmed == text or len(trimmed) < 2:
            break
        text = trimmed

    # 그래도 길면 단어 경계에서 줄이고 말줄임을 붙인다 — 알림 제목은 D-day와
    # 거리까지 함께 들어가서, 이름이 길면 정작 중요한 뒷부분이 OS에서 잘린다.
    if len(text) > DISPLAY_LIMIT:
        cut = text[:DISPLAY_LIMIT]
        space = cut.rfind(" ")
        text = (cut[:space] if space >= DISPLAY_LIMIT // 2 else cut).rstrip(_DANGLING_TAIL) + "…"
    return text, host


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
        # 다듬은 이름을 여기서부터 쓴다 — 이 함수를 지나면 화면·알림·AI 프롬프트가
        # 전부 같은 이름을 보므로, 정리는 이 한 곳에서만 하면 된다.
        name, host = clean_event_name(row.get("name") or "")
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
                # 주최기관 — 이름에서 뗀 값. 장소가 비었을 때 화면이 대신 쓸 수 있다.
                "host": host,
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

    # 캐시 키에 '지금 목록에 든 행사'를 함께 넣는다. 위치·날짜만으로 잠그면 목록이 바뀐 뒤에도
    # 옛 조언이 그대로 붙어 나온다 — 실제로 화면에 없는 행사를 두고 "8/5(수)가 붐빈다"고
    # 말하는 일이 있었다(수집이 네이버 검색+AI라 호출마다 건수가 흔들린다).
    fingerprint = "~".join(sorted(f"{_norm(e['name'])}:{e['start_date']}" for e in events))
    cache_key = (f"{round(lat, 3)},{round(lon, 3)}|{found['days']}|{found['today']}|{store_name}"
                 f"|{hashlib.md5(fingerprint.encode('utf-8')).hexdigest()[:12]}")
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

    # 키에 행사 지문이 들어가면서 매장당 키가 여러 개 생길 수 있다 — 오래된 것부터 버린다
    if len(_insight_cache) > 500:
        for stale in sorted(_insight_cache, key=lambda k: _insight_cache[k][0])[:100]:
            _insight_cache.pop(stale, None)

    _insight_cache[cache_key] = (time.time(), insight)
    return {**found, "events": _attach_tips(events, insight), "insight": insight}


def _attach_tips(events: list[dict[str, Any]], insight: Optional[dict[str, Any]]) -> list[dict[str, Any]]:
    """AI가 준 행사별 한 줄 조언을 이름으로 맞춰 각 행사에 붙인다 (못 찾으면 그냥 없음)."""
    tips = {_norm(t.get("name", "")): (t.get("tip") or "").strip()
            for t in (insight or {}).get("event_tips", []) if isinstance(t, dict)}
    if not tips:
        return events
    return [{**e, "tip": tips.get(_norm(e["name"]), "")} for e in events]


# ---------------------------------------------------------------------------
# 3) 새벽 프리페치 — 지도 화면이 열리기 전에 캐시를 미리 데워 둔다
# ---------------------------------------------------------------------------

def refresh_all_stores(days: int = DEFAULT_DAYS) -> dict[str, Any]:
    """매장 위치가 등록된 모든 사장님의 주변 행사 캐시를 미리 채운다.

    지도 화면(GET /nearby-events)이 부르는 것과 '같은 인자'로 analyze_nearby_events를
    호출한다 — store_lat/lon + store_name + 기본 days. 그래야 캐시 키가 맞아 화면이
    열릴 때 이미 데워진 캐시(_event_cache 6h + _insight_cache 6h)를 그대로 쓴다.
    첫 열람이 몇 초 걸리던 것을 없애고, 새벽마다 그날의 최신 행사를 미리 확보한다.

    블로킹 호출(네이버·Gemini)이므로 매장을 '순차로' 돈다 — 팀 공유 Gemini 키를
    새벽에 한꺼번에 때리지 않기 위해서다. 한 매장이 실패해도 다음으로 계속한다.
    """
    from app.core.database import SessionLocal
    from app.models.user import User

    db = SessionLocal()
    try:
        stores = (
            db.query(User)
            .filter(User.store_lat.isnot(None), User.store_lon.isnot(None))
            .all()
        )
        # DB 커넥션을 네트워크 대기 동안 붙잡지 않도록 필요한 값만 뽑아 두고 닫는다
        targets = [
            (u.store_lat, u.store_lon,
             u.store_name or u.name or "내 매장",
             u.store_biz_type or "")
            for u in stores
        ]
    finally:
        db.close()

    ok = 0
    for lat, lon, store_name, biz_type in targets:
        try:
            analyze_nearby_events(lat, lon, store_name=store_name,
                                  biz_type=biz_type, days=days)
            ok += 1
        except Exception:
            logger.warning("[행사 프리페치] 매장 '%s' 갱신 실패 — 건너뜀", store_name, exc_info=True)
    logger.info("[행사 프리페치] 매장 %d곳 중 %d곳 캐시 갱신 완료", len(targets), ok)
    return {"stores": len(targets), "refreshed": ok, "failed": len(targets) - ok}


async def nearby_event_refresh_loop() -> None:
    """새벽에 하루 1회, 등록된 모든 매장의 주변 행사 캐시를 미리 채우는 백그라운드 루프.

    NEARBY_EVENT_REFRESH_HOUR (KST, 기본 4시). 음수면 비활성.
    30분마다 깨어나 '설정 시각 이후 + 오늘 아직 안 돌림'이면 1회 실행한다.
    정시(4:00 정각) sleep이 아니라 이 방식인 이유 — 컨테이너가 새벽에 잠들어 있다
    (Cloud Run 스케일-투-제로) 아침에야 깨어나도 그날 첫 기상에서 반드시 한 번 채운다.
    프로세스가 새로 뜨면(재배포·재시작) 메모리 캐시가 비므로, 낮에 떠도 그 즉시 한 번 데운다.
    """
    import asyncio
    import os
    from datetime import datetime

    from app.services.ai import forecast_service

    try:
        hour = int(os.getenv("NEARBY_EVENT_REFRESH_HOUR", "4"))
    except ValueError:
        hour = 4
    if hour < 0:
        logger.info("[행사 프리페치] NEARBY_EVENT_REFRESH_HOUR<0 — 자동 갱신 비활성")
        return

    logger.info("[행사 프리페치] 매일 %d시(KST) 이후 첫 기상에 캐시 갱신", hour)
    last_date: Optional[str] = None
    while True:
        try:
            now = datetime.now(forecast_service.KST)
            today = now.date().isoformat()
            # 설정 시각을 지났고 오늘 아직 안 돌렸으면 1회 (새 프로세스는 last_date=None이라 즉시 한 번)
            if now.hour >= hour and last_date != today:
                await asyncio.to_thread(refresh_all_stores)
                last_date = today
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("[행사 프리페치] 루프 오류 — 다음 주기에 재시도")
        try:
            await asyncio.sleep(1800)  # 30분마다 점검
        except asyncio.CancelledError:
            raise
