# -*- coding: utf-8 -*-
"""s@gmail.com 시드 레벨 단절 복구 (백엔드 B) — 2026-08-03

db_reseed_month.py(6월 시드, 일 300~450잔)와 db_seed_recent_sales.py의 옛 폴백값
(7월 시드, 일 60~100잔)이 서로 다른 물량 가정으로 돌아 2026-07-01에 5배 레벨 단절이
생겼다. 단절 이전(6월) 판매를 전부 지우고, 이후(7월) 구간의 실제 패턴(요일별 물량·
시간대 분포·메뉴 비중·잔수 분포)으로 재생성해 한 매장의 연속된 이야기로 만든다.

- 방향: 6월 → 7월 수준. 현재 운영·최근 시드·예측 검증이 전부 7월 수준(일 ~75잔)
  기준이므로, 6월을 맞추는 쪽이 나머지 전부를 다시 만들지 않아도 된다.
- 처음엔 '행 샘플링 삭제'로 축소했으나, 작업 도중 다른 프로세스가 6월 시드를 한 번 더
  얹어 동일 타임스탬프 중복이 남았다 — 그래서 삭제 후 재생성 방식으로 바꿨다.
- 날짜별 고정 시드 → 재실행해도 같은 결과.

실행:  cd backend && python db_fix_level_break.py
"""

import random
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone

from sqlalchemy import insert

from app.models.inventory import Menu, Sale
from app.services.ai.document_service import _session

KST = timezone(timedelta(hours=9))
STORE = "s@gmail.com"
BREAK_DAY = date(2026, 7, 1)   # 이 날부터가 '지금 수준' — 이전 구간을 여기에 맞춘다
REBUILD_FROM = date(2026, 6, 1)
NOISE = (0.85, 1.15)           # 요일 평균 그대로 찍으면 부자연스럽다 — 시드 스크립트와 같은 폭
WD_KO = "월화수목금토일"


def _to_kst(sold_at) -> datetime:
    dt = sold_at if isinstance(sold_at, datetime) else datetime.fromisoformat(str(sold_at))
    return dt.astimezone(KST) if dt.tzinfo is not None else dt


def main():
    with _session() as db:
        rows = (db.query(Sale.sold_at, Sale.quantity, Sale.menu_id)
                .filter(Sale.store_id == STORE).all())

        # 단절 이후 구간에서 '지금 매장'의 패턴을 배운다
        daily = defaultdict(int)
        hour_w = defaultdict(int)
        menu_w = defaultdict(int)
        two_cup_rows = total_rows = 0
        for sold_at, qty, menu_id in rows:
            dt = _to_kst(sold_at)
            if dt.date() < BREAK_DAY:
                continue
            daily[dt.date()] += qty
            hour_w[dt.hour] += qty
            menu_w[menu_id] += qty
            total_rows += 1
            if qty >= 2:
                two_cup_rows += 1
        if not daily:
            raise SystemExit(f"{BREAK_DAY} 이후 판매가 없어 목표 패턴을 잡을 수 없습니다.")

        wd_cups = defaultdict(list)
        for d, cups in daily.items():
            wd_cups[d.weekday()].append(cups)
        wd_avg = {wd: sum(v) / len(v) for wd, v in wd_cups.items()}
        overall = sum(wd_avg.values()) / len(wd_avg)
        p_two = two_cup_rows / total_rows if total_rows else 0.15
        print("목표(단절 이후) 요일 평균: " +
              ", ".join(f"{WD_KO[wd]} {wd_avg.get(wd, overall):.0f}잔" for wd in range(7)),
              flush=True)

        menus = {m.id: m for m in db.query(Menu).filter(Menu.store_id == STORE).all()}
        menu_ids = [mid for mid in menu_w if mid in menus]
        menu_probs = [menu_w[mid] for mid in menu_ids]
        hours = sorted(hour_w)
        hour_probs = [hour_w[h] for h in hours]
        total_hw = sum(hour_probs)

        # 단절 이전 구간을 통째로 지운다 — 중복이 섞여 있어 샘플링 축소로는 못 살린다
        n_del = (db.query(Sale)
                 .filter(Sale.store_id == STORE, Sale.sold_at < BREAK_DAY.isoformat())
                 .delete(synchronize_session=False))
        print(f"삭제 - {BREAK_DAY} 이전 판매 {n_del}건", flush=True)

        # 재생성 — 7월 패턴을 따르는 6월
        new_rows: list[dict] = []
        day = REBUILD_FROM
        while day < BREAK_DAY:
            rng = random.Random(f"fix:{STORE}:{day.isoformat()}")
            target = round(wd_avg.get(day.weekday(), overall) * rng.uniform(*NOISE))
            for h in hours:
                cups_h = round(target * hour_w[h] / total_hw * rng.uniform(0.8, 1.2))
                made = 0
                while made < cups_h:
                    qty = 2 if (rng.random() < p_two and cups_h - made >= 2) else 1
                    menu = menus[rng.choices(menu_ids, weights=menu_probs)[0]]
                    sold = datetime(day.year, day.month, day.day, h,
                                    rng.randint(0, 59), rng.randint(0, 59), tzinfo=KST)
                    new_rows.append(dict(menu_id=menu.id, quantity=qty,
                                         total_price=menu.selling_price * qty,
                                         store_id=STORE, sold_at=sold))
                    made += qty
            day += timedelta(days=1)

        # Neon은 왕복 0.2초라 ORM add()로 흘리면 수천 RTT가 된다 — 한 번에 executemany
        if new_rows:
            db.execute(insert(Sale), new_rows)
        db.commit()
    print(f"완료 - 6월 판매 {len(new_rows)}건 재생성. 레벨 단절이 해소되었습니다.", flush=True)


if __name__ == "__main__":
    main()
