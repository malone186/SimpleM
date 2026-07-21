"""매장 IoT 센서 라이브 시뮬레이터 (백엔드 B)

발주 화면 '현재 사용 중인 원두' 카드의 LIVE 연동을 실제 데이터로 구동한다.

구성 컨셉 (실물 센서 도입 시 이 서비스의 값 소스만 하드웨어로 교체하면 됨):
- 원두 호퍼 잔량   : 로드셀(무게센서)  → 지금은 오늘 Sale 테이블의 실제 판매 잔 수 × 샷당 g으로 환산
- 원두 종류 인식   : RFID 태그        → 매장별 태그명 메모리 저장 (수정 모달에서 재지정)
- 추출 상태        : 머신 전류센서    → 최근 판매 시각 기반 시뮬레이션
- 우유 잔량        : 로드셀           → 라떼류 판매 잔 수 × 1잔당 우유 사용량
- 냉장고 온도      : 온도센서         → 시간 기반 사인파 시뮬레이션 (정상 범위 2~5℃)
- 정수 탱크        : 수위센서         → 3시간 보충 주기 시뮬레이션

DB(공유 PC)가 꺼져 있어도 화면이 죽지 않도록 전 구간 시간 기반 폴백을 가진다.
AI 추천은 Gemini 호출 없이 판매 데이터 규칙 기반으로 계산한다 (쿼터 소모 0).
"""

import hashlib
import logging
import math
from datetime import datetime, timedelta, timezone
from typing import Any

logger = logging.getLogger(__name__)

KST = timezone(timedelta(hours=9))

# ─── 장비 스펙 상수 (실물 도입 시 캘리브레이션 값) ─────────────────────────
HOPPER_CAPACITY_G = 2000.0        # 호퍼 만충 용량 (2kg)
GRAMS_PER_SHOT_CAF = 18.0         # 카페인 1샷 도징량
GRAMS_PER_SHOT_DECAF = 19.0       # 디카페인은 분쇄도 차이로 살짝 많이 씀
MILK_CAPACITY_ML = 6000.0         # 우유 디스펜서 용량 (6L)
MILK_PER_DRINK_ML = 200.0         # 라떼류 1잔당 우유 사용량
OPEN_HOUR, CLOSE_HOUR = 8, 22     # 영업시간 (센서 활동 구간)

# 메뉴명 분류 키워드
_COFFEE_KEYWORDS = ("아메리카노", "라떼", "라테", "카푸치노", "에스프레소", "콜드브루",
                    "모카", "마키아토", "플랫", "커피", "아인슈페너", "돌체")
# '라떼'가 들어가도 원두를 안 쓰는 논커피 음료 (우유는 소모함)
_NON_COFFEE_FLAVORS = ("딸기", "고구마", "초코", "녹차", "말차", "곡물", "미숫", "홍차",
                       "밀크티", "유자", "자몽", "레몬", "청포도", "복숭아", "바나나")
# 이 단어가 있으면 논커피 향미가 섞여도 확실히 커피 (예: 카페모카)
_STRONG_COFFEE = ("아메리카노", "에스프레소", "콜드브루", "커피", "모카", "마키아토", "아인슈페너")
_MILK_KEYWORDS = ("라떼", "라테", "카푸치노", "모카", "마키아토", "플랫", "돌체", "밀크")
_DECAF_KEYWORDS = ("디카페인", "디카프", "decaf")

# 매장별 RFID 태그 상태 (실물에선 리더기가 채워줌) — 서버 메모리 보관
_rfid_state: dict[str, dict[str, str]] = {}


# ─── 내부 유틸 ─────────────────────────────────────────────────────────────

def _now() -> datetime:
    return datetime.now(KST)


def _stable_noise(seed: str, scale: float = 1.0) -> float:
    """폴링 때마다 널뛰지 않는 결정론적 노이즈 (-scale ~ +scale)"""
    h = int(hashlib.md5(seed.encode()).hexdigest()[:8], 16)
    return ((h % 2000) / 1000.0 - 1.0) * scale


def _is_coffee(name: str) -> bool:
    if any(k in name for k in _STRONG_COFFEE):
        return True
    if any(k in name for k in _NON_COFFEE_FLAVORS):
        return False  # 딸기라떼·녹차라떼 등은 에스프레소 샷을 안 씀
    return any(k in name for k in _COFFEE_KEYWORDS)


def _is_decaf(name: str) -> bool:
    low = name.lower()
    return any(k in low for k in _DECAF_KEYWORDS)


def _uses_milk(name: str) -> bool:
    return any(k in name for k in _MILK_KEYWORDS)


def _sim_cumulative_shots(now: datetime, daily_total: int) -> int:
    """DB 폴백용: 오전·점심 더블 피크 곡선으로 현재 시각까지의 누적 잔 수 근사"""
    minutes = now.hour * 60 + now.minute
    open_m, close_m = OPEN_HOUR * 60, CLOSE_HOUR * 60
    if minutes <= open_m:
        return 0
    if minutes >= close_m:
        return daily_total
    # 두 피크(9시, 13시)의 누적 분포를 단순 합성
    t = (minutes - open_m) / (close_m - open_m)  # 0~1
    curve = 0.5 * (1 - math.cos(math.pi * min(1.0, t * 1.35)))  # 오전에 가파른 S커브
    return int(daily_total * curve)


# ─── 판매 데이터 집계 ──────────────────────────────────────────────────────

def _query_today_sales(store_id: str) -> dict[str, Any] | None:
    """오늘(KST) 판매를 메뉴명 기준으로 카페인샷/디카페인샷/우유잔/최근판매로 집계.
    DB 접속 실패 시 None → 호출부가 시뮬레이션 폴백."""
    try:
        from app.models.inventory import Menu, Sale
        from app.services.ai.document_service import _session

        day_start = _now().replace(hour=0, minute=0, second=0, microsecond=0)
        with _session() as db:
            rows = (
                db.query(Sale, Menu.name)
                .join(Menu, Sale.menu_id == Menu.id)
                .filter(Sale.store_id == store_id, Sale.sold_at >= day_start)
                .order_by(Sale.sold_at.desc())
                .all()
            )
        caf = decaf = milk = 0
        last_menu, last_at = None, None
        for sale, menu_name in rows:
            qty = sale.quantity or 1
            # 우유는 논커피 라떼(딸기라떼 등)도 소모하므로 커피 여부와 무관하게 집계
            if _uses_milk(menu_name):
                milk += qty
            if not _is_coffee(menu_name):
                continue
            if _is_decaf(menu_name):
                decaf += qty
            else:
                caf += qty
            if last_menu is None:
                last_menu, last_at = menu_name, sale.sold_at
        return {"caffeine_shots": caf, "decaf_shots": decaf, "milk_drinks": milk,
                "last_menu": last_menu, "last_at": last_at}
    except Exception:
        logger.warning("센서 집계용 판매 조회 실패 — 시뮬레이션 폴백", exc_info=True)
        return None


def _query_daily_history(store_id: str, days: int = 7) -> list[dict[str, Any]]:
    """최근 N일 일자별 커피 잔 수·디카페인 잔 수·매출 (AI 추천 근거용). 실패 시 빈 리스트."""
    try:
        from app.models.inventory import Menu, Sale
        from app.services.ai.document_service import _session

        since = (_now() - timedelta(days=days)).replace(hour=0, minute=0, second=0, microsecond=0)
        with _session() as db:
            rows = (
                db.query(Sale.sold_at, Sale.quantity, Sale.total_price, Menu.name)
                .join(Menu, Sale.menu_id == Menu.id)
                .filter(Sale.store_id == store_id, Sale.sold_at >= since)
                .all()
            )
        by_day: dict[str, dict[str, Any]] = {}
        for sold_at, qty, total, menu_name in rows:
            d = sold_at.astimezone(KST) if sold_at.tzinfo else sold_at
            key = d.strftime("%Y-%m-%d")
            rec = by_day.setdefault(key, {"date": key, "weekday": d.weekday(),
                                          "coffee": 0, "decaf": 0, "revenue": 0})
            rec["revenue"] += total or 0
            if _is_coffee(menu_name):
                q = qty or 1
                if _is_decaf(menu_name):
                    rec["decaf"] += q
                else:
                    rec["coffee"] += q
        return sorted(by_day.values(), key=lambda r: r["date"])
    except Exception:
        logger.warning("센서 추천용 판매 이력 조회 실패", exc_info=True)
        return []


# ─── 라이브 스냅샷 ─────────────────────────────────────────────────────────

def get_live_snapshot(store_id: str) -> dict[str, Any]:
    """센서 대시보드 한 번의 폴링에 필요한 전체 상태를 반환한다."""
    now = _now()
    in_business = OPEN_HOUR <= now.hour < CLOSE_HOUR

    sales = _query_today_sales(store_id)
    simulated = sales is None
    if simulated:
        caf_shots = _sim_cumulative_shots(now, 180)
        decaf_shots = _sim_cumulative_shots(now, 42)
        milk_drinks = _sim_cumulative_shots(now, 95)
        last_menu, last_at = ("아이스 아메리카노", now - timedelta(minutes=3)) if in_business else (None, None)
    else:
        caf_shots = sales["caffeine_shots"]
        decaf_shots = sales["decaf_shots"]
        milk_drinks = sales["milk_drinks"]
        last_menu, last_at = sales["last_menu"], sales["last_at"]

    def hopper(shots: int, grams_per_shot: float, day_start_fill: float, kind: str) -> dict[str, Any]:
        used = shots * grams_per_shot
        refill_cycle = HOPPER_CAPACITY_G * 0.9  # 10% 남으면 직원이 재장전했다고 간주
        refills = int(used // refill_cycle) if day_start_fill <= used else 0
        remaining = max(120.0, day_start_fill - (used - refills * refill_cycle))
        remaining = min(remaining, HOPPER_CAPACITY_G)
        percent = round(remaining / HOPPER_CAPACITY_G * 100)
        # 최근 2시간 소진 속도로 소진 예상 시각 계산 (판매 페이스 = 오늘 누적/영업경과시간 근사)
        elapsed_h = max(0.5, (now.hour + now.minute / 60) - OPEN_HOUR) if in_business else None
        depletion_at = None
        if elapsed_h and shots > 0:
            rate_g_per_h = (shots / elapsed_h) * grams_per_shot
            if rate_g_per_h > 1:
                hours_left = remaining / rate_g_per_h
                dep = now + timedelta(hours=hours_left)
                if dep.date() == now.date():
                    depletion_at = dep.strftime("%H:%M")
        return {
            "kind": kind,
            "remaining_g": round(remaining),
            "capacity_g": int(HOPPER_CAPACITY_G),
            "percent": percent,
            "shots_today": shots,
            "grams_per_shot": grams_per_shot,
            "refills_today": refills,
            "depletion_at": depletion_at,   # 오늘 안에 소진 예상 시 "HH:MM", 아니면 None
        }

    caf_hopper = hopper(caf_shots, GRAMS_PER_SHOT_CAF, HOPPER_CAPACITY_G, "caffeine")
    decaf_hopper = hopper(decaf_shots, GRAMS_PER_SHOT_DECAF, HOPPER_CAPACITY_G * 0.7, "decaf")

    # 우유 (라떼류 잔 수 기반 소모, 소진되면 새 팩 보충 사이클)
    milk_used = milk_drinks * MILK_PER_DRINK_ML
    milk_cycle = MILK_CAPACITY_ML * 0.92
    milk_remaining = max(300.0, MILK_CAPACITY_ML - (milk_used % milk_cycle))
    milk = {
        "remaining_ml": round(milk_remaining),
        "capacity_ml": int(MILK_CAPACITY_ML),
        "percent": round(milk_remaining / MILK_CAPACITY_ML * 100),
        "drinks_today": milk_drinks,
    }

    # 냉장고 온도: 2~5℃ 사이 완만한 사인파 + 매장별 결정론적 노이즈
    minute_of_day = now.hour * 60 + now.minute
    temp = 3.2 + 1.0 * math.sin(minute_of_day / 47.0) + _stable_noise(f"{store_id}:{now.hour}", 0.4)
    fridge = {"temp_c": round(temp, 1), "ok": temp < 7.0}

    # 정수 탱크: 3시간 주기 보충 사이클
    cycle_min = (minute_of_day % 180)
    water_percent = max(15, round(100 - cycle_min / 180 * 70))
    water = {"percent": water_percent, "ok": water_percent > 20}

    # 머신 상태: 최근 판매가 5분 이내면 주기적으로 '추출 중' 연출
    extracting = False
    if in_business and last_at is not None:
        last = last_at.astimezone(KST) if getattr(last_at, "tzinfo", None) else last_at
        recent = (now - last) < timedelta(minutes=30)
        extracting = recent and (int(now.timestamp()) % 37) < 9
    machine = {
        "status": "extracting" if extracting else ("idle" if in_business else "off"),
        "current_menu": last_menu if extracting else None,
        "last_menu": last_menu,
    }

    # RFID 태그 (수정 모달에서 재지정된 원두명)
    tags = _rfid_state.get(store_id, {})

    # 틱커 이벤트 피드 (프론트 전광판용)
    events: list[str] = []
    if extracting and last_menu:
        events.append(f"☕ [추출 중] {last_menu} — 머신 전류센서 감지")
    elif last_menu:
        events.append(f"☕ [방금 전] {last_menu} 판매 · 오늘 {caf_shots + decaf_shots}잔째")
    events.append(f"⚖️ [로드셀] 카페인 호퍼 {caf_hopper['percent']}% ({caf_hopper['remaining_g'] / 1000:.1f}kg) 남음")
    events.append(f"🌿 [로드셀] 디카페인 호퍼 {decaf_hopper['percent']}% · 오늘 {decaf_shots}잔 추출")
    events.append(f"🥛 [우유] {milk['percent']}% ({milk_remaining / 1000:.1f}L) · 냉장 {fridge['temp_c']}℃ 정상")
    if caf_hopper["refills_today"]:
        events.append(f"🔄 [RFID] 오늘 카페인 호퍼 재장전 {caf_hopper['refills_today']}회 감지")
    if caf_hopper["depletion_at"]:
        events.append(f"⏳ [예측] 현재 페이스면 카페인 호퍼 {caf_hopper['depletion_at']}경 재장전 필요")

    return {
        "updated_at": now.isoformat(),
        "store_id": store_id,
        "simulated": simulated,          # True면 DB 폴백(시뮬레이션) 모드
        "in_business": in_business,
        "hoppers": {"caffeine": caf_hopper, "decaf": decaf_hopper},
        "machine": machine,
        "milk": milk,
        "fridge": fridge,
        "water": water,
        "rfid": {
            "caffeine_bean": tags.get("caffeine") or None,
            "decaf_bean": tags.get("decaf") or None,
            "caffeine_tag": f"RFID-{hashlib.md5((store_id + 'c').encode()).hexdigest()[:4].upper()}",
            "decaf_tag": f"RFID-{hashlib.md5((store_id + 'd').encode()).hexdigest()[:4].upper()}",
        },
        "events": events,
    }


def set_bean_tags(store_id: str, caffeine: str | None, decaf: str | None) -> dict[str, str]:
    """수정 모달에서 원두명을 바꾸면 RFID 태그에 재기록하는 컨셉의 저장 API."""
    tags = _rfid_state.setdefault(store_id, {})
    if caffeine is not None:
        tags["caffeine"] = caffeine.strip()
    if decaf is not None:
        tags["decaf"] = decaf.strip()
    return dict(tags)


# ─── AI 발주 코치 (규칙 기반 — LLM 호출 없음) ──────────────────────────────

_WEEKDAY_KO = ["월", "화", "수", "목", "금", "토", "일"]


def get_recommendations(store_id: str) -> dict[str, Any]:
    """센서 상태 + 최근 7일 판매 데이터를 근거로 사장님이 바로 실행할 수 있는
    발주·운영 추천을 만든다. 각 항목은 [근거 수치 → 제안 액션] 구조."""
    now = _now()
    snap = get_live_snapshot(store_id)
    history = _query_daily_history(store_id, days=8)
    today_key = now.strftime("%Y-%m-%d")
    past = [h for h in history if h["date"] != today_key]
    today_rec = next((h for h in history if h["date"] == today_key), None)

    items: list[dict[str, Any]] = []

    def add(priority: str, title: str, reason: str, action: str, source: str):
        items.append({"priority": priority, "title": title, "reason": reason,
                      "action": action, "source": source})

    caf = snap["hoppers"]["caffeine"]
    decaf = snap["hoppers"]["decaf"]

    # 1) 호퍼 소진 임박 (센서 근거)
    if caf["depletion_at"]:
        add("urgent", f"카페인 호퍼 {caf['depletion_at']}경 소진 예상",
            f"현재 잔량 {caf['remaining_g'] / 1000:.1f}kg, 오늘 {caf['shots_today']}잔 페이스 유지 시 "
            f"영업 중 재장전이 필요해요.",
            "피크 전 여유 시간에 호퍼를 미리 재장전해 두세요.",
            "무게센서·판매 페이스")
    elif caf["percent"] <= 30:
        add("warn", "카페인 호퍼 잔량 30% 이하",
            f"로드셀 기준 {caf['remaining_g']}g 남음 (약 {int(caf['remaining_g'] // caf['grams_per_shot'])}잔 분량).",
            "다음 한가한 시간대에 재장전하세요.", "무게센서")

    # 2) 원두 발주량 (7일 사용량 근거)
    if past:
        avg_daily_shots = sum(h["coffee"] for h in past) / len(past)
        weekly_g = avg_daily_shots * GRAMS_PER_SHOT_CAF * 7
        if weekly_g > 0:
            add("info", f"주간 원두 사용량 약 {weekly_g / 1000:.1f}kg",
                f"최근 {len(past)}일 하루 평균 {avg_daily_shots:.0f}잔 × 샷당 {GRAMS_PER_SHOT_CAF:.0f}g 기준이에요.",
                f"다음 발주는 여유분 포함 {math.ceil(weekly_g / 1000) + 1}kg 수준을 추천해요.",
                "판매 데이터 7일")

    # 3) 주말 대비 (목·금에만 노출)
    if past and now.weekday() in (3, 4):
        weekend = [h for h in past if h["weekday"] >= 5]
        weekday_ = [h for h in past if h["weekday"] < 5]
        if weekend and weekday_:
            w_avg = sum(h["coffee"] for h in weekend) / len(weekend)
            d_avg = max(1.0, sum(h["coffee"] for h in weekday_) / len(weekday_))
            if w_avg > d_avg * 1.1:
                extra_kg = (w_avg - d_avg) * 2 * GRAMS_PER_SHOT_CAF / 1000
                add("warn", "주말 피크 대비 원두 추가 확보",
                    f"최근 주말 하루 평균 {w_avg:.0f}잔으로 평일({d_avg:.0f}잔)보다 "
                    f"{(w_avg / d_avg - 1) * 100:.0f}% 많이 나갔어요.",
                    f"주말 이틀 기준 여유분 약 {max(0.5, extra_kg):.1f}kg을 미리 확보해 두세요.",
                    "판매 데이터 주말 패턴")

    # 4) 디카페인 수요 추세
    if past:
        past_coffee = sum(h["coffee"] + h["decaf"] for h in past)
        past_decaf_ratio = (sum(h["decaf"] for h in past) / past_coffee) if past_coffee else 0
        today_total = (today_rec["coffee"] + today_rec["decaf"]) if today_rec else 0
        today_ratio = (today_rec["decaf"] / today_total) if today_rec and today_total >= 10 else None
        if today_ratio is not None and past_decaf_ratio > 0 and today_ratio > past_decaf_ratio * 1.25:
            add("warn", "디카페인 주문 비중 상승 중",
                f"오늘 디카페인 비중 {today_ratio * 100:.0f}%로 최근 평균({past_decaf_ratio * 100:.0f}%)보다 높아요. "
                f"호퍼 잔량은 {decaf['percent']}%예요.",
                "다음 발주에 디카페인 원두를 한 팩 추가해 두면 안전해요.",
                "판매 데이터·무게센서")

    # 5) 우유 잔량 (라떼류 페이스)
    milk = snap["milk"]
    if milk["percent"] <= 25:
        add("urgent", "우유 잔량 25% 이하",
            f"로드셀 기준 {milk['remaining_ml'] / 1000:.1f}L 남음, 오늘 라떼류 {milk['drinks_today']}잔 소모.",
            "냉장고 예비 우유를 디스펜서에 보충하세요.", "무게센서")

    # 6) 설비 이상 (온도·수위)
    if not snap["fridge"]["ok"]:
        add("urgent", f"냉장고 온도 {snap['fridge']['temp_c']}℃ — 보관 한계 초과",
            "우유·유제품 안전 보관 기준(7℃)을 넘었어요.",
            "냉장고 문 밀폐와 성에를 점검하세요.", "온도센서")
    if not snap["water"]["ok"]:
        add("warn", "정수 탱크 수위 낮음",
            f"수위센서 기준 {snap['water']['percent']}%.", "정수 필터 라인을 확인하세요.", "수위센서")

    # 7) 오늘 페이스 비교 (지난주 같은 요일)
    if today_rec and past:
        same_dow = [h for h in past if h["weekday"] == now.weekday()]
        if same_dow:
            base = max(1, same_dow[-1]["coffee"] + same_dow[-1]["decaf"])
            cur = today_rec["coffee"] + today_rec["decaf"]
            diff = (cur / base - 1) * 100
            trend = "빠른" if diff >= 0 else "느린"
            add("info", f"오늘 판매 페이스: 지난주 {_WEEKDAY_KO[now.weekday()]}요일 대비 {diff:+.0f}%",
                f"오늘 현재 {cur}잔 / 지난주 같은 요일 하루 {base}잔. 평소보다 {trend} 흐름이에요.",
                "페이스가 +20%를 넘으면 원두·우유 소진이 하루 일찍 올 수 있어요.",
                "판매 데이터")

    if not items:
        add("info", "재고·설비 흐름 안정",
            "센서와 판매 데이터 모두 정상 범위예요.", "현재 운영을 유지하시면 됩니다.", "종합")

    order = {"urgent": 0, "warn": 1, "info": 2}
    items.sort(key=lambda x: order.get(x["priority"], 3))
    return {
        "generated_at": now.isoformat(),
        "simulated": snap["simulated"],
        "items": items[:4],
    }
