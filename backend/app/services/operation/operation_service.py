"""운영(스케줄·급여) 로직 (백엔드 C)"""
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional
from sqlalchemy.orm import Session
from sqlalchemy import func, extract
from app.models.operation import Employee, Schedule, Expense, EstimatedPayroll, EstimatedSettlement
from app.models.inventory import Sale
from app.schemas.operation import ScheduleUpdate

# 반올림 및 연산 정책 상수 명시
HOUR_DECIMALS: int = 2
RATE_DECIMALS: int = 2

class OperationService:
    """스케줄 관리 및 근무 시간, 급여 연산 비즈니스 로직을 담당하는 서비스 클래스"""

    # 반올림 정책 클래스 내 상수 지정
    HOUR_DECIMALS = HOUR_DECIMALS
    RATE_DECIMALS = RATE_DECIMALS

    @staticmethod
    def get_employee(db: Session, employee_id: int) -> Optional[Employee]:
        """데이터베이스에서 직원 정보 조회"""
        return db.query(Employee).filter(Employee.id == employee_id).first()

    @staticmethod
    def create_schedule(db: Session, employee_id: int, start_time: datetime, end_time: datetime) -> Schedule:
        """새 근무 스케줄을 데이터베이스에 등록합니다."""
        # 1. 존재하는 직원인지 유효성 검사
        employee = db.query(Employee).filter(Employee.id == employee_id).first()
        if not employee:
            raise ValueError(f"존재하지 않는 직원 ID입니다: {employee_id}")
        
        # 2. 직원의 시급 유효성 검사 (0 이하인 경우 에러 처리)
        if employee.hourly_rate <= 0:
            raise ValueError(f"해당 직원의 시급 설정이 올바르지 않습니다 (시급: {employee.hourly_rate}원). 시급은 0보다 커야 합니다.")
        
        if start_time >= end_time:
            raise ValueError("근무 시작 시간은 종료 시간보다 빨라야 합니다.")
            
        date_str = start_time.strftime("%Y-%m-%d")
        new_schedule = Schedule(
            employee_id=employee_id,
            start_time=start_time,
            end_time=end_time,
            date=date_str
        )
        db.add(new_schedule)
        db.commit()
        db.refresh(new_schedule)
        return new_schedule

    @staticmethod
    def get_schedule_by_id(db: Session, schedule_id: int) -> Optional[Schedule]:
        """스케줄 단건 상세 조회"""
        return db.query(Schedule).filter(Schedule.id == schedule_id).first()

    @staticmethod
    def get_schedules(db: Session) -> List[Schedule]:
        """등록된 모든 스케줄 일정 목록 조회"""
        return db.query(Schedule).all()

    @staticmethod
    def update_schedule(db: Session, schedule_id: int, payload: ScheduleUpdate) -> Optional[Schedule]:
        """스케줄 일정을 찾아 요청된 항목만 부분 수정(PATCH)합니다."""
        db_schedule = db.query(Schedule).filter(Schedule.id == schedule_id).first()
        if not db_schedule:
            return None

        # 전송된 데이터가 있는 경우에만 덮어쓰기 (PATCH 기본 동작)
        if payload.start_time is not None:
            db_schedule.start_time = payload.start_time
            db_schedule.date = payload.start_time.strftime("%Y-%m-%d")  # 날짜 동기화
        if payload.end_time is not None:
            db_schedule.end_time = payload.end_time
        if payload.actual_start_time is not None:
            db_schedule.actual_start_time = payload.actual_start_time
        if payload.actual_end_time is not None:
            db_schedule.actual_end_time = payload.actual_end_time

        # 입력 시간 전후 관계 논리 검증
        if db_schedule.start_time >= db_schedule.end_time:
            raise ValueError("근무 시작 시간은 종료 시간보다 빨라야 합니다.")
        if db_schedule.actual_start_time and db_schedule.actual_end_time:
            if db_schedule.actual_start_time >= db_schedule.actual_end_time:
                raise ValueError("실제 출근 시각은 퇴근 시각보다 빨라야 합니다.")

        db.commit()
        db.refresh(db_schedule)
        return db_schedule

    @staticmethod
    def delete_schedule(db: Session, schedule_id: int) -> bool:
        """데이터베이스에서 특정 스케줄 영구 삭제 (Hard Delete)"""
        db_schedule = db.query(Schedule).filter(Schedule.id == schedule_id).first()
        if not db_schedule:
            return False
        
        db.delete(db_schedule)
        db.commit()
        return True

    @staticmethod
    def calculate_work_hours(start_time: datetime, end_time: datetime, break_minutes: float = 0.0) -> float:
        """
        [한글 주석] 근무 시작 시간, 종료 시간, 휴게시간(분)을 입력받아 실근무시간(시간 단위)을 계산합니다.
        - [옵션 A] 종료 시간이 시작 시간보다 빠르거나 같으면 자정 넘김(익일 퇴근)으로 판단하여 24시간 보정합니다.
        - 휴게시간이 전체 근무시간보다 길거나 같으면 ValueError를 발생시킵니다.
        """
        # [한글 주석] Naive 및 Aware datetime 간 연산 오류를 방지하기 위해 타임존 정보를 제거합니다.
        s_naive = start_time.replace(tzinfo=None) if start_time.tzinfo is not None else start_time
        e_naive = end_time.replace(tzinfo=None) if end_time.tzinfo is not None else end_time

        # 1. 자정 넘김(익일 퇴근) 보정: 종료 시각이 시작 시각 이하인 경우 24시간(1일) 보정
        if e_naive <= s_naive:
            e_naive += timedelta(days=1)

        # 2. 전체 근무시간 계산 (시간 단위)
        total_seconds = (e_naive - s_naive).total_seconds()

        # 시작 시각과 완전 동일(0초) 또는 24시간 초과인 경우 유효성 실패
        if total_seconds <= 0 or total_seconds >= 86400:
            raise ValueError("근무 시작 시각과 종료 시각이 올바르지 않습니다 (24시간 이상 연속 근무 불가).")

        total_hours = total_seconds / 3600.0

        # 3. 휴게시간 계산 (분 -> 시간 환산)
        break_hours = break_minutes / 60.0

        # 4. 휴게시간이 전체 근무시간 이상인지 검증
        if break_hours >= total_hours:
            raise ValueError("휴게시간은 전체 근무시간보다 적어야 합니다.")

        # 5. 실근무시간 반환 (소수점 HOUR_DECIMALS자리로 반올림)
        return round(total_hours - break_hours, HOUR_DECIMALS)

    @classmethod
    def calculate_payroll(
        cls,
        start_time: datetime,
        end_time: datetime,
        break_minutes: float,
        hourly_rate: int,
        weekly_work_hours: Optional[float] = None,
        include_weekly_holiday: bool = False,
        deduct_tax: bool = False
    ) -> dict:
        """
        [한글 주석] 근무 시작/종료 시간, 휴게시간, 시급을 입력받아 실근무시간, 주휴수당, 세금 공제 후 실수령액을 연산합니다.
        - [옵션 A] 자정 넘김(익일 퇴근) 자동 지원
        - [옵션 B] 주 15시간 이상 시 주휴수당 산출 및 3.3% 사업소득세 원천징수 공제 연산 지원
        """
        # 1. 시급 유효성 검증
        if hourly_rate <= 0:
            raise ValueError("시급은 0보다 커야 합니다.")

        # 2. 실근무시간 계산 (자정 넘김 보정 및 유효성 검증 포함)
        actual_work_hours = cls.calculate_work_hours(start_time, end_time, break_minutes)

        # 3. 전체 근무시간 및 휴게시간 계산 (소수점 표기용)
        s_naive = start_time.replace(tzinfo=None) if start_time.tzinfo is not None else start_time
        e_naive = end_time.replace(tzinfo=None) if end_time.tzinfo is not None else end_time
        if e_naive <= s_naive:
            e_naive += timedelta(days=1)

        total_hours = round((e_naive - s_naive).total_seconds() / 3600.0, HOUR_DECIMALS)
        break_hours = round(break_minutes / 60.0, HOUR_DECIMALS)

        # 4. 기본 급여 계산 (실근무시간 × 시급 round 후 int 정수 반환)
        base_payroll = int(round(actual_work_hours * hourly_rate))

        # 5. [옵션 B] 주휴수당 연산 ((주간 실근무시간 / 40시간) × 8시간 × 시급, 최대 8시간 시급)
        effective_weekly_hours = weekly_work_hours if (weekly_work_hours is not None and weekly_work_hours >= 15.0) else actual_work_hours
        is_weekly_holiday_target = include_weekly_holiday or (weekly_work_hours is not None and weekly_work_hours >= 15.0)
        
        weekly_holiday_allowance = 0
        if is_weekly_holiday_target and effective_weekly_hours >= 15.0:
            weekly_holiday_allowance = int(round(min(1.0, effective_weekly_hours / 40.0) * 8 * hourly_rate))

        # 6. 총 급여액 (기본급 + 주휴수당)
        gross_payroll = base_payroll + weekly_holiday_allowance

        # 7. [옵션 B] 3.3% 사업소득세 원천징수 세금 계산
        withholding_tax = 0
        if deduct_tax:
            withholding_tax = int(round(gross_payroll * 0.033))

        # 8. 최종 세후 실수령액 (총 급여 - 원천징수 세금)
        net_payroll = gross_payroll - withholding_tax

        return {
            "total_hours": total_hours,
            "break_hours": break_hours,
            "actual_work_hours": actual_work_hours,
            "hourly_rate": hourly_rate,
            "base_payroll": base_payroll,
            "estimated_payroll": base_payroll,
            "weekly_holiday_allowance": weekly_holiday_allowance,
            "gross_payroll": gross_payroll,
            "withholding_tax": withholding_tax,
            "net_payroll": net_payroll,
            "disclaimer": "본 급여 계산 결과는 확정 지급액이 아니며 참고용 예상 급여입니다."
        }

    @classmethod
    def calculate_payroll_from_db(cls, db: Session, employee_id: int, period_start: str, period_end: str, deduct_break_time: bool = False) -> dict:
        """[DB 연동] 특정 직원의 지정 기간 내 스케줄 조회 기반 예상 급여 계산 및 저장"""
        employee = db.query(Employee).filter(Employee.id == employee_id).first()
        if not employee:
            raise ValueError(f"존재하지 않는 직원 ID입니다: {employee_id}")
            
        if employee.hourly_rate <= 0:
            raise ValueError(f"해당 직원의 시급 설정이 올바르지 않습니다 (시급: {employee.hourly_rate}원). 시급은 0보다 커야 합니다.")

        schedules = db.query(Schedule).filter(
            Schedule.employee_id == employee_id,
            Schedule.date >= period_start,
            Schedule.date <= period_end
        ).all()

        if not schedules:
            raise ValueError(f"해당 기간({period_start} ~ {period_end})에 등록된 스케줄이 없습니다.")

        total_hours = 0.0
        based_on_actual = False
        for schedule in schedules:
            st = schedule.actual_start_time if (schedule.actual_start_time and schedule.actual_end_time) else schedule.start_time
            et = schedule.actual_end_time if (schedule.actual_start_time and schedule.actual_end_time) else schedule.end_time
            if schedule.actual_start_time and schedule.actual_end_time:
                based_on_actual = True
            
            dur = (et - st).total_seconds() / 3600.0
            if deduct_break_time:
                if dur >= 8.0:
                    dur -= 1.0
                elif dur >= 4.0:
                    dur -= 0.5
            total_hours += max(0.0, dur)
                
        base_salary = int(total_hours * employee.hourly_rate)
        weekly_holiday_allowance = 0
        estimated_salary = base_salary + weekly_holiday_allowance

        est_payroll = db.query(EstimatedPayroll).filter(
            EstimatedPayroll.employee_id == employee_id,
            EstimatedPayroll.period_start == period_start,
            EstimatedPayroll.period_end == period_end
        ).first()

        if est_payroll:
            est_payroll.total_work_hours = total_hours
            est_payroll.estimated_salary = estimated_salary
            est_payroll.calculated_at = datetime.now()
        else:
            est_payroll = EstimatedPayroll(
                employee_id=employee_id,
                period_start=period_start,
                period_end=period_end,
                total_work_hours=total_hours,
                estimated_salary=estimated_salary,
                calculated_at=datetime.now()
            )
            db.add(est_payroll)

        db.commit()
        db.refresh(est_payroll)

        return {
            "id": est_payroll.id,
            "employee_id": employee_id,
            "employee_name": employee.name,
            "role": employee.role,
            "hourly_rate": employee.hourly_rate,
            "period_start": period_start,
            "period_end": period_end,
            "total_work_hours": total_hours,
            "base_salary": base_salary,
            "weekly_holiday_allowance": weekly_holiday_allowance,
            "estimated_salary": estimated_salary,
            "based_on_actual": based_on_actual,
            "calculated_at": est_payroll.calculated_at
        }

    @classmethod
    def list_employees_payroll(cls, db: Session, year_month: str) -> List[dict]:
        """[하위 호환 헬퍼] 등록된 모든 직원의 해당 월 예상 급여 목록을 반환합니다."""
        results = []
        p_start = f"{year_month}-01"
        p_end = f"{year_month}-31"
        for emp in db.query(Employee).all():
            try:
                results.append(cls.calculate_payroll_from_db(db, emp.id, p_start, p_end))
            except ValueError:
                continue
        return results

    @classmethod
    def calculate_settlement(cls, revenue: int, cost: int, labor_cost: int, other_expense: int = 0) -> dict:
        """
        [한글 주석] 매출 - 원가/비용 - 인건비 - 기타비용으로 예상 정산 이익 및 이익률을 계산합니다.
        - 매출/비용/인건비/기타비용은 음수가 될 수 없습니다.
        - 매출이 0인 경우 이익률은 null(None) 처리합니다.
        """
        # 1. 음수 입력값 검증
        if revenue < 0 or cost < 0 or labor_cost < 0 or other_expense < 0:
            raise ValueError("매출액, 원가/비용, 인건비, 기타비용은 음수가 될 수 없습니다.")

        # 2. 총 비용 산출 (원가 + 인건비 + 기타비용)
        total_cost = cost + labor_cost + other_expense

        # 3. 예상 정산 이익 산출 (매출 - 총 비용)
        estimated_profit = revenue - total_cost

        # 4. 이익률 산출 (매출이 0이면 null 처리, 소수점 RATE_DECIMALS자리 반올림)
        profit_rate: Optional[float] = None
        if revenue > 0:
            profit_rate = round((estimated_profit / revenue) * 100, RATE_DECIMALS)

        return {
            "revenue": revenue,
            "cost": cost,
            "labor_cost": labor_cost,
            "other_expense": other_expense,
            "total_cost": total_cost,
            "estimated_profit": estimated_profit,
            "profit_rate": profit_rate,
            "profit_margin": profit_rate,
            "disclaimer": "본 정산 결과는 확정 정산이 아닌 단순 참고용 예상 정산 결과입니다."
        }

    # ==========================================
    # 집계 헬퍼 (세무·예측 공용) + 지출(Expense) 관리
    # ==========================================

    @staticmethod
    def get_daily_sales_series(
        db: Session,
        year_month: Optional[str] = None,
        store_id: Optional[str] = None,
        days: Optional[int] = None,
    ) -> List[Dict[str, Any]]:
        """Sale 테이블을 일자별로 집계해 [{date, revenue, quantity}] 시계열을 반환합니다.
        - year_month: 지정 시 해당 월만
        - store_id: 지정 시 해당 매장만
        - days: 지정 시 최근 N일치만 (오름차순 기준 뒤에서 N개)
        """
        day = func.date(Sale.sold_at)
        query = db.query(
            day.label("d"),
            func.sum(Sale.total_price).label("revenue"),
            func.sum(Sale.quantity).label("quantity"),
        )
        if store_id:
            query = query.filter(Sale.store_id == store_id)
        if year_month:
            year, month = map(int, year_month.split("-"))
            query = query.filter(
                extract("year", Sale.sold_at) == year,
                extract("month", Sale.sold_at) == month,
            )
        rows = query.group_by(day).order_by(day).all()
        series = [
            {"date": str(r.d), "revenue": int(r.revenue or 0), "quantity": int(r.quantity or 0)}
            for r in rows
        ]
        if days is not None and days > 0:
            series = series[-days:]
        return series

    @staticmethod
    def get_period_totals(db: Session, year_month: str, store_id: Optional[str] = None) -> Dict[str, int]:
        """지정 월의 총매출(Sale)과 총지출(Expense)을 집계해 반환합니다. (세무·정산 공용)"""
        try:
            year, month = map(int, year_month.split("-"))
        except ValueError:
            raise ValueError("연월 포맷은 YYYY-MM 형식이어야 합니다.")

        sales_q = db.query(func.sum(Sale.total_price)).filter(
            extract("year", Sale.sold_at) == year,
            extract("month", Sale.sold_at) == month,
        )
        expense_q = db.query(func.sum(Expense.amount)).filter(
            extract("year", Expense.expense_date) == year,
            extract("month", Expense.expense_date) == month,
        )
        if store_id:
            sales_q = sales_q.filter(Sale.store_id == store_id)
            expense_q = expense_q.filter(Expense.store_id == store_id)

        return {
            "total_sales": int(sales_q.scalar() or 0),
            "total_expense": int(expense_q.scalar() or 0),
        }

    @staticmethod
    def create_expense(
        db: Session,
        store_id: str,
        amount: int,
        category: str,
        expense_date,
        description: Optional[str] = None,
    ) -> Expense:
        """새 지출(비용) 내역을 데이터베이스에 등록합니다."""
        if amount < 0:
            raise ValueError("지출 금액은 0 이상이어야 합니다.")
        expense = Expense(
            store_id=store_id,
            amount=amount,
            category=category,
            description=description,
            expense_date=expense_date,
        )
        db.add(expense)
        db.commit()
        db.refresh(expense)
        return expense

    @staticmethod
    def get_expenses(
        db: Session, year_month: Optional[str] = None, store_id: Optional[str] = None
    ) -> List[Expense]:
        """등록된 지출 내역을 조회합니다. (연월·매장 필터 선택)"""
        query = db.query(Expense)
        if store_id:
            query = query.filter(Expense.store_id == store_id)
        if year_month:
            year, month = map(int, year_month.split("-"))
            query = query.filter(
                extract("year", Expense.expense_date) == year,
                extract("month", Expense.expense_date) == month,
            )
        return query.order_by(Expense.expense_date.desc()).all()

    # ==========================================
    # 3단계: RAG 및 리포트 변환 비즈니스 로직 추가
    # ==========================================

    @staticmethod
    def build_tax_rag_documents(tax_result: dict, source_id: int = 1) -> dict:
        """세무 계산 결과를 AI 비서와 챗봇이 읽기 좋은 RAG 공통 포맷으로 포장합니다."""
        period = tax_result.get("period", "2026-07")
        summary = tax_result.get("summary", "")
        disclaimer = tax_result.get("disclaimer", "")

        content = (
            f"대상 기간 {period}의 세무 계산 결과 분석 정보입니다. "
            f"{summary} "
            f"세부 내역 — 부가가치세 {tax_result.get('vat', 0):,}원, "
            f"종합소득세 {tax_result.get('income_tax', 0):,}원(과세표준 {tax_result.get('taxable_base', 0):,}원), "
            f"원천징수세 {tax_result.get('withholding_tax', 0):,}원, 합계 {tax_result.get('total_tax', 0):,}원. "
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
    def build_operation_rag_documents(schedules: List[Any], db: Optional[Session] = None) -> List[dict]:
        """스케줄 일정 데이터를 RAG 문서 리스트 형태로 변환합니다."""
        # 실제 데이터베이스 연결을 직접 열어 직원 정보를 안전하게 조회합니다.
        from app.core.database import SessionLocal

        rag_docs = []
        with SessionLocal() as db:
            for idx, schedule in enumerate(schedules, 1):
                emp_id = getattr(schedule, "employee_id", 0)
                emp_name = f"직원(ID:{emp_id})"

                # 데이터베이스에서 실제 해당 직원의 정보를 쿼리합니다.
                employee = db.query(Employee).filter(Employee.id == emp_id).first()
                if employee:
                    emp_name = employee.name

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

    @classmethod
    def recommend_schedule(cls, db: Session, period_start: str, period_end: str, store_id: str) -> dict:
        """실제 과거 매출 데이터를 시간대별로 분석하여 최적의 알바 예상 근무 스케줄을 추천합니다."""
        from datetime import time, timezone, timedelta
        # [한글 주석] 외부 라이브러리(pytz) 없이 파이썬 내장 기능을 사용하여 KST(한국 표준시)를 정의합니다.
        kst = timezone(timedelta(hours=9))

        try:
            start_date = datetime.strptime(period_start, "%Y-%m-%d").date()
            end_date = datetime.strptime(period_end, "%Y-%m-%d").date()
        except ValueError:
            raise ValueError("기간 포맷은 YYYY-MM-DD 형식이어야 합니다.")

        # [한글 주석] Timezone 인식형 sold_at 비교를 위해 KST 기준으로 타임존을 맞춥니다.
        start_dt = datetime.combine(start_date, time.min).replace(tzinfo=kst)
        end_dt = datetime.combine(end_date, time.max).replace(tzinfo=kst)
        days_count = max((end_date - start_date).days + 1, 1)

        # DB에서 해당 매장의 기간 내 매출 데이터 조회 (N+1 쿼리 방지 로딩)
        from sqlalchemy.orm import joinedload
        from app.models.inventory import Menu, Recipe
        
        sales = db.query(Sale).filter(
            Sale.store_id == store_id,
            Sale.sold_at >= start_dt,
            Sale.sold_at <= end_dt
        ).options(
            joinedload(Sale.menu).selectinload(Menu.recipes)
        ).all()

        hourly_recommendations = []
        total_recommended_hours = 0.0

        # 영업시간은 일반적인 카페 기준 08시 ~ 22시로 규정 (나머지 시간은 0명 추천)
        business_hours = range(8, 23)

        # 3. 데이터가 존재할 경우 시간대별 평균 매출 및 이익 분석 (최소 5건 이상 실데이터 확보 시)
        if len(sales) >= 5:
            hourly_sales = {h: [] for h in range(24)}
            hourly_profits = {h: [] for h in range(24)}
            
            for s in sales:
                # [한글 주석] 매출 시간대를 KST 타임존 기준으로 보정한 후 시간(hour)을 추출합니다.
                s_kst = s.sold_at.astimezone(kst)
                h = s_kst.hour
                hourly_sales[h].append(s.total_price)
                
                # 메뉴별 원자재 원가 합산 계산 (메뉴 -> 레시피 -> 재료 단가)
                menu_cost = 0
                if s.menu and s.menu.recipes:
                    for recipe in s.menu.recipes:
                        if recipe.ingredient:
                            menu_cost += recipe.quantity * recipe.ingredient.current_price
                
                # 한 건당 마진 이익 = 총 판매가 - (개당 원가 * 판매 수량)
                profit = s.total_price - int(menu_cost * s.quantity)
                hourly_profits[h].append(profit)

            for h in range(24):
                if h not in business_hours:
                    hourly_recommendations.append({
                        "hour": h,
                        "predicted_sales": 0,
                        "predicted_profit": 0,
                        "recommended_employee_count": 0,
                        "busy_level": "LOW"
                      })
                    continue

                prices = hourly_sales[h]
                # [한글 주석] 해당 시간대의 일평균 매출액(총 매출 / 전체 일수)을 구합니다.
                avg_sales = int(sum(prices) / days_count) if prices else 0
                
                profits = hourly_profits[h]
                avg_profit = int(sum(profits) / days_count) if profits else 0
                
                # [한글 주석] 매출 대비 인원 추천 규칙 (5만원 이하: 1명, 12만원 이하: 2명, 초과: 3명)
                if avg_sales >= 120000:
                    emp_count = 3
                    busy = "PEAK"
                elif avg_sales >= 50000:
                    emp_count = 2
                    busy = "HIGH"
                else:
                    emp_count = 1
                    busy = "LOW"

                hourly_recommendations.append({
                    "hour": h,
                    "predicted_sales": avg_sales,
                    "predicted_profit": avg_profit,
                    "recommended_employee_count": emp_count,
                    "busy_level": busy
                })
                total_recommended_hours += emp_count

        else:
            # 4. [Fallback] 과거 매출 데이터가 없거나 부족할 때 요일별 카페 표준 룰베이스 적용
            # 주말(토, 일)과 주중(월~금) 피크 패턴 분기 (시작일 요일 기준)
            is_weekend = start_date.weekday() in (5, 6)

            for h in range(24):
                if h not in business_hours:
                    hourly_recommendations.append({
                        "hour": h,
                        "predicted_sales": 0,
                        "predicted_profit": 0,
                        "recommended_employee_count": 0,
                        "busy_level": "LOW"
                    })
                    continue

                avg_sales = 0
                emp_count = 1
                busy = "NORMAL"

                if is_weekend:
                    # 주말 패턴: 오후 시간대(13시~17시) 집중 피크
                    if 13 <= h <= 16:
                        avg_sales = 160000
                        emp_count = 3
                        busy = "PEAK"
                    elif 11 <= h <= 12 or 17 <= h <= 18:
                        avg_sales = 80000
                        emp_count = 2
                        busy = "HIGH"
                    else:
                        avg_sales = 25000
                        emp_count = 1
                        busy = "LOW"
                else:
                    # 주중 패턴: 출근 피크(08시~09시) 및 점심 피크(12시~14시)
                    if 12 <= h <= 13:
                        avg_sales = 180000
                        emp_count = 3
                        busy = "PEAK"
                    elif h == 8 or h == 11 or h == 14:
                        avg_sales = 90000
                        emp_count = 2
                        busy = "HIGH"
                    else:
                        avg_sales = 20000
                        emp_count = 1
                        busy = "LOW"

                # 가상의 카페 평균 마진율 70% 대입 계산
                avg_profit = int(avg_sales * 0.7)

                hourly_recommendations.append({
                    "hour": h,
                    "predicted_sales": avg_sales,
                    "predicted_profit": avg_profit,
                    "recommended_employee_count": emp_count,
                    "busy_level": busy
                })
                total_recommended_hours += emp_count

        # 5. 예상 인건비 연산 (소속 직원들의 평균 시급 계산, 없으면 10,000원 기준)
        from app.models.operation import Employee
        employees = db.query(Employee).all()
        hourly_rates = [emp.hourly_rate for emp in employees if emp.hourly_rate > 0]
        avg_hourly_rate = int(sum(hourly_rates) / len(hourly_rates)) if hourly_rates else 10000
        estimated_payroll_cost = int(total_recommended_hours * avg_hourly_rate)

        # 6. 피크타임을 파악하여 자연어 요약 조언 메시지 생성
        total_predicted_sales = sum(item["predicted_sales"] for item in hourly_recommendations)
        total_predicted_profit = sum(item["predicted_profit"] for item in hourly_recommendations)
        
        peak_hours = [item["hour"] for item in hourly_recommendations if item["busy_level"] == "PEAK"]
        if peak_hours:
            peak_str = ", ".join([f"{ph}시" for ph in peak_hours])
            summary = (
                f"분석 결과, {period_start} ~ {period_end} 기간에는 {peak_str}에 강한 매출 피크가 예상되어 최대로 알바생(3명)을 집중 배치할 것을 권장합니다. "
                f"시간대별 평균 예상 매출 총합은 {total_predicted_sales:,}원, 예상 마진 이익은 {total_predicted_profit:,}원입니다. "
                f"피크 외 시간대에는 1명으로 인력을 통제하여 예상 인건비 지출({estimated_payroll_cost:,}원) 대비 수익 효율을 극대화하세요."
            )
        else:
            summary = (
                f"{period_start} ~ {period_end} 기간에는 뚜렷한 피크타임 없이 전반적으로 평이하거나 한산할 것으로 분석됩니다. "
                f"시간대별 평균 예상 매출 총합은 {total_predicted_sales:,}원, 예상 마진 이익은 {total_predicted_profit:,}원입니다. "
                f"영업 시간 내내 최소 인원(1명)으로 유연하게 조율하여 고정 인건비 지출({estimated_payroll_cost:,}원)을 방지하시는 것을 추천합니다."
            )

        return {
            "target_date": period_start,
            "hourly_recommendations": hourly_recommendations,
            "total_recommended_hours": total_recommended_hours,
            "estimated_payroll_cost": estimated_payroll_cost,
            "summary": summary
        }

    @staticmethod
    def create_expense(db: Session, store_id: str, amount: int, category: str, expense_date: Any, description: Optional[str] = None) -> Expense:
        """[한글 주석] 매장의 원자재 매입이나 운영 지출 비용 내역을 데이터베이스에 신규 등록하고 저장합니다."""
        new_expense = Expense(
            store_id=store_id,
            amount=amount,
            category=category,
            expense_date=expense_date,
            description=description
        )
        db.add(new_expense)
        db.commit()
        db.refresh(new_expense)
        return new_expense

    @staticmethod
    def get_expenses(db: Session, store_id: str, year_month: Optional[str] = None) -> List[Expense]:
        """[한글 주석] 지정된 매장의 지출 내역 목록을 조회합니다. 연월(YYYY-MM) 필터를 적용할 수 있습니다."""
        query = db.query(Expense).filter(Expense.store_id == store_id)
        if year_month:
            try:
                year, month = map(int, year_month.split("-"))
                query = query.filter(
                    extract('year', Expense.expense_date) == year,
                    extract('month', Expense.expense_date) == month
                )
            except ValueError:
                pass
        return query.order_by(Expense.expense_date.desc()).all()

    # [중복 정의 제거] list_employees_payroll은 상단(기간 매핑 버전)에 이미 정의되어 있어 여기서는 삭제함
    # (이 버전은 calculate_payroll을 year_month로 잘못 호출하고 total_salary 키를 참조해 런타임 오류를 유발했음)
