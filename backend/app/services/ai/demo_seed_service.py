# -*- coding: utf-8 -*-
"""데모 매장 더미 데이터 자동 갱신 (백엔드 B)

마지막 판매 기록 이후 ~ 현재 시각까지의 판매·근무 스케줄·지출 더미 데이터를
기존 히스토리의 실제 패턴(요일별 판매량, 시간대 분포, 메뉴 비중, 잔수 분포)을
그대로 흉내 내어 생성한다. 대시보드 '오늘 실시간' 그래프가 지금 시각까지 차오른다.

원래 backend/db_seed_recent_sales.py 스크립트였는데, Cloud Run 이미지에는 app/만
복사되어 배포 환경에서 못 돌았다. 매시간 알림 크론(/chatbot/notifications/run)이
run_async()를 불러 자동 갱신하도록 여기로 옮겼다 — 루트 스크립트는 이 모듈을
부르는 로컬 수동 실행 래퍼로 남아 있다.

- 멱등: 이미 판매가 있는 날짜(오늘은 시간 단위)는 건너뛴다 → 매시간 돌려도 안전.
- 오늘 데이터는 현재 시각까지만 생성 → 하루 중 언제 돌아도 '진행 중'처럼 보인다.
- 날짜별 고정 시드 난수 → 재실행해도 같은 결과.
"""

import logging
import random
import threading
from collections import defaultdict
from datetime import date, datetime, time as dtime, timedelta, timezone

from app.models.inventory import Menu, Sale
from app.models.operation import Employee, Expense, Schedule
from app.services.ai.document_service import _session

logger = logging.getLogger(__name__)

KST = timezone(timedelta(hours=9))
STORES = ["owner@cafe.com", "s@gmail.com"]  # 더미가 채워지는 데모 매장 — 실매장은 절대 넣지 않는다
OPEN_HOUR, CLOSE_HOUR = 9, 20  # 히스토리상 판매 발생 시간대 (9시~20시대)
# 요일별 물량을 뽑을 때 볼 최근 기간. 전체 이력으로 평균내면 매출 수준이 한 번 바뀐 매장에서
# 옛 수준과 지금 수준의 중간값으로 생성되어 '세 번째 레벨'이 생긴다 — 실제로 그렇게 망가진 적
# 있다(s@gmail.com 6월 350잔 / 7월 75잔). 4주면 요일마다 4표본이라 평균도 안정적이다.
PROFILE_WINDOW_DAYS = 28

_run_lock = threading.Lock()  # 크론이 겹쳐 불려도 시드가 동시에 두 번 돌지 않게


def _analyze(db, store_id: str):
    """기존 판매에서 요일별 평균 잔 수·시간대 가중치·메뉴 비중·잔수 분포를 뽑는다.

    물량(weekday_avg)만 최근 PROFILE_WINDOW_DAYS일로 제한한다 — 지금 매장 수준을
    이어 붙이는 게 목적이라 옛 수준이 섞이면 안 된다. 반면 시간대·메뉴 비중은 물량과
    달리 수준이 바뀌어도 잘 안 변하는 '모양'이라 전체 이력을 써서 표본을 늘린다.
    last_day·days_with_sales는 멱등 판정용이므로 반드시 전체 이력 기준이어야 한다.
    """
    rows = db.query(Sale.sold_at, Sale.quantity, Sale.menu_id).filter(Sale.store_id == store_id).all()
    if not rows:
        return None
    daily = defaultdict(int)
    weekday_cups = defaultdict(list)
    hour_w = defaultdict(int)
    menu_w = defaultdict(int)
    two_cup_rows = total_rows = 0
    for sold_at, qty, menu_id in rows:
        dt = sold_at if isinstance(sold_at, datetime) else datetime.fromisoformat(str(sold_at))
        # Neon(timestamptz)은 UTC로 돌려준다 — KST로 바꿔야 요일·시간대 패턴이 실제 영업시간과 맞는다
        if dt.tzinfo is not None:
            dt = dt.astimezone(KST)
        daily[dt.date()] += qty
        hour_w[dt.hour] += qty
        menu_w[menu_id] += qty
        total_rows += 1
        if qty >= 2:
            two_cup_rows += 1

    last_day = max(daily)
    recent_from = last_day - timedelta(days=PROFILE_WINDOW_DAYS)
    for d, cups in daily.items():
        if d > recent_from:
            weekday_cups[d.weekday()].append(cups)
    # 최근 창에 해당 요일이 하나도 없으면(자료가 아주 짧을 때) 전체 이력으로 물러선다
    if not weekday_cups:
        for d, cups in daily.items():
            weekday_cups[d.weekday()].append(cups)

    return {
        "last_day": last_day,
        "days_with_sales": set(daily),
        "weekday_avg": {wd: sum(v) / len(v) for wd, v in weekday_cups.items()},
        "hour_weights": dict(hour_w),
        "menu_weights": dict(menu_w),
        "p_two_cups": two_cup_rows / total_rows if total_rows else 0.15,
    }


def _hours_with_sales_today(db, store_id: str, today: date) -> set[int]:
    # timestamptz 컬럼을 날짜 문자열과 비교하면 Postgres가 UTC 자정(=09:00 KST)으로
    # 캐스팅해서, 오늘 00~09시 KST에 이미 들어간 판매가 안 잡힌다 — 시더가 '아직 판매
    # 없음'으로 보고 오전 매출을 한 번 더 만들어 중복 누적됐다.
    rows = (db.query(Sale.sold_at)
            .filter(Sale.store_id == store_id,
                    Sale.sold_at >= datetime.combine(today, dtime.min, tzinfo=KST)).all())
    out = set()
    for (sold_at,) in rows:
        dt = sold_at if isinstance(sold_at, datetime) else datetime.fromisoformat(str(sold_at))
        if dt.tzinfo is not None:
            dt = dt.astimezone(KST)
        out.add(dt.hour)
    return out


def seed_sales(db, store_id: str, now: datetime) -> int:
    profile = _analyze(db, store_id)
    if profile is None:
        logger.info("[demo_seed] %s 판매 이력이 없어 건너뜀", store_id)
        return 0

    menus = {m.id: m for m in db.query(Menu).filter(Menu.store_id == store_id).all()}
    menu_ids = [mid for mid in profile["menu_weights"] if mid in menus]
    if not menu_ids:
        logger.info("[demo_seed] %s 메뉴가 없어 건너뜀", store_id)
        return 0
    menu_probs = [profile["menu_weights"][mid] for mid in menu_ids]

    today = now.date()
    created = 0
    # last_day 자체부터 시작 — 과거 날짜는 days_with_sales로 걸러지고,
    # 오늘 판매가 이미 있어도(last_day == 오늘) 남은 시간대를 시간 단위로 이어서 채운다
    day = profile["last_day"]
    while day <= today:
        is_today = day == today
        # 과거 날짜는 이미 판매가 있으면 통째로 건너뛴다 (멱등)
        if not is_today and day in profile["days_with_sales"]:
            day += timedelta(days=1)
            continue
        done_hours = _hours_with_sales_today(db, store_id, today) if is_today else set()

        rng = random.Random(f"{store_id}:{day.isoformat()}")  # 날짜별 고정 시드 → 재실행해도 같은 결과
        # 해당 요일 표본이 없으면 다른 요일 평균으로 메운다. 예전에는 상수 65로 폴백했는데,
        # 그 값이 실제 매장 수준(하루 350잔)과 5배 어긋나 레벨 단절을 만들었다.
        wd_avg = profile["weekday_avg"]
        fallback = sum(wd_avg.values()) / len(wd_avg) if wd_avg else 65
        target = round(wd_avg.get(day.weekday(), fallback) * rng.uniform(0.85, 1.15))

        hours = list(range(OPEN_HOUR, CLOSE_HOUR + 1))
        weights = [profile["hour_weights"].get(h, 1) for h in hours]
        total_w = sum(weights)

        for h, w in zip(hours, weights):
            if is_today:
                if h > now.hour or h in done_hours:
                    continue  # 아직 오지 않은 시간대는 만들지 않는다 → '실시간' 연출
            cups_h = round(target * w / total_w * rng.uniform(0.8, 1.2))
            minute_cap = now.minute if (is_today and h == now.hour) else 59
            made = 0
            while made < cups_h:
                qty = 2 if (rng.random() < profile["p_two_cups"] and cups_h - made >= 2) else 1
                menu = menus[rng.choices(menu_ids, weights=menu_probs)[0]]
                sold = datetime(day.year, day.month, day.day, h,
                                rng.randint(0, max(0, minute_cap)), rng.randint(0, 59), tzinfo=KST)
                db.add(Sale(menu_id=menu.id, quantity=qty,
                            total_price=menu.selling_price * qty,
                            store_id=store_id, sold_at=sold))
                made += qty
                created += 1
        day += timedelta(days=1)
    return created


def seed_schedules(db, store_id: str, now: datetime) -> int:
    """기존 근무 패턴 연장: 평일·주말 오픈(09–15)/마감(15–21) 2교대 + 주말 지원 근무.

    반드시 해당 데모 매장 소속 직원만 본다 — 스크립트 시절에는 전체 직원을 봤는데,
    서버에서 매시간 돌면 실매장 직원에게 더미 스케줄이 생길 수 있어 스코프를 좁혔다.
    """
    employees = (db.query(Employee).filter(Employee.store_id == store_id)
                 .order_by(Employee.id).all())
    if len(employees) < 2:
        return 0
    opener, closer = employees[0], employees[1]
    weekender = employees[2] if len(employees) >= 3 else None

    emp_ids = [e.id for e in employees]
    existing = {(s.employee_id, s.date)
                for s in db.query(Schedule).filter(Schedule.employee_id.in_(emp_ids)).all()}
    last = (db.query(Schedule).filter(Schedule.employee_id.in_(emp_ids))
            .order_by(Schedule.date.desc()).first())
    start_day = (date.fromisoformat(last.date) if last else now.date() - timedelta(days=7)) + timedelta(days=1)

    created = 0
    day = start_day
    while day <= now.date():
        rng = random.Random(f"sched:{day.isoformat()}")
        plan = [(opener, 9, 15), (closer, 15, 21)]
        if weekender and day.weekday() >= 5:
            plan.append((weekender, 11, 20))
        for emp, sh, eh in plan:
            if (emp.id, day.isoformat()) in existing:
                continue
            st = datetime(day.year, day.month, day.day, sh, 0)
            en = datetime(day.year, day.month, day.day, eh, 0)
            # 지나간 근무에는 실제 출퇴근 기록(±10분)도 채워 급여 집계가 살아나게 한다
            actual_st = actual_en = None
            now_naive = now.replace(tzinfo=None)
            if st <= now_naive:
                actual_st = st + timedelta(minutes=rng.randint(-10, 5))
            if en <= now_naive:
                actual_en = en + timedelta(minutes=rng.randint(-5, 10))
            db.add(Schedule(employee_id=emp.id, start_time=st, end_time=en,
                            date=day.isoformat(), actual_start_time=actual_st,
                            actual_end_time=actual_en))
            created += 1
        day += timedelta(days=1)
    return created


def seed_expenses(db, store_id: str, now: datetime) -> int:
    """오늘 지출이 없으면 소모품 매입 1건을 넣어 일간 리포트 비용 항목을 살린다."""
    today = now.date()
    exists = (db.query(Expense)
              .filter(Expense.store_id == store_id, Expense.expense_date == today).first())
    if exists:
        return 0
    rng = random.Random(f"exp:{store_id}:{today.isoformat()}")
    # 하루 매출 대비 과하지 않게 — 추정 수익이 적자로 보이지 않는 수준
    db.add(Expense(store_id=store_id, amount=rng.randrange(25000, 50000, 5000),
                   category="소모품", description="우유·컵·부자재 매입 (더미)",
                   expense_date=today))
    return 1


def run(now: datetime | None = None) -> dict:
    """데모 매장 전체 시드 실행 (동기). 반환: 생성 건수 집계."""
    now = now or datetime.now(KST)
    result = {"sales": 0, "expenses": 0, "schedules": 0}
    with _session() as db:
        for store in STORES:
            result["sales"] += seed_sales(db, store, now)
            result["expenses"] += seed_expenses(db, store, now)
            result["schedules"] += seed_schedules(db, store, now)
        db.commit()
    logger.info("[demo_seed] 완료 — 판매 %s건, 지출 %s건, 근무 %s건",
                result["sales"], result["expenses"], result["schedules"])
    return result


def run_async() -> bool:
    """백그라운드 스레드로 run()을 실행한다. 이미 도는 중이면 False를 돌려주고 건너뛴다.

    알림 크론 응답을 시드가 지연시키지 않게 하기 위한 진입점 — 시드 실패는
    알림 발송과 무관하므로 예외는 로그만 남긴다.
    """
    if not _run_lock.acquire(blocking=False):
        return False

    def _worker():
        try:
            run()
        except Exception:
            logger.exception("[demo_seed] 데모 더미 데이터 갱신 실패")
        finally:
            _run_lock.release()

    threading.Thread(target=_worker, name="demo-seed", daemon=True).start()
    return True
