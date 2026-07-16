"""세금계산 로직 (백엔드 C 최초 작성 → 백엔드 B 인수)

부가가치세 + 종합소득세(누진) + 원천징수세를 한국 실세율에 근사해 계산한다.
모든 결과는 **참고용 근사값**이며 공제·과세유형·업종별 세부 규정을 단순화했다.
"""
from datetime import date
from typing import Dict, List, Optional
from sqlalchemy.orm import Session

from app.models.operation import Employee, Schedule
from app.services.operation.operation_service import OperationService

# 종합소득세 누진세율표 (2024~2026 기준): (과세표준 상한, 세율, 누진공제액)
INCOME_TAX_BRACKETS = [
    (14_000_000, 0.06, 0),
    (50_000_000, 0.15, 1_260_000),
    (88_000_000, 0.24, 5_760_000),
    (150_000_000, 0.35, 15_440_000),
    (300_000_000, 0.38, 19_940_000),
    (500_000_000, 0.40, 25_940_000),
    (1_000_000_000, 0.42, 35_940_000),
    (float("inf"), 0.45, 65_940_000),
]

# 종합소득 기본공제(본인) 근사값
BASIC_DEDUCTION = 1_500_000
# 간이과세 음식점업 부가가치율 근사
SIMPLIFIED_VALUE_ADDED_RATE = 0.15
# 일용근로소득 1일 비과세 한도
DAILY_TAX_FREE_LIMIT = 150_000

DISCLAIMER = (
    "이 계산은 참고용 예상 근사값이며 실제 신고 금액과 다를 수 있습니다. "
    "공제·과세유형·업종별 세부 규정을 단순화했으므로 정확한 신고는 세무 전문가 또는 관련 기관 확인이 필요합니다."
)


class TaxService:
    """부가세·종합소득세·원천징수세 예상 연산을 담당하는 서비스 클래스"""

    # ---------- 개별 세목 계산 ----------

    @staticmethod
    def calculate_vat(total_revenue: int, total_expense: int, tax_type: str = "general") -> Dict:
        """부가가치세 예상액을 계산합니다. (매출·비용은 부가세 포함 금액으로 가정)
        - general(일반과세): 매출세액(매출×10/110) − 매입세액(비용×10/110)
        - simplified(간이과세): 공급대가(매출) × 업종부가가치율 × 10%
        """
        if total_revenue < 0 or total_expense < 0:
            raise ValueError("매출액과 비용은 0 이상이어야 합니다.")

        if tax_type == "simplified":
            vat = int(total_revenue * SIMPLIFIED_VALUE_ADDED_RATE * 0.10)
            basis = (
                f"간이과세: 공급대가 {total_revenue:,}원 × 부가가치율 {int(SIMPLIFIED_VALUE_ADDED_RATE*100)}%"
                f"(음식점업 근사) × 10% = {vat:,}원"
            )
        else:
            output_vat = int(total_revenue * 10 / 110)   # 매출세액
            input_vat = int(total_expense * 10 / 110)    # 매입세액
            vat = max(output_vat - input_vat, 0)
            basis = (
                f"일반과세: 매출세액 {output_vat:,}원(매출 {total_revenue:,}×10/110) "
                f"− 매입세액 {input_vat:,}원(비용 {total_expense:,}×10/110) = {vat:,}원"
            )
        return {"amount": vat, "basis": basis}

    @staticmethod
    def calculate_income_tax(total_revenue: int, total_expense: int) -> Dict:
        """종합소득세(사업소득) 예상 산출세액을 누진세율표로 계산합니다.
        과세표준 = 매출 − 필요경비(비용) − 기본공제. 누진공제 반영.
        (연 단위 세율표를 대상 기간 금액에 적용한 참고용 근사)
        """
        if total_revenue < 0 or total_expense < 0:
            raise ValueError("매출액과 비용은 0 이상이어야 합니다.")

        taxable_base = max(total_revenue - total_expense - BASIC_DEDUCTION, 0)
        rate, deduction = INCOME_TAX_BRACKETS[-1][1], INCOME_TAX_BRACKETS[-1][2]
        for upper, r, d in INCOME_TAX_BRACKETS:
            if taxable_base <= upper:
                rate, deduction = r, d
                break

        income_tax = max(int(taxable_base * rate - deduction), 0)
        basis = (
            f"과세표준 {taxable_base:,}원(매출 {total_revenue:,} − 경비 {total_expense:,} "
            f"− 기본공제 {BASIC_DEDUCTION:,}) × {int(rate*100)}% − 누진공제 {deduction:,} = {income_tax:,}원"
        )
        return {"amount": income_tax, "taxable_base": taxable_base, "rate": rate, "basis": basis}

    @staticmethod
    def calculate_withholding_tax(payment: int, income_type: str = "daily") -> Dict:
        """1회 지급액 기준 원천징수세액(소득세+지방소득세)을 계산합니다.
        - daily(일용근로): (지급액 − 15만) × 6% × (1 − 55% 세액공제) + 지방세 10%
        - business(사업소득 3.3%): 소득세 3% + 지방소득세 0.3%
        """
        if payment < 0:
            raise ValueError("지급액은 0 이상이어야 합니다.")

        if income_type == "business":
            income_tax = int(payment * 0.03)
            local_tax = int(payment * 0.003)
            basis = f"사업소득 원천징수 3.3%: 지급액 {payment:,}원 × (3% + 0.3%)"
        else:
            taxable = max(payment - DAILY_TAX_FREE_LIMIT, 0)
            income_tax = int(taxable * 0.06 * 0.45)  # 산출세액 × (1 − 근로소득세액공제 55%)
            local_tax = int(income_tax * 0.10)
            basis = (
                f"일용근로 원천징수: (지급액 {payment:,} − 비과세 {DAILY_TAX_FREE_LIMIT:,}) "
                f"× 6% × 45% + 지방세 10%"
            )
        total = income_tax + local_tax
        return {"amount": total, "income_tax": income_tax, "local_tax": local_tax, "basis": basis}

    @classmethod
    def calculate_monthly_withholding(cls, db: Session, year_month: str) -> Dict:
        """해당 월 스케줄(실 출퇴근 기록)의 1일 지급액마다 일용근로 원천징수를 합산합니다."""
        schedules = db.query(Schedule).filter(
            Schedule.date.like(f"{year_month}%"),
            Schedule.actual_start_time.isnot(None),
            Schedule.actual_end_time.isnot(None),
        ).all()

        total = 0
        work_days = 0
        for s in schedules:
            emp = db.query(Employee).filter(Employee.id == s.employee_id).first()
            if not emp:
                continue
            hours = OperationService.calculate_work_hours(s.actual_start_time, s.actual_end_time)
            daily_pay = int(hours * emp.hourly_rate)
            total += cls.calculate_withholding_tax(daily_pay, income_type="daily")["amount"]
            work_days += 1

        basis = f"해당 월 실근무 {work_days}일의 1일 지급액별 일용근로 원천징수 합산 = {total:,}원"
        return {"amount": total, "work_day_count": work_days, "basis": basis}

    # ---------- 신고 기한 (D-day) ----------

    @staticmethod
    def filing_deadlines(period: str, tax_type: str = "general") -> List[Dict]:
        """대상 기간(YYYY-MM)에 대한 세목별 신고 기한과 D-day를 계산합니다.
        - 부가세: 일반과세 1기(1~6월)→7/25, 2기(7~12월)→익년 1/25 / 간이과세→익년 1/25
        - 종합소득세: 익년 5/31
        - 원천징수세: 해당 월 다음달 10일
        """
        try:
            year, month = map(int, period.split("-"))
        except ValueError:
            raise ValueError("기간 포맷은 YYYY-MM 형식이어야 합니다.")

        today = date.today()

        # 부가가치세
        if tax_type == "simplified":
            vat_due = date(year + 1, 1, 25)
            vat_note = "간이과세 확정신고 (연 1회)"
        elif month <= 6:
            vat_due = date(year, 7, 25)
            vat_note = "일반과세 제1기 확정신고 (1~6월분)"
        else:
            vat_due = date(year + 1, 1, 25)
            vat_note = "일반과세 제2기 확정신고 (7~12월분)"

        # 종합소득세 (귀속연도 다음해 5월)
        income_due = date(year + 1, 5, 31)

        # 원천징수세 (다음달 10일)
        if month == 12:
            wh_due = date(year + 1, 1, 10)
        else:
            wh_due = date(year, month + 1, 10)

        items = [
            {"name": "부가가치세", "due_date": vat_due, "note": vat_note},
            {"name": "종합소득세", "due_date": income_due, "note": f"{year}년 귀속 종합소득세 신고"},
            {"name": "원천징수세", "due_date": wh_due, "note": "원천징수 이행상황 신고·납부 (다음달 10일)"},
        ]

        schedule = []
        for it in items:
            dday = (it["due_date"] - today).days
            if dday < 0:
                status = "기한 경과"
            elif dday <= 7:
                status = "임박"
            else:
                status = "예정"
            schedule.append({
                "name": it["name"],
                "due_date": it["due_date"].isoformat(),
                "dday": dday,
                "status": status,
                "note": it["note"],
            })
        # 기한이 가까운 순으로 정렬
        schedule.sort(key=lambda x: x["dday"])
        return schedule

    # ---------- 통합 계산 (응답 조립) ----------

    @classmethod
    def _assemble(
        cls, period: str, tax_type: str, total_revenue: int, total_expense: int,
        vat: Dict, income: Dict, withholding: Dict,
    ) -> Dict:
        """세목별 계산 결과를 API 응답 dict로 조립합니다."""
        total_tax = vat["amount"] + income["amount"] + withholding["amount"]
        lines: List[Dict] = [
            {"name": "부가가치세", "amount": vat["amount"], "basis": vat["basis"]},
            {"name": "종합소득세", "amount": income["amount"], "basis": income["basis"]},
            {"name": "원천징수세", "amount": withholding["amount"], "basis": withholding["basis"]},
        ]

        # 신고 기한 스케줄 (가장 임박한 항목이 맨 앞)
        filing_schedule = cls.filing_deadlines(period, tax_type)
        next_filing = filing_schedule[0] if filing_schedule else None

        summary = (
            f"{period} 기준 예상 세금 합계는 {total_tax:,}원입니다. "
            f"(부가세 {vat['amount']:,} / 종합소득세 {income['amount']:,} / 원천징수 {withholding['amount']:,})"
        )
        if next_filing:
            dday = next_filing["dday"]
            dday_label = f"D-{dday}" if dday > 0 else ("D-DAY" if dday == 0 else f"D+{abs(dday)}")
            summary += (
                f" 가장 임박한 신고는 {next_filing['name']}로 {next_filing['due_date']}까지({dday_label})입니다."
            )

        return {
            "period": period,
            "tax_type": tax_type,
            "total_revenue": total_revenue,
            "total_expense": total_expense,
            "taxable_base": income["taxable_base"],
            "vat": vat["amount"],
            "income_tax": income["amount"],
            "withholding_tax": withholding["amount"],
            "total_tax": total_tax,
            "lines": lines,
            "filing_schedule": filing_schedule,
            "next_filing": next_filing,
            "summary": summary,
            "disclaimer": DISCLAIMER,
        }

    @classmethod
    def estimate_taxes(
        cls, db: Session, year_month: str, tax_type: str = "general", store_id: Optional[str] = None
    ) -> Dict:
        """DB에서 해당 월 매출·비용을 자동집계하고 인건비 원천징수까지 통합해 예상 세금을 계산합니다."""
        totals = OperationService.get_period_totals(db, year_month, store_id)
        revenue, expense = totals["total_sales"], totals["total_expense"]

        vat = cls.calculate_vat(revenue, expense, tax_type)
        income = cls.calculate_income_tax(revenue, expense)
        withholding = cls.calculate_monthly_withholding(db, year_month)
        return cls._assemble(year_month, tax_type, revenue, expense, vat, income, withholding)

    @classmethod
    def estimate_from_amounts(
        cls, total_revenue: int, total_expense: int, period: str = "2026-07", tax_type: str = "general"
    ) -> Dict:
        """매출·비용을 직접 입력받아 부가세+종소세를 계산합니다. (원천징수는 인건비 데이터가 없어 0)
        챗봇/일회성 수동 계산용.
        """
        vat = cls.calculate_vat(total_revenue, total_expense, tax_type)
        income = cls.calculate_income_tax(total_revenue, total_expense)
        withholding = {"amount": 0, "basis": "수동 입력 계산 — 인건비 데이터 없음(원천징수 제외)"}
        return cls._assemble(period, tax_type, total_revenue, total_expense, vat, income, withholding)
