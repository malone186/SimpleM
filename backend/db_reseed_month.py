# -*- coding: utf-8 -*-
"""s@gmail.com 더미 거래 데이터 리셋 + 최근 한 달 재생성 (백엔드 B)

기존 판매(Sale)·지출(Expense) 더미를 전부 지우고, 오늘까지 최근 30일치를
현실적인 패턴(요일별 수요, 시간대 분포, 메뉴 인기 비중, 완만한 상승 추세)으로
다시 생성한다. ARIMA 판매 예측(최소 14일)이 바로 동작하는 분량이다.

- 메뉴·재료·재고·발주는 판매가 참조하는 계정 셋업 데이터라 지우지 않는다.
- 근무 스케줄(Schedule)은 store 구분이 없는 전역 테이블이라 건드리지 않는다.
- 날짜별 고정 시드 → 같은 날 다시 실행해도 동일한 결과 (오늘 시간대만 추가됨).

실행:  cd backend && python db_reseed_month.py [store_id]
"""

import random
import sys
from datetime import date, datetime, timedelta, timezone

from app.models.inventory import Menu, Sale
from app.models.operation import Expense
from app.services.ai.document_service import _session

KST = timezone(timedelta(hours=9))
STORE = sys.argv[1] if len(sys.argv) > 1 else "s@gmail.com"
DAYS = 30
OPEN_HOUR, CLOSE_HOUR = 9, 20

# 시간대별 판매 가중치 — 출근길·점심 피크가 있는 전형적인 카페 곡선
HOUR_WEIGHTS = {9: 7, 10: 9, 11: 9, 12: 14, 13: 15, 14: 12, 15: 9, 16: 8, 17: 7, 18: 6, 19: 5, 20: 4}
# 요일별 기본 잔 수 (월~일) — 주말이 살짝 높은 동네 상권 패턴
WEEKDAY_BASE = {0: 62, 1: 65, 2: 68, 3: 66, 4: 76, 5: 90, 6: 82}
# 메뉴 인기 비중 (id 오름차순 순서대로) — 아메리카노가 압도적, 나머지 분산
MENU_WEIGHTS_BY_RANK = [30, 20, 12, 9, 11, 8, 10]

EXPENSE_PLAN = [
    ("원두매입", "케냐 AA·블렌드 원두 매입 (더미)", 60000, 95000),
    ("우유/유제품", "서울우유·휘핑크림 매입 (더미)", 35000, 60000),
    ("소모품", "컵·리드·빨대 등 부자재 매입 (더미)", 25000, 45000),
]


def wipe(db) -> tuple[int, int]:
    """기존 판매·지출 더미를 전부 삭제한다."""
    n_sales = db.query(Sale).filter(Sale.store_id == STORE).delete(synchronize_session=False)
    n_exp = db.query(Expense).filter(Expense.store_id == STORE).delete(synchronize_session=False)
    return n_sales, n_exp


def seed_sales(db, now: datetime) -> int:
    menus = db.query(Menu).filter(Menu.store_id == STORE, Menu.is_active.is_(True)).order_by(Menu.id).all()
    if not menus:
        raise SystemExit(f"[{STORE}] 활성 메뉴가 없어 판매를 생성할 수 없습니다.")
    weights = (MENU_WEIGHTS_BY_RANK * ((len(menus) // len(MENU_WEIGHTS_BY_RANK)) + 1))[: len(menus)]

    today = now.date()
    created = 0
    total_w = sum(HOUR_WEIGHTS.values())

    for offset in range(DAYS - 1, -1, -1):
        day = today - timedelta(days=offset)
        is_today = day == today
        rng = random.Random(f"{STORE}:{day.isoformat()}")

        # 완만한 상승 추세(한 달간 약 +12%) + 요일 패턴 + 일별 노이즈
        trend = 1.0 + 0.12 * (DAYS - 1 - offset) / (DAYS - 1)
        target = round(WEEKDAY_BASE[day.weekday()] * trend * rng.uniform(0.88, 1.12))

        for h in range(OPEN_HOUR, CLOSE_HOUR + 1):
            if is_today and h > now.hour:
                continue  # 아직 오지 않은 시간대는 비워 '실시간 진행 중' 연출
            cups_h = round(target * HOUR_WEIGHTS[h] / total_w * rng.uniform(0.8, 1.2))
            minute_cap = now.minute if (is_today and h == now.hour) else 59
            made = 0
            while made < cups_h:
                qty = 2 if (rng.random() < 0.15 and cups_h - made >= 2) else 1
                menu = rng.choices(menus, weights=weights)[0]
                sold = datetime(day.year, day.month, day.day, h,
                                rng.randint(0, max(0, minute_cap)), rng.randint(0, 59), tzinfo=KST)
                db.add(Sale(menu_id=menu.id, quantity=qty,
                            total_price=menu.selling_price * qty,
                            store_id=STORE, sold_at=sold))
                made += qty
                created += 1
    return created


def seed_expenses(db, now: datetime) -> int:
    """3일 간격으로 매입 지출을 넣어 정산·리포트의 비용 항목을 살린다."""
    today = now.date()
    created = 0
    for offset in range(DAYS - 1, -1, -3):
        day = today - timedelta(days=offset)
        rng = random.Random(f"exp:{STORE}:{day.isoformat()}")
        category, desc, lo, hi = EXPENSE_PLAN[created % len(EXPENSE_PLAN)]
        db.add(Expense(store_id=STORE, amount=rng.randrange(lo, hi, 5000),
                       category=category, description=desc, expense_date=day))
        created += 1
    return created


def main():
    now = datetime.now(KST)
    print(f"대상 매장: {STORE} / 기준 시각: {now.isoformat()}")
    with _session() as db:
        n_sales, n_exp = wipe(db)
        print(f"  삭제 - 판매 {n_sales}건, 지출 {n_exp}건")
        s = seed_sales(db, now)
        e = seed_expenses(db, now)
        db.commit()
    print(f"  생성 - 최근 {DAYS}일 판매 {s}건, 지출 {e}건")
    print("완료 - 판매 예측(ARIMA)은 14일 이상 데이터가 필요하며 30일이 채워져 바로 동작합니다.")


if __name__ == "__main__":
    main()
