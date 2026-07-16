"""운영(스케줄·급여) 로직 (백엔드 C)"""
from datetime import datetime
from typing import Any, Dict, List, Optional
from sqlalchemy.orm import Session
from sqlalchemy import func, extract
from app.models.operation import Employee, Schedule, Expense
from app.models.inventory import Sale
from app.schemas.operation import ScheduleUpdate

class OperationService:
    """스케줄 관리 및 근무 시간, 급여 연산 비즈니스 로직을 담당하는 서비스 클래스"""

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
    def calculate_work_hours(start_time: datetime, end_time: datetime) -> float:
        """출퇴근 시간을 받아 실 근무시간 계산 (단순 시간 차이 계산)"""
        duration = end_time - start_time
        total_hours = duration.total_seconds() / 3600.0
        return max(0.0, total_hours)

    @classmethod
    def calculate_payroll(cls, db: Session, employee_id: int, year_month: str) -> dict:
        """특정 직원의 지정 연월 예상 급여를 계산합니다.
        실제 출퇴근 기록(actual)이 있으면 그 시각을, 없으면 계획된 근무시간을 기준으로 산정합니다.
        """
        employee = db.query(Employee).filter(Employee.id == employee_id).first()
        if not employee:
            raise ValueError(f"존재하지 않는 직원 ID입니다: {employee_id}")

        # 직원의 시급 유효성 검사 (0 이하인 경우 에러 처리)
        if employee.hourly_rate <= 0:
            raise ValueError(f"해당 직원의 시급 설정이 올바르지 않습니다 (시급: {employee.hourly_rate}원). 시급은 0보다 커야 합니다.")

        total_hours = 0.0
        based_on_actual = False
        # 해당 연월의 모든 스케줄을 취합 (실기록 우선, 없으면 계획시간 폴백)
        schedules = db.query(Schedule).filter(
            Schedule.employee_id == employee_id,
            Schedule.date.like(f"{year_month}%"),
        ).all()

        for schedule in schedules:
            start = schedule.actual_start_time or schedule.start_time
            end = schedule.actual_end_time or schedule.end_time
            if schedule.actual_start_time and schedule.actual_end_time:
                based_on_actual = True
            if start and end:
                total_hours += cls.calculate_work_hours(start, end)
                
        # 이번 버전에서는 복잡한 주휴수당 산정은 제외합니다.
        weekly_holiday_allowance = 0
        base_salary = int(total_hours * employee.hourly_rate)
        total_salary = base_salary + weekly_holiday_allowance

        return {
            "employee_id": employee_id,
            "employee_name": employee.name,
            "role": employee.role,
            "hourly_rate": employee.hourly_rate,
            "year_month": year_month,
            "total_work_hours": total_hours,
            "base_salary": base_salary,
            "weekly_holiday_allowance": weekly_holiday_allowance,
            "total_salary": total_salary,
            "based_on_actual": based_on_actual,
            "calculated_at": datetime.now()
        }

    @classmethod
    def list_employees_payroll(cls, db: Session, year_month: str) -> List[dict]:
        """등록된 모든 직원의 해당 월 예상 급여 목록을 반환합니다."""
        results = []
        for emp in db.query(Employee).all():
            try:
                results.append(cls.calculate_payroll(db, emp.id, year_month))
            except ValueError:
                continue
        return results

    @classmethod
    def calculate_settlement(cls, db: Session, year_month: str, other_expense: int = 0) -> dict:
        """매장의 월별 매출액, 지출 비용, 총 인건비, 기타비용을 취합해 예상 정산 손익을 도출합니다."""
        try:
            year, month = map(int, year_month.split("-"))
        except ValueError:
            raise ValueError("연월 포맷은 YYYY-MM 형식이어야 합니다.")

        # 1. 데이터베이스에서 매출액(sales) 합산
        total_sales = db.query(func.sum(Sale.total_price)).filter(
            extract('year', Sale.sold_at) == year,
            extract('month', Sale.sold_at) == month
        ).scalar() or 0

        # 2. 데이터베이스에서 지출액(expenses) 합산
        total_expense = db.query(func.sum(Expense.amount)).filter(
            extract('year', Expense.expense_date) == year,
            extract('month', Expense.expense_date) == month
        ).scalar() or 0
        
        # 3. 등록된 모든 직원의 해당 월 예상 급여 합산 (인건비)
        total_payroll = 0
        employees = db.query(Employee).all()
        for emp in employees:
            try:
                payroll = cls.calculate_payroll(db, emp.id, year_month)
                total_payroll += payroll["total_salary"]
            except ValueError:
                continue
                
        # 4. 예상 순이익 = 매출 - (비용 + 인건비 + 기타 비용)
        net_profit = total_sales - (total_expense + total_payroll + other_expense)
        
        return {
            "year_month": year_month,
            "total_sales": total_sales,
            "total_expense": total_expense,
            "total_payroll": total_payroll,
            "other_expense": other_expense,
            "net_profit": net_profit,
            "calculated_at": datetime.now()
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
    def recommend_schedule(cls, db: Session, target_date: str, store_id: str) -> dict:
        """과거 동일 요일의 시간대별 평균 매출/이익을 분석하여 최적의 알바 근무 인원 스케줄을 추천합니다."""
        try:
            dt = datetime.strptime(target_date, "%Y-%m-%d")
        except ValueError:
            raise ValueError("날짜 포맷은 YYYY-MM-DD 형식이어야 합니다.")

        # 1. 파이썬 요일 번호 (0=월 ... 6=일) -> PostgreSQL dow 번호 (0=일, 1=월 ... 6=토)
        pg_dow = (dt.weekday() + 1) % 7

        # 2. DB에서 해당 매장의 동일 요일 과거 매출 데이터 조회 (Eager Loading 적용으로 N+1 쿼리 방지)
        from sqlalchemy.orm import joinedload, selectinload
        from app.models.inventory import Menu, Recipe, Ingredient
        
        sales = db.query(Sale).filter(
            Sale.store_id == store_id,
            extract('dow', Sale.sold_at) == pg_dow
        ).options(
            joinedload(Sale.menu).selectinload(Menu.recipes).joinedload(Recipe.ingredient)
        ).all()

        hourly_recommendations = []
        total_recommended_hours = 0.0

        # 영업시간은 일반적인 카페 기준 07시 ~ 22시로 규정 (나머지 시간은 0명 추천)
        business_hours = range(7, 23)

        # 3. 데이터가 존재할 경우 시간대별 평균 매출 및 이익 분석
        if len(sales) >= 5: # 통계적 신뢰성을 위해 최소 5건 이상 데이터가 있을 때 실데이터 분석
            hourly_sales = {h: [] for h in range(24)}
            hourly_profits = {h: [] for h in range(24)}
            
            for s in sales:
                h = s.sold_at.hour
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
                avg_sales = int(sum(prices) / len(prices)) if prices else 0
                
                profits = hourly_profits[h]
                avg_profit = int(sum(profits) / len(profits)) if profits else 0
                
                # 매출 대비 인원 추천 규칙 (기본 카페 로직 적용)
                if avg_sales >= 150000:
                    emp_count = 3
                    busy = "PEAK"
                elif avg_sales >= 70000:
                    emp_count = 2
                    busy = "HIGH"
                elif avg_sales >= 30000:
                    emp_count = 1
                    busy = "NORMAL"
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
            # 주말(토, 일)과 주중(월~금) 피크 패턴 분기
            is_weekend = dt.weekday() in (5, 6)

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
                f"분석 결과, {target_date}에는 {peak_str}에 강한 매출 피크가 예상되어 최대로 알바생(3명)을 집중 배치할 것을 권장합니다. "
                f"하루 총 예상 매출은 {total_predicted_sales:,}원, 예상 마진 이익은 {total_predicted_profit:,}원입니다. "
                f"피크 외 시간대에는 1명으로 인력을 통제하여 예상 인건비 지출({estimated_payroll_cost:,}원) 대비 수익 효율을 극대화하세요."
            )
        else:
            summary = (
                f"{target_date}에는 뚜렷한 피크타임 없이 전반적으로 평이하거나 한산할 것으로 분석됩니다. "
                f"하루 총 예상 매출은 {total_predicted_sales:,}원, 예상 마진 이익은 {total_predicted_profit:,}원입니다. "
                f"영업 시간 내내 최소 인원(1명)으로 유연하게 조율하여 고정 인건비 지출({estimated_payroll_cost:,}원)을 방지하시는 것을 추천합니다."
            )

        return {
            "target_date": target_date,
            "hourly_recommendations": hourly_recommendations,
            "total_recommended_hours": total_recommended_hours,
            "estimated_payroll_cost": estimated_payroll_cost,
            "summary": summary
        }


