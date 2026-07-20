# -*- coding: utf-8 -*-
"""최근 판매 공백 채우기 시드 (백엔드 B)

마지막 판매 기록 이후 ~ 오늘 현재 시각까지의 판매·근무 스케줄·지출 더미 데이터를
기존 히스토리의 실제 패턴(요일별 판매량, 시간대 분포, 메뉴 비중, 잔수 분포)을
그대로 흉내 내어 생성한다. 대시보드 '오늘 실시간' 그래프가 지금 시각까지 차오른다.

- 멱등: 이미 판매가 있는 날짜(오늘은 시간 단위)는 건너뛴다 → 매일 다시 실행해도 안전.
- 오늘 데이터는 현재 시각까지만 생성 → 하루 중간에 실행하면 '진행 중'처럼 보인다.

실행:  cd backend && python db_seed_recent_sales.py
"""

import random
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone

from app.models.inventory import Menu, Sale
from app.models.operation import Employee, Expense, Schedule
from app.services.ai.document_service import _session

KST = timezone(timedelta(hours=9))
STORES = ["owner@cafe.com", "s@gmail.com"]
OPEN_HOUR, CLOSE_HOUR = 9, 20  # 히스토리상 판매 발생 시간대 (9시~20시대)


def _analyze(db, store_id: str):
    """기존 판매에서 요일별 평균 잔 수·시간대 가중치·메뉴 비중·잔수 분포를 뽑는다."""
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
        daily[dt.date()] += qty
        hour_w[dt.hour] += qty
        menu_w[menu_id] += qty
        total_rows += 1
        if qty >= 2:
            two_cup_rows += 1
    for d, cups in daily.items():
        weekday_cups[d.weekday()].append(cups)
    return {
        "last_day": max(daily),
        "days_with_sales": set(daily),
        "weekday_avg": {wd: sum(v) / len(v) for wd, v in weekday_cups.items()},
        "hour_weights": dict(hour_w),
        "menu_weights": dict(menu_w),
        "p_two_cups": two_cup_rows / total_rows if total_rows else 0.15,
    }


def _hours_with_sales_today(db, store_id: str, today: date) -> set[int]:
    rows = (db.query(Sale.sold_at)
            .filter(Sale.store_id == store_id, Sale.sold_at >= today.isoformat()).all())
    out = set()
    for (sold_at,) in rows:
        dt = sold_at if isinstance(sold_at, datetime) else datetime.fromisoformat(str(sold_at))
        out.add(dt.hour)
    return out


def seed_sales(db, store_id: str, now: datetime) -> int:
    profile = _analyze(db, store_id)
    if profile is None:
        print(f"  [{store_id}] 판매 이력이 없어 건너뜀")
        return 0

    menus = {m.id: m for m in db.query(Menu).filter(Menu.store_id == store_id).all()}
    menu_ids = [mid for mid in profile["menu_weights"] if mid in menus]
    if not menu_ids:
        print(f"  [{store_id}] 메뉴가 없어 건너뜀")
        return 0
    menu_probs = [profile["menu_weights"][mid] for mid in menu_ids]

    today = now.date()
    created = 0
    day = profile["last_day"] + timedelta(days=1)
    while day <= today:
        is_today = day == today
        # 과거 날짜는 이미 판매가 있으면 통째로 건너뛴다 (멱등)
        if not is_today and day in profile["days_with_sales"]:
            day += timedelta(days=1)
            continue
        done_hours = _hours_with_sales_today(db, store_id, today) if is_today else set()

        rng = random.Random(f"{store_id}:{day.isoformat()}")  # 날짜별 고정 시드 → 재실행해도 같은 결과
        target = round(profile["weekday_avg"].get(day.weekday(), 65) * rng.uniform(0.85, 1.15))

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


def seed_schedules(db, now: datetime) -> int:
    """기존 근무 패턴 연장: 평일·주말 오픈(09–15)/마감(15–21) 2교대 + 주말 지원 근무."""
    employees = db.query(Employee).order_by(Employee.id).all()
    if len(employees) < 2:
        return 0
    opener, closer = employees[0], employees[1]
    weekender = employees[2] if len(employees) >= 3 else None

    existing = {(s.employee_id, s.date) for s in db.query(Schedule).all()}
    last = db.query(Schedule).order_by(Schedule.date.desc()).first()
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
    db.add(Expense(store_id=store_id, amount=rng.randrange(70000, 120000, 5000),
                   category="소모품", description="우유·컵·부자재 매입 (더미)",
                   expense_date=today))
    return 1


def main():
    now = datetime.now(KST)
    print(f"기준 시각: {now.isoformat()}")
    with _session() as db:
        total_sales = 0
        for store in STORES:
            n = seed_sales(db, store, now)
            e = seed_expenses(db, store, now)
            print(f"  [{store}] 판매 {n}건, 지출 {e}건 생성")
            total_sales += n
        s = seed_schedules(db, now)
        print(f"  근무 스케줄 {s}건 생성")
        db.commit()
    print(f"완료 - 판매 총 {total_sales}건. 오늘 하루 중 다시 실행하면 그 사이 시간대가 추가로 채워집니다.")


if __name__ == "__main__":
    main()
