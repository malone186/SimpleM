# -*- coding: utf-8 -*-
"""owner@cafe.com & s@gmail.com 매장에 기본 메뉴 및 30일간의 판매/지출 시드 데이터 생성 스크립트"""

import random
from datetime import datetime, timedelta, timezone

from app.core.database import SessionLocal
from app.models.inventory import Menu, Sale
from app.models.operation import Expense

KST = timezone(timedelta(hours=9))
STORES = ["owner@cafe.com", "s@gmail.com"]

DEFAULT_MENUS = [
    {"name": "아메리카노", "price": 4500},
    {"name": "카페라떼", "price": 5000},
    {"name": "바닐라라떼", "price": 5500},
    {"name": "에스프레소", "price": 4000},
    {"name": "콜드브루", "price": 5200},
]

HOUR_WEIGHTS = {9: 7, 10: 9, 11: 9, 12: 14, 13: 15, 14: 12, 15: 9, 16: 8, 17: 7, 18: 6, 19: 5, 20: 4}
WEEKDAY_BASE = {0: 62, 1: 65, 2: 68, 3: 66, 4: 76, 5: 90, 6: 82}

def seed_all():
    db = SessionLocal()
    try:
        now = datetime.now(KST)
        today = now.date()

        for store_id in STORES:
            # 1. 메뉴 확인 및 생성
            existing_menus = db.query(Menu).filter(Menu.store_id == store_id).all()
            if not existing_menus:
                print(f"[{store_id}] 기본 메뉴 5종 생성 중...")
                for item in DEFAULT_MENUS:
                    m = Menu(
                        store_id=store_id,
                        name=item["name"],
                        selling_price=item["price"],
                        is_active=True
                    )
                    db.add(m)
                db.commit()
                existing_menus = db.query(Menu).filter(Menu.store_id == store_id).all()

            # 2. 기존 판매 및 지출 더미 초기화
            db.query(Sale).filter(Sale.store_id == store_id).delete(synchronize_session=False)
            db.query(Expense).filter(Expense.store_id == store_id).delete(synchronize_session=False)
            db.commit()

            print(f"[{store_id}] 최근 30일간의 판매 및 지출 시드 시뮬레이션 데이터 생성 중...")
            total_sales_count = 0

            for day_offset in range(29, -1, -1):
                target_date = today - timedelta(days=day_offset)
                weekday = target_date.weekday()

                rng = random.Random(f"{store_id}:{target_date.isoformat()}")
                base_cups = round(WEEKDAY_BASE[weekday] * rng.uniform(0.9, 1.1))

                total_weight = sum(HOUR_WEIGHTS.values())

                for hour, weight in HOUR_WEIGHTS.items():
                    if day_offset == 0 and hour > now.hour:
                        continue

                    cups_in_hour = round(base_cups * (weight / total_weight) * rng.uniform(0.8, 1.2))
                    for _ in range(cups_in_hour):
                        menu = rng.choice(existing_menus)
                        qty = 2 if rng.random() < 0.2 else 1
                        sold_time = datetime(
                            target_date.year, target_date.month, target_date.day,
                            hour, rng.randint(0, 59), rng.randint(0, 59), tzinfo=KST
                        )
                        db.add(Sale(
                            store_id=store_id,
                            menu_id=menu.id,
                            quantity=qty,
                            total_price=menu.selling_price * qty,
                            sold_at=sold_time
                        ))
                        total_sales_count += 1

                # 일일 지출 1건 생성
                db.add(Expense(
                    store_id=store_id,
                    amount=rng.randrange(30000, 70000, 5000),
                    category="원두/소모품",
                    description="원두 및 부자재 정기 매입",
                    expense_date=target_date
                ))

            db.commit()
            print(f"[{store_id}] 생성 완료: 총 {total_sales_count}건의 판매 데이터 및 30건의 지출 데이터")

        print("모든 시드 데이터 작성이 완료되었습니다!")
    except Exception as e:
        db.rollback()
        print(f"시드 데이터 생성 중 오류 발생: {e}")
    finally:
        db.close()

if __name__ == "__main__":
    seed_all()
