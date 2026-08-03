"""데모용 근무 패턴 시드 — 직원마다 '월·수·금 / 화·목 / 토·일'로 나눠 근무 가능 시간을 넣고,
그 패턴대로 이번 달·다음 달 달력을 채운다 (백엔드 B).

왜 필요한가:
    달력을 보여줘도 근무가 하나도 없으면 "이게 되는 화면인지" 알 수가 없다. 데모 전에
    한 번 돌리면 알바 근무 달력 스케줄표가 실제 매장처럼 채워진다.

쓰는 법:
    python db_seed_staff_schedule.py                 # 직원이 있는 모든 매장
    python db_seed_staff_schedule.py s@gmail.com     # 특정 매장만
    python db_seed_staff_schedule.py --reset s@gmail.com   # 기존 근무를 지우고 다시

주의: --reset은 그 매장의 이번 달·다음 달 근무를 지우고, 가능 시간도 캔 패턴으로 교체한다
(직원은 그대로). --reset 없이는 가능 시간이 이미 입력된 직원을 건드리지 않는다 —
공유 DB에는 팀원·데모 사용자가 실제로 입력한 가능 시간이 있을 수 있다.
"""

import sys
from datetime import date

import app.models  # noqa: F401  (모델 등록)
from app.core.database import SessionLocal
from app.models.ai import EmployeeAvailability
from app.models.operation import Employee, Schedule
from app.services.ai import staff_service

# 요일 0=월 … 6=일 — 사장님이 말하는 "월수금 / 화목 / 주말" 그대로
PATTERNS = [
    {"label": "월·수·금 오전", "days": [0, 2, 4], "start": 9, "end": 14},
    {"label": "화·목 오후",     "days": [1, 3],    "start": 13, "end": 22},
    {"label": "토·일 주말",     "days": [5, 6],    "start": 10, "end": 20},
    {"label": "월·수·금 마감",  "days": [0, 2, 4], "start": 14, "end": 22},
]

COLORS = ["#F59E0B", "#10B981", "#3B82F6", "#8B5CF6", "#EC4899", "#8C6F56"]


def next_month(d: date) -> str:
    return f"{d.year + (d.month == 12)}-{(d.month % 12) + 1:02d}"


def seed_store(store_id: str, reset: bool = False) -> None:
    db = SessionLocal()
    try:
        employees = db.query(Employee).filter(Employee.store_id == store_id).order_by(Employee.id).all()
        if not employees:
            print(f"[{store_id}] 직원이 없어 건너뜁니다.")
            return

        months = [date.today().strftime("%Y-%m"), next_month(date.today())]

        if reset:
            emp_ids = [e.id for e in employees]
            removed = 0
            for m in months:
                removed += (
                    db.query(Schedule)
                    .filter(Schedule.employee_id.in_(emp_ids), Schedule.date.like(f"{m}%"))
                    .delete(synchronize_session=False)
                )
            db.commit()
            print(f"[{store_id}] 기존 근무 {removed}건 삭제")

        for i, emp in enumerate(employees):
            pattern = PATTERNS[i % len(PATTERNS)]
            color = COLORS[i % len(COLORS)]

            q = db.query(EmployeeAvailability).filter(
                EmployeeAvailability.employee_id == emp.id
            )
            if q.count() and not reset:
                print(f"  · {emp.name}: 가능 시간이 이미 있어 그대로 둡니다 (교체하려면 --reset)")
                continue
            q.delete(synchronize_session=False)
            for dow in pattern["days"]:
                db.add(EmployeeAvailability(
                    employee_id=emp.id, store_id=store_id, day_of_week=dow,
                    start_hour=pattern["start"], end_hour=pattern["end"],
                ))
            db.commit()

            # 대표 색도 같이 — 달력의 선·점이 사람마다 구분돼야 읽힌다
            staff_service.save_profile(store_id, emp.id, color=color)
            print(f"  · {emp.name}: {pattern['label']} {pattern['start']:02d}~{pattern['end']:02d}시  {color}")
    finally:
        db.close()

    for i, m in enumerate(months):
        # 이번 달은 1일부터 채운다 — 데모에서 '이번 달 인건비'가 며칠치만 잡히면
        # 화면이 텅 빈 것처럼 보인다. 다음 달은 오늘 이후만 만들면 된다.
        r = staff_service.apply_availability(store_id, month=m, from_today=(i > 0))
        print(f"[{store_id}] {m} 근무 {r['created']}건 생성 (이미 있던 {r['skipped']}건은 그대로)")


def main() -> None:
    args = [a for a in sys.argv[1:] if a != "--reset"]
    reset = "--reset" in sys.argv[1:]

    if args:
        stores = args
    else:
        db = SessionLocal()
        try:
            stores = [
                s for (s,) in db.query(Employee.store_id).distinct().all() if s
            ]
        finally:
            db.close()

    for store_id in stores:
        print(f"\n=== {store_id} ===")
        seed_store(store_id, reset=reset)


if __name__ == "__main__":
    main()
