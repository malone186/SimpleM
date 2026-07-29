"""직원 인건비 상세 (백엔드 B) — 고용형태·보험·주휴수당까지 반영한 '실제 나가는 돈'

왜 시급만으로는 부족한가:
  같은 시급 12,000원이라도 주 14시간 알바와 주 30시간 알바는 매장이 부담하는 금액이
  전혀 다르다. 주 15시간을 넘으면 주휴수당(하루치 임금)이 붙고, 4대보험에 가입되면
  사업주 부담분이 임금의 약 10% 추가로 나간다. 사장님이 "얼마 나가지?"를 물었을 때
  필요한 건 시급×시간이 아니라 이 합계다.

계산 규칙:
  · 주휴수당 — 근로기준법 제55조. 주 소정근로시간 15시간 이상이면 1주 1회 유급휴일.
    금액은 (주 소정근로시간 ÷ 40) × 8 × 시급, 8시간분을 넘지 않는다.
  · 4대보험 사업주 부담 — 국민연금·건강보험·장기요양·고용보험·산재보험.
    아래 요율은 2025~2026년 기준값이며 매년 고시로 바뀌므로 상수로 모아 두었다.
  · 2대보험 = 고용·산재만 (주 15시간 미만 단시간 근로자의 통상적인 형태)
  · 3.3% 원천징수는 사업소득(프리랜서) 계약일 때만 해당하므로 보험 '미가입'에서만 계산한다.

여기 숫자는 확정 지급액이 아니라 예상치다 — 화면에도 그렇게 표시한다.
"""

from __future__ import annotations

import logging
from datetime import date, timedelta
from typing import Any, Optional

logger = logging.getLogger(__name__)


class StaffError(ValueError):
    """직원 정보 처리 실패"""


def _session():
    import app.models  # noqa: F401

    from app.core.database import SessionLocal

    return SessionLocal()


# ---------------------------------------------------------------------------
# 요율 상수 (매년 고시 — 바뀌면 여기만 고친다)
# ---------------------------------------------------------------------------
RATES = {
    "national_pension": 0.045,        # 국민연금 사업주 부담 4.5%
    "health": 0.03545,                # 건강보험 사업주 부담 3.545%
    "long_term_care": 0.1295,         # 장기요양 = 건강보험료 × 12.95% (사업주 부담분에 곱)
    "employment_worker": 0.009,       # 고용보험 근로자 0.9%
    "employment_owner": 0.0115,       # 고용보험 사업주 1.15% (실업급여 0.9 + 고용안정 0.25, 150인 미만)
    "accident": 0.0089,               # 산재보험 사업주 전액 — 음식·숙박업 요율 근사치
    "freelance_withholding": 0.033,   # 사업소득 원천징수 3.3%
}

MIN_WAGE_2026 = 10_320  # 2026년 최저임금(시급). 미달이면 경고를 띄운다.

EMPLOYMENT_TYPES = [
    {"code": "part_time", "label": "단시간 알바 (주 15시간 미만)",
     "note": "주휴수당·4대보험 대상이 아니에요. 산재보험은 모든 사업장 의무입니다."},
    {"code": "part_time_15", "label": "알바 (주 15시간 이상)",
     "note": "주휴수당이 발생하고 4대보험 가입 대상이에요."},
    {"code": "full_time", "label": "정규직 (주 40시간)",
     "note": "주휴수당 포함, 4대보험 의무 가입입니다."},
    {"code": "manager", "label": "매니저 · 점장",
     "note": "보통 월급제로 계약해요. 월급에 주휴수당이 포함된 경우가 많습니다."},
]

INSURANCE_TYPES = [
    {"code": "four", "label": "4대보험",
     "note": "국민연금·건강보험·고용보험·산재보험 전부. 사업주 부담이 임금의 약 10~11% 추가됩니다."},
    {"code": "two", "label": "2대보험 (고용·산재)",
     "note": "단시간 근로자의 일반적인 형태. 사업주 부담이 약 2% 수준이에요."},
    {"code": "none", "label": "미가입 (3.3% 원천징수)",
     "note": "사업소득 계약. 4대보험 대상인데 미가입이면 추후 소급 징수될 수 있어요."},
]

WEEKS_PER_MONTH = 4.345  # 1개월 평균 주 수 (365 ÷ 7 ÷ 12)


# ---------------------------------------------------------------------------
# 프로필 조회·저장
# ---------------------------------------------------------------------------

def _profile_dict(p) -> dict[str, Any]:
    return {
        "employee_id": p.employee_id,
        "employment_type": p.employment_type,
        "pay_type": p.pay_type,
        "monthly_salary": p.monthly_salary,
        "weekly_hours": float(p.weekly_hours or 0),
        "insurance": p.insurance,
        "weekly_holiday_pay": p.weekly_holiday_pay,
        "hired_on": p.hired_on,
        "memo": p.memo,
    }


def _default_profile(employee_id: int) -> dict[str, Any]:
    """프로필을 아직 안 채운 직원의 기본값 — 가장 흔한 형태(주 15시간 미만 알바)."""
    return {
        "employee_id": employee_id,
        "employment_type": "part_time",
        "pay_type": "hourly",
        "monthly_salary": 0,
        "weekly_hours": 0.0,
        "insurance": "two",
        "weekly_holiday_pay": True,
        "hired_on": None,
        "memo": None,
        "unset": True,  # 화면에서 "상세 정보를 채워 주세요"를 띄우기 위한 표시
    }


def save_profile(store_id: str, employee_id: int, **fields) -> dict[str, Any]:
    from app.models.ai import EmployeeProfile
    from app.models.operation import Employee

    allowed = {"employment_type", "pay_type", "monthly_salary", "weekly_hours",
               "insurance", "weekly_holiday_pay", "hired_on", "memo"}
    if fields.get("employment_type") and fields["employment_type"] not in {t["code"] for t in EMPLOYMENT_TYPES}:
        raise StaffError(f"알 수 없는 고용형태입니다: {fields['employment_type']}")
    if fields.get("insurance") and fields["insurance"] not in {t["code"] for t in INSURANCE_TYPES}:
        raise StaffError(f"알 수 없는 보험 유형입니다: {fields['insurance']}")

    db = _session()
    try:
        emp = db.get(Employee, employee_id)
        if emp is None:
            raise StaffError(f"직원(id={employee_id})을 찾을 수 없습니다.")
        # 남의 매장 직원을 고칠 수 없게 막는다 (store_id가 비어 있는 레거시 직원은 통과)
        if emp.store_id and emp.store_id != store_id:
            raise StaffError("다른 매장의 직원입니다.")

        p = db.get(EmployeeProfile, employee_id)
        if p is None:
            p = EmployeeProfile(employee_id=employee_id, store_id=store_id)
            db.add(p)
        p.store_id = store_id
        for k, v in fields.items():
            if k in allowed and v is not None:
                setattr(p, k, v)
        db.commit()
        db.refresh(p)
        return _profile_dict(p)
    finally:
        db.close()


# ---------------------------------------------------------------------------
# 인건비 계산
# ---------------------------------------------------------------------------

def estimate_labor_cost(
    hourly_rate: int,
    profile: dict[str, Any],
    scheduled_monthly_hours: Optional[float] = None,
) -> dict[str, Any]:
    """직원 1명의 월 인건비 추정 — 기본급 + 주휴수당 + 사업주 보험 부담.

    근무시간을 정하는 순서:
      1) scheduled_monthly_hours — 근무 달력에 실제로 등록된 이번 달 시간. 사장님이 이미
         짜 둔 스케줄이 가장 정확한 근거라 이걸 최우선으로 쓴다.
      2) 프로필의 '주 소정근로시간' × 월평균 주 수 — 스케줄을 아직 안 짠 직원용.
    예전엔 2)만 봤는데 기본값이 0이라, 스케줄이 빼곡한 직원도 인건비가 0원으로 나왔다.

    시급제는 (시간 × 시급), 월급제는 월급을 그대로 기본급으로 본다.
    """
    pay_type = profile.get("pay_type", "hourly")
    profile_weekly = float(profile.get("weekly_hours") or 0)

    if scheduled_monthly_hours and scheduled_monthly_hours > 0:
        monthly_hours = round(float(scheduled_monthly_hours), 1)
        weekly = round(monthly_hours / WEEKS_PER_MONTH, 1)
        hours_source = "schedule"
    else:
        weekly = profile_weekly
        monthly_hours = round(weekly * WEEKS_PER_MONTH, 1)
        hours_source = "profile" if weekly > 0 else "none"

    if pay_type == "monthly":
        base = int(profile.get("monthly_salary") or 0)
        # 월급제도 시급 환산액이 최저임금을 넘는지 확인해야 한다 (실무에서 가장 흔한 위반)
        effective_hourly = round(base / monthly_hours) if monthly_hours > 0 else 0
        holiday_pay = 0  # 월급에는 통상 주휴수당이 포함돼 있다
    else:
        base = int(round(hourly_rate * monthly_hours))
        effective_hourly = hourly_rate
        holiday_pay = 0
        # 주 15시간 이상이면 주휴수당 — (주 소정시간 ÷ 40) × 8시간 × 시급, 8시간분 상한
        if profile.get("weekly_holiday_pay", True) and weekly >= 15:
            weekly_holiday = min(weekly / 40, 1.0) * 8 * hourly_rate
            holiday_pay = int(round(weekly_holiday * WEEKS_PER_MONTH))

    gross = base + holiday_pay
    insurance = profile.get("insurance", "two")

    owner_parts: dict[str, int] = {}
    withholding = 0
    if insurance == "four":
        pension = int(round(gross * RATES["national_pension"]))
        health = int(round(gross * RATES["health"]))
        care = int(round(health * RATES["long_term_care"]))
        employment = int(round(gross * RATES["employment_owner"]))
        accident = int(round(gross * RATES["accident"]))
        owner_parts = {
            "국민연금": pension, "건강보험": health, "장기요양": care,
            "고용보험": employment, "산재보험": accident,
        }
    elif insurance == "two":
        owner_parts = {
            "고용보험": int(round(gross * RATES["employment_owner"])),
            "산재보험": int(round(gross * RATES["accident"])),
        }
    else:  # none — 사업소득 3.3% 원천징수 (사업주 추가 부담은 없고 지급액에서 뗀다)
        withholding = int(round(gross * RATES["freelance_withholding"]))

    owner_burden = sum(owner_parts.values())
    return {
        "weekly_hours": weekly,
        "monthly_hours": monthly_hours,
        # 이 숫자가 어디서 왔는지 — 화면이 "스케줄 기준"인지 "직접 입력 기준"인지 밝힐 수 있게
        "hours_source": hours_source,
        "pay_type": pay_type,
        "hourly_rate": hourly_rate,
        "effective_hourly": effective_hourly,
        "base_pay": base,
        "weekly_holiday_pay": holiday_pay,
        "gross_pay": gross,
        "withholding_tax": withholding,
        "net_pay": gross - withholding,          # 직원이 받는 돈
        "owner_insurance": owner_parts,
        "owner_burden": owner_burden,
        "total_cost": gross + owner_burden,      # 매장에서 실제로 나가는 돈
        "below_min_wage": effective_hourly > 0 and effective_hourly < MIN_WAGE_2026,
        "min_wage": MIN_WAGE_2026,
        "disclaimer": "보험 요율은 매년 바뀌는 고시 기준 추정치예요. 확정 금액은 4대보험 고지서를 확인하세요.",
    }


def _scheduled_hours_by_employee(db, emp_ids: list[int], month: str) -> dict[int, float]:
    """해당 월(YYYY-MM)에 근무 달력에 등록된 직원별 총 근무시간.

    실제 출퇴근 기록(actual_*)이 있으면 그것을, 없으면 계획 시간을 쓴다.
    자정을 넘긴 근무는 종료가 시작보다 앞서므로 24시간을 더해 보정한다.
    """
    from app.models.operation import Schedule

    if not emp_ids:
        return {}
    rows = (
        db.query(Schedule)
        .filter(Schedule.employee_id.in_(emp_ids), Schedule.date.like(f"{month}%"))
        .all()
    )
    hours: dict[int, float] = {}
    for s in rows:
        st = s.actual_start_time or s.start_time
        et = s.actual_end_time or s.end_time
        if not st or not et:
            continue
        delta = (et - st).total_seconds() / 3600
        if delta < 0:
            delta += 24
        if delta <= 0:
            continue
        hours[s.employee_id] = hours.get(s.employee_id, 0.0) + delta
    return {k: round(v, 1) for k, v in hours.items()}


def list_staff(store_id: str, month: Optional[str] = None) -> dict[str, Any]:
    """매장 직원 목록 + 각자의 고용 상세 + 월 인건비 추정 + 매장 합계.

    인건비는 근무 달력에 등록된 이번 달 실제 근무시간을 기준으로 계산한다.
    스케줄이 없는 직원만 프로필의 '주 소정근로시간'으로 대신 계산한다.
    """
    from app.models.ai import EmployeeProfile
    from app.models.operation import Employee

    target_month = month or date.today().strftime("%Y-%m")

    db = _session()
    try:
        # store_id가 NULL인 직원까지 끌어오면 공유 DB에서 소속 불명 직원이 모든 매장에
        # 나타난다 (실측: 이름 'd'인 직원이 전 매장 목록에 떴다). 내 매장 것만 본다.
        employees = (
            db.query(Employee)
            .filter(Employee.store_id == store_id)
            .order_by(Employee.id)
            .all()
        )
        if not employees:
            return {"staff": [], "total_gross": 0, "total_owner_burden": 0,
                    "total_cost": 0, "total_hours": 0, "month": target_month,
                    "employment_types": EMPLOYMENT_TYPES,
                    "insurance_types": INSURANCE_TYPES, "min_wage": MIN_WAGE_2026}
        emp_ids = [e.id for e in employees]
        profiles = {
            p.employee_id: _profile_dict(p)
            for p in db.query(EmployeeProfile)
            .filter(EmployeeProfile.employee_id.in_(emp_ids))
            .all()
        }
        # 근무 달력에 등록된 이번 달 시간 — 인건비 계산의 1순위 근거
        scheduled = _scheduled_hours_by_employee(db, emp_ids, target_month)
    finally:
        db.close()

    staff = []
    for e in employees:
        prof = profiles.get(e.id) or _default_profile(e.id)
        cost = estimate_labor_cost(e.hourly_rate or 0, prof, scheduled.get(e.id))
        staff.append({
            "id": e.id,
            "name": e.name,
            "role": e.role,
            "hourly_rate": e.hourly_rate,
            "scheduled_hours": scheduled.get(e.id, 0.0),
            "profile": prof,
            "cost": cost,
        })

    return {
        "staff": staff,
        "month": target_month,
        "total_gross": sum(s["cost"]["gross_pay"] for s in staff),
        "total_owner_burden": sum(s["cost"]["owner_burden"] for s in staff),
        "total_cost": sum(s["cost"]["total_cost"] for s in staff),
        "total_hours": round(sum(s["cost"]["monthly_hours"] for s in staff), 1),
        # 근무시간을 아직 알 수 없는 직원 수 — 화면이 "왜 0원인지" 설명할 수 있게
        "unknown_hours_count": sum(1 for s in staff if s["cost"]["hours_source"] == "none"),
        "employment_types": EMPLOYMENT_TYPES,
        "insurance_types": INSURANCE_TYPES,
        "min_wage": MIN_WAGE_2026,
        "rates": RATES,
    }


def weekly_payroll(store_id: str, week_start: Optional[str] = None) -> dict[str, Any]:
    """주급 지급용 — 등록된 스케줄 기준으로 이번 주 실제 근무시간과 지급액을 뽑는다.

    주급으로 정산하는 매장이 많은데(알바), 월 단위 추정만으로는 "이번 주 얼마 주지?"에
    답이 안 된다. 스케줄이 없는 직원은 소정근로시간 기준 추정치로 채운다.
    """
    from app.models.ai import EmployeeProfile
    from app.models.operation import Employee, Schedule

    today = date.today()
    start = date.fromisoformat(week_start) if week_start else today - timedelta(days=today.weekday())
    end = start + timedelta(days=6)

    db = _session()
    try:
        employees = db.query(Employee).filter(Employee.store_id == store_id).all()
        emp_ids = [e.id for e in employees]
        schedules = (
            db.query(Schedule)
            .filter(Schedule.employee_id.in_(emp_ids),
                    Schedule.date >= start.isoformat(),
                    Schedule.date <= end.isoformat())
            .all()
        ) if emp_ids else []
        profiles = {
            p.employee_id: _profile_dict(p)
            for p in db.query(EmployeeProfile).filter(EmployeeProfile.employee_id.in_(emp_ids)).all()
        } if emp_ids else {}
    finally:
        db.close()

    hours_by_emp: dict[int, float] = {}
    for s in schedules:
        st = s.actual_start_time or s.start_time
        et = s.actual_end_time or s.end_time
        if not st or not et:
            continue
        delta = (et - st).total_seconds() / 3600
        if delta < 0:  # 자정을 넘긴 근무
            delta += 24
        hours_by_emp[s.employee_id] = hours_by_emp.get(s.employee_id, 0.0) + delta

    rows = []
    for e in employees:
        prof = profiles.get(e.id) or _default_profile(e.id)
        scheduled = round(hours_by_emp.get(e.id, 0.0), 1)
        estimated = scheduled > 0
        hours = scheduled if estimated else float(prof.get("weekly_hours") or 0)
        if hours <= 0:
            continue
        rate = e.hourly_rate or 0
        if prof.get("pay_type") == "monthly":
            # 월급제는 주급 개념이 없다 — 월급 ÷ 월평균 주 수로 환산해 참고값만 준다
            weekly_pay = int(round((prof.get("monthly_salary") or 0) / WEEKS_PER_MONTH))
            holiday = 0
        else:
            weekly_pay = int(round(rate * hours))
            holiday = (
                int(round(min(hours / 40, 1.0) * 8 * rate))
                if prof.get("weekly_holiday_pay", True) and hours >= 15
                else 0
            )
        rows.append({
            "employee_id": e.id,
            "name": e.name,
            "role": e.role,
            "hours": hours,
            "from_schedule": estimated,
            "pay_type": prof.get("pay_type"),
            "base_pay": weekly_pay,
            "weekly_holiday_pay": holiday,
            "total": weekly_pay + holiday,
        })

    rows.sort(key=lambda r: -r["total"])
    return {
        "week_start": start.isoformat(),
        "week_end": end.isoformat(),
        "rows": rows,
        "total": sum(r["total"] for r in rows),
        "holiday_total": sum(r["weekly_holiday_pay"] for r in rows),
        "note": "스케줄이 등록된 직원은 실제 근무시간, 없는 직원은 소정근로시간 기준 추정입니다.",
    }
