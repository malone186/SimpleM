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

import calendar as _calendar
import logging
from datetime import date, datetime, timedelta
from typing import Any, Optional
from app.utils.datetime_kst import today_kst

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

def _profile_dict(p, windows: Optional[list[dict[str, int]]] = None) -> dict[str, Any]:
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
        "color": getattr(p, "color", None),
        # 근무 요일 코드 — 근무 달력 화면(직원·스케줄)이 요일 선을 그릴 때 쓴다.
        # 별도 입력을 또 받지 않고 '근무 가능 시간'에서 뽑는다 (출처가 둘이면 반드시 어긋난다).
        "work_days": work_day_codes(windows or []),
    }


WEEKDAY_CODES = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]  # 0=월 … 6=일


def work_day_codes(windows: list[dict[str, int]]) -> list[str]:
    """가능 시간대가 걸쳐 있는 요일 코드 목록 (월요일부터 순서대로)."""
    days = sorted({w["day_of_week"] for w in windows})
    return [WEEKDAY_CODES[d] for d in days if 0 <= d <= 6]


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
        "color": None,
        "work_days": [],
        "unset": True,  # 화면에서 "상세 정보를 채워 주세요"를 띄우기 위한 표시
    }


PROFILE_FIELDS = {"employment_type", "pay_type", "monthly_salary", "weekly_hours",
                  "insurance", "weekly_holiday_pay", "hired_on", "memo", "color"}
# 직원 기본 정보(employees 테이블) — 이름·시급·직책은 프로필과 한 화면에서 같이 고치므로
# 여기서 함께 받는다. 따로 두면 "시급만 저장이 안 됐다" 같은 반쪽 저장이 생긴다.
BASIC_FIELDS = {"name", "hourly_rate", "role"}


def _validate(fields: dict[str, Any]) -> None:
    if fields.get("employment_type") and fields["employment_type"] not in {t["code"] for t in EMPLOYMENT_TYPES}:
        raise StaffError(f"알 수 없는 고용형태입니다: {fields['employment_type']}")
    if fields.get("insurance") and fields["insurance"] not in {t["code"] for t in INSURANCE_TYPES}:
        raise StaffError(f"알 수 없는 보험 유형입니다: {fields['insurance']}")
    if fields.get("pay_type") and fields["pay_type"] not in {"hourly", "monthly"}:
        raise StaffError(f"알 수 없는 급여형태입니다: {fields['pay_type']}")


def _staff_entry(db, emp, prof: dict[str, Any], month: Optional[str] = None) -> dict[str, Any]:
    """목록(list_staff)의 한 줄과 똑같은 모양 — 저장 직후 화면이 그 줄만 갈아끼울 수 있게.

    저장할 때마다 목록 전체를 다시 부르면 Neon 왕복이 한 번 더 붙어 '눌러도 반응이 없는'
    체감이 생긴다. 저장 응답이 곧 최신 상태가 되도록 계산 결과까지 함께 돌려준다.
    """
    target_month = month or today_kst().strftime("%Y-%m")
    scheduled = _scheduled_hours_by_employee(db, [emp.id], target_month).get(emp.id, 0.0)
    windows = _availability_by_employee(db, [emp.id]).get(emp.id, [])
    return {
        "id": emp.id,
        "name": emp.name,
        "role": emp.role,
        "hourly_rate": emp.hourly_rate,
        "scheduled_hours": scheduled,
        "profile": prof,
        "availability": windows,
        "availability_text": describe_windows(windows),
        "cost": estimate_labor_cost(emp.hourly_rate or 0, prof, scheduled),
    }


def create_staff(store_id: str, name: str, hourly_rate: int = 0,
                 role: str = "알바", **fields) -> dict[str, Any]:
    """직원 등록 + 고용 상세를 한 번에 저장한다.

    예전엔 등록(operation의 /employees)과 상세 저장이 두 번의 요청으로 나뉘어 있었다.
    그래서 이름·시급만 등록되고 고용형태·보험은 기본값으로 남는 직원이 생겼고, 사장님은
    추가 직후 목록에서 다시 펼쳐 네 가지를 또 골라야 했다. 한 트랜잭션으로 묶는다.
    """
    from app.models.ai import EmployeeProfile
    from app.models.operation import Employee

    name = (name or "").strip()
    if not name:
        raise StaffError("직원 이름을 입력해 주세요.")
    windows = _clean_windows(fields.pop("availability", None) or [])
    _validate(fields)

    db = _session()
    try:
        emp = Employee(
            store_id=store_id,
            name=name,
            hourly_rate=int(hourly_rate or 0),
            role=(role or "").strip() or "알바",
        )
        db.add(emp)
        db.flush()  # id 확보 — 프로필이 이 id를 참조한다

        base = _default_profile(emp.id)
        base.pop("unset", None)
        base.pop("work_days", None)  # 저장 컬럼이 아니라 가능 시간에서 뽑는 파생값이다
        base.update({k: v for k, v in fields.items() if k in PROFILE_FIELDS and v is not None})
        p = EmployeeProfile(store_id=store_id, **base)
        db.add(p)
        # 근무 가능 시간도 같은 트랜잭션에서 — 등록할 때 물어본 답이 흩어지지 않게
        from app.models.ai import EmployeeAvailability
        for w in windows:
            db.add(EmployeeAvailability(employee_id=emp.id, store_id=store_id, **w))
        db.commit()
        db.refresh(emp)
        db.refresh(p)
        return _staff_entry(db, emp, _profile_dict(p, windows))
    finally:
        db.close()


def save_profile(store_id: str, employee_id: int, **fields) -> dict[str, Any]:
    from app.models.ai import EmployeeAvailability, EmployeeProfile
    from app.models.operation import Employee

    # 근무 가능 시간은 통째로 교체한다. 키가 아예 안 오면 건드리지 않는다(부분 저장 보호).
    raw_windows = fields.pop("availability", None)
    windows = _clean_windows(raw_windows) if raw_windows is not None else None
    _validate(fields)

    db = _session()
    try:
        emp = db.get(Employee, employee_id)
        if emp is None:
            raise StaffError(f"직원(id={employee_id})을 찾을 수 없습니다.")
        # 남의 매장 직원을 고칠 수 없게 막는다 (store_id가 비어 있는 레거시 직원은 통과)
        if emp.store_id and emp.store_id != store_id:
            raise StaffError("다른 매장의 직원입니다.")

        for k in BASIC_FIELDS:
            v = fields.get(k)
            if v is None:
                continue
            if k in {"name", "role"}:
                v = str(v).strip()
                if not v:
                    continue
            if k == "hourly_rate":
                v = int(v)
            setattr(emp, k, v)

        p = db.get(EmployeeProfile, employee_id)
        if p is None:
            p = EmployeeProfile(employee_id=employee_id, store_id=store_id)
            db.add(p)
        p.store_id = store_id
        for k, v in fields.items():
            if k in PROFILE_FIELDS and v is not None:
                setattr(p, k, v)

        if windows is not None:
            db.query(EmployeeAvailability).filter(
                EmployeeAvailability.employee_id == employee_id
            ).delete(synchronize_session=False)
            for w in windows:
                db.add(EmployeeAvailability(employee_id=employee_id, store_id=store_id, **w))
        db.commit()
        db.refresh(emp)
        db.refresh(p)
        saved = _availability_by_employee(db, [employee_id]).get(employee_id, [])
        return _staff_entry(db, emp, _profile_dict(p, saved))
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
        # 실제 출퇴근은 **둘 다 있을 때만** 쓴다 — _payroll_rows와 같은 규칙이어야 한다.
        #
        # 예전엔 필드별로 `actual or 계획`을 섞어서, 출근만 찍고 퇴근을 안 찍은 근무
        # (현업에서 흔하다)에 실제 시작시각 + 계획 종료시각이 조합됐다. 계획 09:00–18:00에
        # 08:30 출근만 찍히면 여기선 9.5시간, 급여 화면은 9.0시간 — 시급 12,000원 기준
        # 한 번에 6,000원, 월 20회면 12만원이 두 화면에서 어긋났다. 지각이면 반대로 벌어진다.
        use_actual = bool(s.actual_start_time and s.actual_end_time)
        st = s.actual_start_time if use_actual else s.start_time
        et = s.actual_end_time if use_actual else s.end_time
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

    target_month = month or today_kst().strftime("%Y-%m")

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
        availability = _availability_by_employee(db, emp_ids)
        profiles = {
            p.employee_id: _profile_dict(p, availability.get(p.employee_id, []))
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
        windows = availability.get(e.id, [])
        staff.append({
            "id": e.id,
            "name": e.name,
            "role": e.role,
            "hourly_rate": e.hourly_rate,
            "scheduled_hours": scheduled.get(e.id, 0.0),
            "profile": prof,
            "availability": windows,
            "availability_text": describe_windows(windows),
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


# ---------------------------------------------------------------------------
# 근무 가능 시간 (주간 반복) — "이 알바 언제 돼요?"의 답을 그대로 담는다
# ---------------------------------------------------------------------------
WEEKDAY_LABELS = ["월", "화", "수", "목", "금", "토", "일"]  # 0=월 (employee_unavailabilities와 같은 규칙)


def _clean_windows(windows: list[dict[str, Any]]) -> list[dict[str, int]]:
    """화면에서 온 가능 시간대를 정리한다 — 범위 검증, 중복 제거, 요일·시작시각 순 정렬."""
    out: dict[tuple[int, int, int], dict[str, int]] = {}
    for w in windows or []:
        try:
            dow = int(w.get("day_of_week"))
            start = int(w.get("start_hour", 9))
            end = int(w.get("end_hour", 18))
        except (TypeError, ValueError):
            raise StaffError("근무 가능 시간 형식이 올바르지 않습니다.")
        if not 0 <= dow <= 6:
            raise StaffError(f"요일 값이 올바르지 않습니다: {dow}")
        start = max(0, min(23, start))
        end = max(1, min(24, end))
        if end <= start:
            raise StaffError(f"{WEEKDAY_LABELS[dow]}요일 가능 시간이 잘못됐어요 (시작 {start}시 ≥ 종료 {end}시).")
        out[(dow, start, end)] = {"day_of_week": dow, "start_hour": start, "end_hour": end}
    return sorted(out.values(), key=lambda w: (w["day_of_week"], w["start_hour"]))


def _availability_by_employee(db, emp_ids: list[int]) -> dict[int, list[dict[str, int]]]:
    from app.models.ai import EmployeeAvailability

    if not emp_ids:
        return {}
    rows = (
        db.query(EmployeeAvailability)
        .filter(EmployeeAvailability.employee_id.in_(emp_ids))
        .all()
    )
    out: dict[int, list[dict[str, int]]] = {}
    for r in rows:
        out.setdefault(r.employee_id, []).append({
            "day_of_week": r.day_of_week,
            "start_hour": r.start_hour,
            "end_hour": r.end_hour,
        })
    for v in out.values():
        v.sort(key=lambda w: (w["day_of_week"], w["start_hour"]))
    return out


def describe_windows(windows: list[dict[str, int]]) -> str:
    """'월·수 09~14시, 토 13~22시'처럼 한 줄로 — 화면과 챗봇이 같은 문장을 쓰게."""
    if not windows:
        return "가능 시간 미입력"
    by_time: dict[tuple[int, int], list[int]] = {}
    for w in windows:
        by_time.setdefault((w["start_hour"], w["end_hour"]), []).append(w["day_of_week"])
    parts = []
    for (start, end), days in sorted(by_time.items(), key=lambda kv: (min(kv[1]), kv[0])):
        label = "·".join(WEEKDAY_LABELS[d] for d in sorted(days))
        parts.append(f"{label} {start:02d}~{end:02d}시")
    return ", ".join(parts)


def save_availability(store_id: str, employee_id: int,
                      windows: list[dict[str, Any]]) -> list[dict[str, int]]:
    """근무 가능 시간을 통째로 교체한다 (부분 수정보다 화면과 어긋날 여지가 없다)."""
    from app.models.ai import EmployeeAvailability
    from app.models.operation import Employee

    cleaned = _clean_windows(windows)
    db = _session()
    try:
        emp = db.get(Employee, employee_id)
        if emp is None:
            raise StaffError(f"직원(id={employee_id})을 찾을 수 없습니다.")
        if emp.store_id and emp.store_id != store_id:
            raise StaffError("다른 매장의 직원입니다.")
        db.query(EmployeeAvailability).filter(
            EmployeeAvailability.employee_id == employee_id
        ).delete(synchronize_session=False)
        for w in cleaned:
            db.add(EmployeeAvailability(employee_id=employee_id, store_id=store_id, **w))
        db.commit()
        return cleaned
    finally:
        db.close()


def _covers(windows: list[dict[str, int]], dow: int, start_hour: float, end_hour: float) -> Optional[bool]:
    """그 요일·시간대가 가능 시간 안에 들어가나? 가능 시간을 아예 안 적었으면 None(판단 보류)."""
    if not windows:
        return None
    for w in windows:
        if w["day_of_week"] == dow and w["start_hour"] <= start_hour and end_hour <= w["end_hour"]:
            return True
    return False


# ---------------------------------------------------------------------------
# 근무 달력 — 배정된 근무 + 그날 가능한 직원 + 교대
# ---------------------------------------------------------------------------

def _shift_dict(s, emp, windows: list[dict[str, int]], color: Optional[str] = None) -> dict[str, Any]:
    st, et = s.start_time, s.end_time
    hours = round((et - st).total_seconds() / 3600, 1) if st and et else 0.0
    if hours < 0:
        hours += 24
    dow = (st.weekday()) if st else 0
    end_hour = et.hour + et.minute / 60 if et else 0
    if et and et.date() > st.date():  # 자정을 넘긴 근무는 24시로 본다
        end_hour = 24
    fits = _covers(windows, dow, (st.hour + st.minute / 60) if st else 0, end_hour)
    return {
        "id": s.id,
        "employee_id": s.employee_id,
        "name": emp.name if emp else "(삭제된 직원)",
        "role": emp.role if emp else "",
        "date": s.date,
        "start": st.strftime("%H:%M") if st else "",
        "end": et.strftime("%H:%M") if et else "",
        "hours": hours,
        # 직원 대표 색 — 달력 점과 직원·스케줄 화면의 요일 선이 같은 색이어야 한 사람으로 읽힌다
        "color": color,
        # True=가능 시간 안 / False=가능 시간 밖(교대 필요할 수 있음) / None=가능 시간 미입력
        "fits_availability": fits,
    }


def month_calendar(store_id: str, month: Optional[str] = None) -> dict[str, Any]:
    """한 달 치 근무 배정표 — 날짜별로 '누가 일하는지'와 '누가 가능한지'를 함께 준다.

    달력이 배정만 보여주면 빈 날에 누구를 넣어야 할지 매번 직원 목록을 뒤져야 한다.
    그날 요일에 가능하다고 적어 둔 직원을 같이 실어 보내면 바로 고를 수 있다.
    """
    from app.models.ai import EmployeeProfile
    from app.models.operation import Employee, Schedule

    target = month or today_kst().strftime("%Y-%m")
    try:
        year, mon = int(target[:4]), int(target[5:7])
        first = date(year, mon, 1)
    except (ValueError, IndexError):
        raise StaffError("월 형식이 올바르지 않습니다 (YYYY-MM).")
    last = date(year, mon, _calendar.monthrange(year, mon)[1])

    db = _session()
    try:
        employees = db.query(Employee).filter(Employee.store_id == store_id).order_by(Employee.id).all()
        emp_ids = [e.id for e in employees]
        emp_map = {e.id: e for e in employees}
        avail = _availability_by_employee(db, emp_ids)
        colors = {
            p.employee_id: getattr(p, "color", None)
            for p in db.query(EmployeeProfile).filter(EmployeeProfile.employee_id.in_(emp_ids)).all()
        } if emp_ids else {}
        rows = (
            db.query(Schedule)
            .filter(Schedule.employee_id.in_(emp_ids), Schedule.date.like(f"{target}%"))
            .order_by(Schedule.start_time)
            .all()
        ) if emp_ids else []
        shifts_by_date: dict[str, list[dict[str, Any]]] = {}
        for s in rows:
            shifts_by_date.setdefault(s.date, []).append(
                _shift_dict(s, emp_map.get(s.employee_id), avail.get(s.employee_id, []),
                            colors.get(s.employee_id))
            )
    finally:
        db.close()

    days = []
    cur = first
    while cur <= last:
        dow = cur.weekday()
        iso = cur.isoformat()
        shifts = shifts_by_date.get(iso, [])
        assigned = {s["employee_id"] for s in shifts}
        available = [
            {
                "employee_id": e.id,
                "name": e.name,
                "role": e.role,
                "color": colors.get(e.id),
                "windows": [w for w in avail.get(e.id, []) if w["day_of_week"] == dow],
                "already_assigned": e.id in assigned,
            }
            for e in employees
            if any(w["day_of_week"] == dow for w in avail.get(e.id, []))
        ]
        days.append({
            "date": iso,
            "weekday": dow,
            "weekday_label": WEEKDAY_LABELS[dow],
            "shifts": shifts,
            "hours": round(sum(s["hours"] for s in shifts), 1),
            "available": available,
        })
        cur += timedelta(days=1)

    return {
        "month": target,
        "days": days,
        "staff": [
            {
                "id": e.id,
                "name": e.name,
                "role": e.role,
                "color": colors.get(e.id),
                "availability": avail.get(e.id, []),
                "availability_text": describe_windows(avail.get(e.id, [])),
            }
            for e in employees
        ],
        "weekday_labels": WEEKDAY_LABELS,
    }


def _parse_hhmm(value: str, field: str) -> tuple[int, int]:
    try:
        hh, mm = value.split(":")
        h, m = int(hh), int(mm)
        if not (0 <= h <= 24 and 0 <= m < 60):
            raise ValueError
        return h, m
    except (AttributeError, ValueError):
        raise StaffError(f"{field} 시간 형식이 올바르지 않습니다 (예: 09:00).")


def _shift_times(day: str, start: str, end: str) -> tuple[datetime, datetime]:
    try:
        base = date.fromisoformat(day)
    except ValueError:
        raise StaffError("근무 날짜 형식이 올바르지 않습니다 (YYYY-MM-DD).")
    sh, sm = _parse_hhmm(start, "시작")
    eh, em = _parse_hhmm(end, "종료")
    st = datetime(base.year, base.month, base.day) + timedelta(hours=sh, minutes=sm)
    et = datetime(base.year, base.month, base.day) + timedelta(hours=eh, minutes=em)
    if et <= st:
        et += timedelta(days=1)  # 자정을 넘긴 마감 근무
    if (et - st) > timedelta(hours=24):
        raise StaffError("근무 시간이 24시간을 넘을 수 없어요.")
    return st, et


def _employee_of_store(db, employee_id: int, store_id: str):
    from app.models.operation import Employee

    emp = db.get(Employee, employee_id)
    if emp is None:
        raise StaffError(f"직원(id={employee_id})을 찾을 수 없습니다.")
    if emp.store_id and emp.store_id != store_id:
        raise StaffError("다른 매장의 직원입니다.")
    return emp


def add_shift(store_id: str, employee_id: int, day: str,
              start: str = "09:00", end: str = "18:00") -> dict[str, Any]:
    """달력에 근무 하나를 넣는다 (가능 시간 밖이어도 막지 않고 표시만 한다).

    사장님이 급할 땐 가능 시간 밖에도 부탁해서 넣는다 — 막아 버리면 앱을 못 쓰게 된다.
    대신 응답의 fits_availability로 화면이 "이 날은 원래 안 된다고 했어요"를 보여 준다.
    """
    from app.models.operation import Schedule

    st, et = _shift_times(day, start, end)
    db = _session()
    try:
        emp = _employee_of_store(db, employee_id, store_id)
        s = Schedule(employee_id=emp.id, start_time=st, end_time=et, date=st.strftime("%Y-%m-%d"))
        db.add(s)
        db.commit()
        db.refresh(s)
        return _shift_dict(s, emp, _availability_by_employee(db, [emp.id]).get(emp.id, []))
    finally:
        db.close()


def apply_availability(store_id: str, month: Optional[str] = None,
                       employee_id: Optional[int] = None,
                       from_today: bool = True) -> dict[str, Any]:
    """등록해 둔 근무 가능 시간을 그 달 달력에 실제 근무로 채운다.

    "언제 돼요?"를 받아 놨는데 달력은 여전히 비어 있으면, 사장님이 그 답을 보고 31일치를
    손으로 옮겨 적어야 한다. 여기서 한 번에 만들어 주면 기존 '알바 근무 달력 스케줄표'에
    그대로 나타난다(같은 schedules 테이블을 쓴다).

    · 지난 날짜는 만들지 않는다 (이번 달이면 오늘부터)
    · 그 날 그 직원의 근무가 이미 있으면 건너뛴다 — 여러 번 눌러도 중복이 안 쌓인다
    """
    from app.models.operation import Employee, Schedule

    target = month or today_kst().strftime("%Y-%m")
    try:
        year, mon = int(target[:4]), int(target[5:7])
        first = date(year, mon, 1)
    except (ValueError, IndexError):
        raise StaffError("월 형식이 올바르지 않습니다 (YYYY-MM).")
    last = date(year, mon, _calendar.monthrange(year, mon)[1])
    today = today_kst()
    # 기본은 오늘부터 — 지난 날짜에 근무를 새로 만들면 이미 지급한 급여가 바뀐다.
    # 통째로 지난 달이면 start_day가 last를 넘어가 아무것도 만들지 않는다.
    # (데모 시드 스크립트만 from_today=False로 그 달 전체를 채운다)
    start_day = max(first, today) if from_today else first

    db = _session()
    try:
        q = db.query(Employee).filter(Employee.store_id == store_id)
        if employee_id is not None:
            q = q.filter(Employee.id == employee_id)
        employees = q.order_by(Employee.id).all()
        emp_ids = [e.id for e in employees]
        if not emp_ids:
            return {"month": target, "created": 0, "skipped": 0, "shifts": []}

        avail = _availability_by_employee(db, emp_ids)
        existing = {
            (s.employee_id, s.date)
            for s in db.query(Schedule).filter(
                Schedule.employee_id.in_(emp_ids), Schedule.date.like(f"{target}%")
            ).all()
        }

        created, skipped = [], 0
        for e in employees:
            windows = avail.get(e.id, [])
            if not windows:
                continue
            cur = start_day
            while cur <= last:
                for w in windows:
                    if w["day_of_week"] != cur.weekday():
                        continue
                    key = (e.id, cur.isoformat())
                    if key in existing:
                        skipped += 1
                        continue
                    st, et = _shift_times(cur.isoformat(), f"{w['start_hour']:02d}:00",
                                          f"{w['end_hour'] % 24:02d}:00")
                    s = Schedule(employee_id=e.id, start_time=st, end_time=et,
                                 date=cur.isoformat())
                    db.add(s)
                    existing.add(key)  # 같은 날 두 시간대가 있어도 한 번만 넣는다
                    created.append((s, e))
                cur += timedelta(days=1)

        db.commit()
        shifts = []
        for s, e in created:
            db.refresh(s)
            shifts.append(_shift_dict(s, e, avail.get(e.id, [])))
        return {"month": target, "created": len(shifts), "skipped": skipped, "shifts": shifts}
    finally:
        db.close()


def update_shift(store_id: str, schedule_id: int, employee_id: Optional[int] = None,
                 start: Optional[str] = None, end: Optional[str] = None,
                 day: Optional[str] = None) -> dict[str, Any]:
    """근무를 다른 직원에게 넘기거나(교대) 시간을 고친다.

    교대는 실제로 가장 자주 일어나는 변경인데(알바끼리 바꿔 오면 사장님이 반영해야 한다),
    기존 스케줄 수정 API는 시각만 바꿀 수 있어 담당자를 바꿀 방법이 없었다. 지우고 다시
    만들면 실제 출퇴근 기록(actual_*)이 날아가므로 같은 행의 담당자만 갈아 끼운다.
    """
    from app.models.operation import Employee, Schedule

    db = _session()
    try:
        s = db.get(Schedule, schedule_id)
        if s is None:
            raise StaffError("해당 근무를 찾을 수 없습니다.")
        owner = db.get(Employee, s.employee_id)
        if owner is not None and owner.store_id and owner.store_id != store_id:
            raise StaffError("다른 매장의 근무입니다.")

        emp = owner
        if employee_id is not None and employee_id != s.employee_id:
            emp = _employee_of_store(db, employee_id, store_id)
            s.employee_id = emp.id

        if start or end or day:
            base_day = day or s.date
            cur_start = s.start_time.strftime("%H:%M") if s.start_time else "09:00"
            cur_end = s.end_time.strftime("%H:%M") if s.end_time else "18:00"
            st, et = _shift_times(base_day, start or cur_start, end or cur_end)
            s.start_time, s.end_time = st, et
            s.date = st.strftime("%Y-%m-%d")

        db.commit()
        db.refresh(s)
        windows = _availability_by_employee(db, [s.employee_id]).get(s.employee_id, [])
        return _shift_dict(s, emp, windows)
    finally:
        db.close()


def remove_shift(store_id: str, schedule_id: int) -> None:
    from app.models.operation import Employee, Schedule

    db = _session()
    try:
        s = db.get(Schedule, schedule_id)
        if s is None:
            raise StaffError("해당 근무를 찾을 수 없습니다.")
        owner = db.get(Employee, s.employee_id)
        if owner is not None and owner.store_id and owner.store_id != store_id:
            raise StaffError("다른 매장의 근무입니다.")
        db.delete(s)
        db.commit()
    finally:
        db.close()


def _payroll_rows(employees: list, schedules: list) -> list[dict[str, Any]]:
    """직원별 월 예상 급여 행 — /operation/payroll/all과 같은 모양·같은 계산 기준.

    기존 경로는 직원 한 명마다 (직원 조회 + 스케줄 조회 + 저장 조회 + commit)을 반복해
    Neon 왕복이 직원 수 × 5번 붙었다. 직원 5명이면 이 목록 하나에 5초가 걸렸고,
    정산 계산이 내부에서 이걸 또 불러 '정산·급여' 카드가 10초 가까이 비어 있었다.
    여기서는 미리 받아 둔 직원·스케줄 두 목록만으로 같은 숫자를 만든다 (조회 중 DB 쓰기 없음).

    기존과 같은 규칙: 실제 출퇴근(actual_*)이 둘 다 있으면 그것을, 없으면 계획 시간.
    시급이 0이거나 그 달 스케줄이 없는 직원은 목록에서 빠진다.
    """
    hours: dict[int, float] = {}
    actual: dict[int, bool] = {}
    for s in schedules:
        use_actual = bool(s.actual_start_time and s.actual_end_time)
        st = s.actual_start_time if use_actual else s.start_time
        et = s.actual_end_time if use_actual else s.end_time
        if not st or not et:
            continue
        dur = (et - st).total_seconds() / 3600
        if dur < 0:  # 자정을 넘긴 근무
            dur += 24
        if dur <= 0:
            continue
        hours[s.employee_id] = hours.get(s.employee_id, 0.0) + dur
        if use_actual:
            actual[s.employee_id] = True

    rows = []
    for e in employees:
        rate = e.hourly_rate or 0
        h = hours.get(e.id, 0.0)
        if rate <= 0 or h <= 0:
            continue
        base = int(h * rate)
        # 주휴수당 — 주 평균 15시간 이상이면 포함. /operation/payroll/all(calculate_payroll_from_db)
        # 및 직원 목록의 예상 인건비(estimate_labor_cost)와 같은 규칙 — 화면마다 월급이
        # 다르게 보이던 불일치의 해소. 이 목록은 월 단위라 월 평균 주 수(WEEKS_PER_MONTH)를 쓴다.
        weekly_avg = h / WEEKS_PER_MONTH
        holiday = 0
        if weekly_avg >= 15.0:
            holiday = int(round(min(1.0, weekly_avg / 40.0) * 8 * rate * WEEKS_PER_MONTH))
        rows.append({
            "employee_id": e.id,
            "employee_name": e.name,
            "role": e.role,
            "hourly_rate": rate,
            "total_work_hours": h,
            "base_salary": base,
            "weekly_holiday_allowance": holiday,
            "estimated_salary": base + holiday,
            "based_on_actual": actual.get(e.id, False),
        })
    return rows


def monthly_payroll(store_id: str, year_month: Optional[str] = None) -> list[dict[str, Any]]:
    """전 직원 월 예상 급여 목록 — 직원 수와 무관하게 DB 왕복 2번."""
    from app.models.operation import Employee, Schedule

    target = year_month or today_kst().strftime("%Y-%m")
    try:
        date(int(target[:4]), int(target[5:7]), 1)
    except (ValueError, IndexError):
        raise StaffError("월 형식이 올바르지 않습니다 (YYYY-MM).")

    db = _session()
    try:
        employees = db.query(Employee).filter(Employee.store_id == store_id).order_by(Employee.id).all()
        emp_ids = [e.id for e in employees]
        schedules = (
            db.query(Schedule)
            .filter(Schedule.employee_id.in_(emp_ids), Schedule.date.like(f"{target}%"))
            .all()
        ) if emp_ids else []
    finally:
        db.close()

    rows = _payroll_rows(employees, schedules)
    # 말일은 달마다 다르다 — "-31" 고정은 2월이면 2026-02-31 같은 존재하지 않는 날짜가
    # 응답에 실려 클라이언트 날짜 파서가 깨질 수 있다.
    y, m = int(target[:4]), int(target[5:7])
    last_day = _calendar.monthrange(y, m)[1]
    for r in rows:
        r["period_start"] = f"{target}-01"
        r["period_end"] = f"{target}-{last_day:02d}"
    return rows


def month_settlement(store_id: str, year_month: Optional[str] = None) -> dict[str, Any]:
    """월 손익 정산 + 직원별 급여를 한 응답으로 — '정산·급여' 카드가 요청 1번으로 그려지게.

    기존 경로는 정산(내부에서 급여 N+1 재실행)과 급여 목록을 각각 불러 왕복이
    (직원 수 × 5) × 2 + α였다. 여기서는 매출 합계 1 + 지출 합계 1 + 직원 1 + 스케줄 1,
    총 4번으로 같은 숫자를 만든다. 집계 기준(매출=Sale, 비용=Expense, 인건비=스케줄×시급)은
    기존 /operation/settlements/calculate와 동일하다.
    """
    from sqlalchemy import func as sa_func

    from app.models.inventory import Sale
    from app.models.operation import Employee, Expense, Schedule

    target = year_month or today_kst().strftime("%Y-%m")
    # sold_at은 timestamptz — naive 경계를 주면 UTC 자정으로 잘려 KST 00:00~08:59 매출
    # (아침 러시 포함)이 전달 정산으로 넘어간다. /operation/settlements/calculate와 같은
    # 기준(KST 명시)이어야 '집계 기준 동일'이라는 이 함수의 약속이 지켜진다.
    from app.utils.datetime_kst import KST
    try:
        year, mon = int(target[:4]), int(target[5:7])
        p_start_dt = datetime(year, mon, 1, tzinfo=KST)
    except (ValueError, IndexError):
        raise StaffError("월 형식이 올바르지 않습니다 (YYYY-MM).")
    p_end_dt = (datetime(year + 1, 1, 1, tzinfo=KST) if mon == 12
                else datetime(year, mon + 1, 1, tzinfo=KST))
    p_start, p_end = f"{target}-01", f"{target}-{_calendar.monthrange(year, mon)[1]:02d}"

    db = _session()
    try:
        revenue = int(
            db.query(sa_func.sum(Sale.total_price))
            .filter(Sale.store_id == store_id,
                    Sale.sold_at >= p_start_dt, Sale.sold_at < p_end_dt)
            .scalar() or 0
        )
        cost = int(
            db.query(sa_func.sum(Expense.amount))
            .filter(Expense.store_id == store_id,
                    Expense.expense_date >= p_start, Expense.expense_date <= p_end)
            .scalar() or 0
        )
        employees = db.query(Employee).filter(Employee.store_id == store_id).order_by(Employee.id).all()
        emp_ids = [e.id for e in employees]
        schedules = (
            db.query(Schedule)
            .filter(Schedule.employee_id.in_(emp_ids), Schedule.date.like(f"{target}%"))
            .all()
        ) if emp_ids else []
    finally:
        db.close()

    payroll = _payroll_rows(employees, schedules)
    labor_cost = sum(r["estimated_salary"] for r in payroll)
    total_cost = cost + labor_cost
    profit = revenue - total_cost
    return {
        "settlement": {
            "revenue": revenue,
            "cost": cost,
            "labor_cost": labor_cost,
            "other_expense": 0,
            "total_cost": total_cost,
            "estimated_profit": profit,
            "profit_rate": round(profit / revenue * 100, 2) if revenue > 0 else None,
            # 프론트 정산 카드가 쓰는 total_* 호환 필드
            "total_sales": revenue,
            "total_expense": cost,
            "total_payroll": labor_cost,
            "net_profit": profit,
            "year_month": target,
            "period_start": p_start,
            "period_end": p_end,
            "disclaimer": "본 정산 결과는 확정 정산이 아닌 단순 참고용 예상 정산 결과입니다.",
        },
        "payroll": payroll,
    }


def weekly_payroll(store_id: str, week_start: Optional[str] = None) -> dict[str, Any]:
    """주급 지급용 — 등록된 스케줄 기준으로 이번 주 실제 근무시간과 지급액을 뽑는다.

    주급으로 정산하는 매장이 많은데(알바), 월 단위 추정만으로는 "이번 주 얼마 주지?"에
    답이 안 된다. 스케줄이 없는 직원은 소정근로시간 기준 추정치로 채운다.
    """
    from app.models.ai import EmployeeProfile
    from app.models.operation import Employee, Schedule

    today = today_kst()
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
        avail = _availability_by_employee(db, emp_ids) if emp_ids else {}
        profiles = {
            p.employee_id: _profile_dict(p, avail.get(p.employee_id, []))
            for p in db.query(EmployeeProfile).filter(EmployeeProfile.employee_id.in_(emp_ids)).all()
        } if emp_ids else {}
    finally:
        db.close()

    hours_by_emp: dict[int, float] = {}
    for s in schedules:
        # 출퇴근 둘 다 찍혔을 때만 실제 시각을 쓴다 — 한쪽만 찍힌 근무에 실제+계획을 섞으면
        # 이 주간 급여만 다른 화면(월 급여·스케줄)과 시간이 어긋난다. _scheduled_hours_by_employee,
        # _payroll_rows와 같은 규칙 (2026-08-12: 여기만 예전 규칙이 남아 있었다)
        use_actual = bool(s.actual_start_time and s.actual_end_time)
        st = s.actual_start_time if use_actual else s.start_time
        et = s.actual_end_time if use_actual else s.end_time
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
