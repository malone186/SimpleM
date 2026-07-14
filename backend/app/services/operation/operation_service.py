"""운영(스케줄·급여) 로직 (백엔드 C)"""
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional
from app.models.operation import Employee, Schedule

# 가상 데이터베이스 구성
_employees_db: Dict[int, Employee] = {
    1: Employee(id=1, name="김민수", hourly_rate=10000, role="바리스타"),
    2: Employee(id=2, name="이영희", hourly_rate=11000, role="바리스타"),
    3: Employee(id=3, name="박철수", hourly_rate=12000, role="매니저")
}
_schedules_db: Dict[int, Schedule] = {}
_schedule_id_counter = 1

# 정산 계산을 위한 가상의 일별 매출 및 매입 지출 데이터셋
_sales_db: List[Dict[str, Any]] = [
    {"date": "2026-07-01", "amount": 500000},
    {"date": "2026-07-02", "amount": 600000},
    {"date": "2026-07-03", "amount": 550000},
    {"date": "2026-07-04", "amount": 700000},
    {"date": "2026-07-05", "amount": 800000}
]
_expenses_db: List[Dict[str, Any]] = [
    {"date": "2026-07-01", "amount": 100000, "category": "원두매입"},
    {"date": "2026-07-03", "amount": 50000, "category": "소모품비"}
]

class OperationService:
    """스케줄 관리 및 근무 시간, 급여 연산 비즈니스 로직을 담당하는 서비스 클래스"""

    @staticmethod
    def get_employee(employee_id: int) -> Optional[Employee]:
        """직원 정보 조회"""
        return _employees_db.get(employee_id)

    @staticmethod
    def create_schedule(employee_id: int, start_time: datetime, end_time: datetime) -> Schedule:
        """새 근무 스케줄 등록"""
        global _schedule_id_counter
        if employee_id not in _employees_db:
            raise ValueError(f"존재하지 않는 직원 ID입니다: {employee_id}")
        
        if start_time >= end_time:
            raise ValueError("시작 시간은 종료 시간보다 빨라야 합니다.")
            
        date_str = start_time.strftime("%Y-%m-%d")
        new_schedule = Schedule(
            id=_schedule_id_counter,
            employee_id=employee_id,
            start_time=start_time,
            end_time=end_time,
            date=date_str
        )
        _schedules_db[_schedule_id_counter] = new_schedule
        _schedule_id_counter += 1
        return new_schedule

    @staticmethod
    def get_schedule(schedule_id: int) -> Optional[Schedule]:
        """스케줄 단건 조회"""
        return _schedules_db.get(schedule_id)

    @staticmethod
    def get_all_schedules() -> List[Schedule]:
        """전체 스케줄 조회"""
        return list(_schedules_db.values())

    @staticmethod
    def calculate_work_hours(start_time: datetime, end_time: datetime) -> float:
        """출퇴근 시간을 받아 실 근무시간 계산 (휴게시간 자동 공제)"""
        duration = end_time - start_time
        total_hours = duration.total_seconds() / 3600.0
        
        # 4시간 근무 시 30분, 8시간 근무 시 1시간 의무 휴게 공제
        if total_hours >= 8.0:
            total_hours -= 1.0
        elif total_hours >= 4.0:
            total_hours -= 0.5
            
        return max(0.0, total_hours)

    @classmethod
    def calculate_payroll(cls, employee_id: int, year_month: str) -> dict:
        """특정 직원의 지정 연월에 대한 예상 급여(주휴수당 포함)를 계산합니다."""
        employee = _employees_db.get(employee_id)
        if not employee:
            raise ValueError(f"존재하지 않는 직원 ID입니다: {employee_id}")
            
        total_hours = 0.0
        # 해당 연월의 스케줄 기준 근무시간 산산
        for schedule in _schedules_db.values():
            if schedule.employee_id == employee_id and schedule.date.startswith(year_month):
                hours = cls.calculate_work_hours(schedule.start_time, schedule.end_time)
                total_hours += hours
                
        # 주휴수당 산정 (월 총 시간이 60시간 이상이면 평균 주 15시간 이상으로 보아 1일 평균 소정근로시간 추가 지급)
        weekly_holiday_allowance = 0
        if total_hours >= 60.0:
            weekly_avg_hours = total_hours / 4.0
            daily_avg_hours = min(8.0, weekly_avg_hours / 5.0)
            weekly_holiday_allowance = int(daily_avg_hours * employee.hourly_rate * 4) # 4주치 주휴수당

        base_salary = int(total_hours * employee.hourly_rate)
        total_salary = base_salary + weekly_holiday_allowance

        return {
            "employee_id": employee_id,
            "employee_name": employee.name,
            "year_month": year_month,
            "total_work_hours": total_hours,
            "base_salary": base_salary,
            "weekly_holiday_allowance": weekly_holiday_allowance,
            "total_salary": total_salary,
            "calculated_at": datetime.now()
        }

    @classmethod
    def calculate_settlement(cls, year_month: str) -> dict:
        """매장의 월별 예상 총매출, 예상 총지출, 직원 인건비를 취합해 예상 정산 손익을 도출합니다."""
        # 1. 가상 매출액 합산
        total_sales = sum(record["amount"] for record in _sales_db if record["date"].startswith(year_month))
        # 2. 가상 지출액 합산
        total_expense = sum(record["amount"] for record in _expenses_db if record["date"].startswith(year_month))
        
        # 3. 전체 직원의 해당 월 예상 급여 합산
        total_payroll = 0
        for emp_id in _employees_db.keys():
            try:
                payroll = cls.calculate_payroll(emp_id, year_month)
                total_payroll += payroll["total_salary"]
            except ValueError:
                continue
                
        # 4. 예상 순이익 = 예상 매출 - (예상 지출 + 예상 인건비)
        net_profit = total_sales - (total_expense + total_payroll)
        
        return {
            "year_month": year_month,
            "total_sales": total_sales,
            "total_expense": total_expense,
            "total_payroll": total_payroll,
            "net_profit": net_profit,
            "calculated_at": datetime.now()
        }

    # ==========================================
    # 3단계: RAG 및 리포트 변환 비즈니스 로직 추가
    # ==========================================

    @staticmethod
    def build_tax_rag_documents(tax_result: dict, source_id: int = 1) -> dict:
        """세무 계산 결과를 AI 비서와 챗봇이 읽기 좋은 RAG 공통 포맷으로 포장합니다."""
        period = tax_result.get("period", "2026-07")
        estimated_tax = tax_result.get("estimated_tax", 0)
        summary = tax_result.get("summary", "")
        disclaimer = tax_result.get("disclaimer", "")

        content = (
            f"대상 기간 {period}의 세무 계산 결과 분석 정보입니다. "
            f"{summary} "
            f"세금 부과 표준액(과세표준)은 {tax_result.get('taxable_amount', 0):,}원이며, 적용 세율은 {int(tax_result.get('tax_rate', 0.1)*100)}%입니다. "
            f"{disclaimer}"
        )

        return {
            "title": f"{period} 예상 세금 계산 분석 리포트",
            "content": content,
            "summary": f"{period} 예상 세금 참고 시뮬레이션 계산 결과",
            "category": "tax",
            "tags": ["tax", "estimate", period],
            "source_type": "tax",
            "source_id": source_id
        }

    @staticmethod
    def build_forecast_rag_documents(forecast_result: dict, source_id: int = 1) -> dict:
        """판매예측 결과를 AI 비서와 챗봇이 읽기 좋은 RAG 공통 포맷으로 포장합니다."""
        target_date = forecast_result.get("target_date", "")
        predicted_sales = forecast_result.get("predicted_sales", 0)
        predicted_quantity = forecast_result.get("predicted_quantity", 0)
        evidence_summary = forecast_result.get("evidence_summary", "")

        content = (
            f"예측일자 {target_date}에 대한 매장 판매 수요 예측 시뮬레이션 데이터입니다. "
            f"예측 매출액은 {predicted_sales:,}원이며, 예상 판매량은 {predicted_quantity:,}개로 전망됩니다. "
            f"분석 판단 근거: {evidence_summary} "
            f"본 데이터는 최근 판매 추이를 토대로 한 단순 평균 기반의 참고용 예측 수치입니다."
        )

        return {
            "title": f"{target_date} 매장 판매 수요 예측 리포트",
            "content": content,
            "summary": f"{target_date} 단순 평균 기반 판매 예측 결과",
            "category": "forecast",
            "tags": ["forecast", "sales", target_date],
            "source_type": "forecast",
            "source_id": source_id
        }

    @staticmethod
    def build_operation_rag_documents(schedules: List[Any]) -> List[dict]:
        """스케줄 일정 데이터를 RAG 문서 리스트 형태로 변환합니다."""
        rag_docs = []
        for idx, schedule in enumerate(schedules, 1):
            emp_id = getattr(schedule, "employee_id", 0)
            emp_name = f"직원(ID:{emp_id})"
            # 가상 DB에서 직원 이름 매핑 시도
            if emp_id in _employees_db:
                emp_name = _employees_db[emp_id].name

            start_str = schedule.start_time.strftime("%H:%M") if hasattr(schedule.start_time, "strftime") else str(schedule.start_time)
            end_str = schedule.end_time.strftime("%H:%M") if hasattr(schedule.end_time, "strftime") else str(schedule.end_time)

            content = (
                f"{schedule.date} 일자에 {emp_name} 근무자의 근무 일정이 계획되어 있습니다. "
                f"근무 시간은 {start_str}부터 {end_str}까지입니다."
            )
            
            rag_docs.append({
                "title": f"{schedule.date} {emp_name} 근무 스케줄 정보",
                "content": content,
                "summary": f"{schedule.date} 근무 일정 요약",
                "category": "schedule",
                "tags": ["schedule", "work", schedule.date],
                "source_type": "schedule",
                "source_id": schedule.id if hasattr(schedule, "id") else idx
            })
        return rag_docs

    @staticmethod
    def get_daily_operation_summary() -> str:
        """가상의 일간 운영 동향 요약 자연어 리포트를 생성합니다."""
        return "오늘 매장 운영 요약: 총 3건의 스케줄이 계획되어 있으며, 바리스타 2명과 매니저 1명이 교대 근무합니다. 예상 일매출은 단순 평균 500,000원 선으로 전망됩니다."

    @staticmethod
    def get_weekly_operation_summary() -> str:
        """가상의 주간 운영 동향 요약 자연어 리포트를 생성합니다."""
        return "이번 주 매출은 지난주보다 8% 감소했으나, 파트타이머 근무 가중 적용으로 인해 인건비 지출은 지난주보다 3% 증가했습니다. 예상 세금 관리는 전주 대비 변동이 없습니다."

    @staticmethod
    def get_monthly_operation_summary() -> str:
        """가상의 월간 운영 동향 요약 자연어 리포트를 생성합니다."""
        return "이번 달(2026-07) 매장 운영 요약: 가상 매출 총합 3,150,000원과 지출 총합 150,000원, 인건비 합산액을 공제한 예상 순이익은 약 2,000,000원으로 시뮬레이션되었습니다. (참고용 계산)"

    @classmethod
    def build_report_source_documents(cls, period: str) -> dict:
        """지정 기간에 대한 리포트용 자연어 취합 데이터 소스를 가공 및 바인딩합니다."""
        period_lower = period.lower()

        # 기간 구분에 따른 자연어 분기
        if period_lower == "weekly":
            sales_summary = "이번 주 매출은 지난주보다 8% 감소했습니다."
            payroll_summary = "인건비는 지난주보다 3% 증가했습니다."
        elif period_lower == "daily":
            sales_summary = "오늘 매출은 어제와 유사한 보통 수준으로 유지되었습니다."
            payroll_summary = "오늘 발생한 예상 근무 인건비는 약 95,000원 선입니다."
        else:
            sales_summary = "이번 달 매출은 목표치 대비 95% 달성률을 기록했습니다."
            payroll_summary = "이번 달 인건비는 전체 누적 매출 대비 28% 수준으로 관리되고 있습니다."

        # 기존 계산 모듈들을 재사용해 리포트 요약 글 작성
        tax_summary = "예상 세금은 180,000원입니다. (이 계산은 참고용 예상값이며 실제 신고 금액과 다를 수 있습니다. 정확한 신고는 세무 전문가 확인이 필요합니다.)"
        forecast_summary = "다음 주 라떼 계열 판매량 증가가 예상됩니다. (최근 7일 판매 통계 기준)"

        return {
            "period": period,
            "sales_summary": sales_summary,
            "payroll_summary": payroll_summary,
            "tax_summary": tax_summary,
            "forecast_summary": forecast_summary
        }


