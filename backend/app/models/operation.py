# c:\STUDY\SimpleM\backend\app\models\operation.py
"""운영/예측 모델 (백엔드 C) - 백엔드 A가 SQLAlchemy 표준 ORM 규격으로 수정"""
import logging
from sqlalchemy import Column, Integer, String, DateTime, ForeignKey, Date, Float, inspect, text
from sqlalchemy.sql import func
from app.core.database import Base

logger = logging.getLogger(__name__)

# 1. 직원 정보를 저장할 데이터베이스 테이블 설계도입니다.
class Employee(Base):
    """직원 정보 모델"""
    __tablename__ = "employees"  # 데이터베이스 내의 실제 테이블 명

    id = Column(Integer, primary_key=True, index=True)
    store_id = Column(String(100), nullable=True, index=True)  # 소속 매장(점주 이메일). 정산·급여 매장별 스코핑용
    name = Column(String(50), nullable=False)      # 직원 이름
    hourly_rate = Column(Integer, nullable=False)   # 시급 (KRW)
    role = Column(String(50), nullable=False)       # 직책/역할 (예: 바리스타)


def ensure_employee_store_column(engine) -> None:
    """[자가치유 스키마] 기존 employees 테이블에 store_id 컬럼이 없으면 멱등하게 추가한다.
    create_all은 기존 테이블을 ALTER하지 않으므로 배포 시 무중단으로 보강.
    기존(매장 미지정) 직원은 데모 기본 매장(owner@cafe.com)으로 백필해 정산 누락을 막는다."""
    try:
        insp = inspect(engine)
        if not insp.has_table("employees"):
            return
        existing = {c["name"] for c in insp.get_columns("employees")}
    except Exception as e:
        logger.warning(f"[직원 스키마] employees 점검 실패 — 건너뜁니다: {e}")
        return
    if "store_id" in existing:
        return
    try:
        with engine.begin() as conn:
            conn.execute(text("ALTER TABLE employees ADD COLUMN store_id VARCHAR(100)"))
            # 기존 직원은 데모 기본 매장으로 귀속 (매장별 정산에서 누락되지 않게)
            conn.execute(text("UPDATE employees SET store_id = 'owner@cafe.com' WHERE store_id IS NULL"))
        logger.info("[직원 스키마] employees.store_id 컬럼 추가 + 기존 직원 백필 완료")
    except Exception as e:
        logger.warning(f"[직원 스키마] store_id 보강 실패: {e}")


# 2. 알바생들의 스케줄을 저장할 데이터베이스 테이블 설계도입니다.
class Schedule(Base):
    """근무 스케줄 모델"""
    __tablename__ = "schedules"  # 데이터베이스 내의 실제 테이블 명

    id = Column(Integer, primary_key=True, index=True)
    
    # 이 스케줄이 어떤 직원(Employee)을 뜻하는지 외래키로 연결합니다.
    employee_id = Column(Integer, ForeignKey("employees.id", ondelete="CASCADE"), nullable=False)
    
    start_time = Column(DateTime, nullable=False)  # 근무 시작 시간
    end_time = Column(DateTime, nullable=False)    # 근무 종료 시간
    date = Column(String(20), nullable=False)      # 근무 일자 (YYYY-MM-DD)
    actual_start_time = Column(DateTime, nullable=True)  # 실제 출근 시간 (신규 추가)
    actual_end_time = Column(DateTime, nullable=True)    # 실제 퇴근 시간 (신규 추가)


# 3. 매장의 매입 비용 등 지출을 저장할 데이터베이스 테이블 설계도입니다.
class Expense(Base):
    """지출 비용 모델"""
    __tablename__ = "expenses"

    id = Column(Integer, primary_key=True, index=True)
    store_id = Column(String(100), nullable=False)                   # 매장 식별 아이디
    amount = Column(Integer, nullable=False, default=0)              # 지출 금액 (원)
    category = Column(String(50), nullable=False)                    # 지출 카테고리 (예: 원두매입, 소모품비 등)
    description = Column(String(255), nullable=True)                 # 상세 설명
    expense_date = Column(Date, nullable=False)                      # 지출 일자
    created_at = Column(DateTime, nullable=False, server_default=func.now())


# 4. 특정 기간 동안 계산된 직원의 예상 급여 정보를 저장하는 테이블입니다.
class EstimatedPayroll(Base):
    """예상 급여 결과 저장 모델"""
    __tablename__ = "estimated_payrolls"

    id = Column(Integer, primary_key=True, index=True)
    # 어떤 직원의 급여인지 설정 (외래키 연결)
    employee_id = Column(Integer, ForeignKey("employees.id", ondelete="CASCADE"), nullable=False)
    period_start = Column(String(20), nullable=False)   # 정산 시작일 (YYYY-MM-DD)
    period_end = Column(String(20), nullable=False)     # 정산 종료일 (YYYY-MM-DD)
    total_work_hours = Column(Float, nullable=False)    # 총 근무 시간
    estimated_salary = Column(Integer, nullable=False)  # 계산된 예상 급여액 (원)
    calculated_at = Column(DateTime, nullable=False, server_default=func.now())  # 계산이 실행된 시각


# 5. 특정 기간 동안의 매출, 지출, 인건비를 종합한 예상 정산 정보를 저장하는 테이블입니다.
class EstimatedSettlement(Base):
    """예상 정산 결과 저장 모델"""
    __tablename__ = "estimated_settlements"

    id = Column(Integer, primary_key=True, index=True)
    period_start = Column(String(20), nullable=False)   # 정산 시작일 (YYYY-MM-DD)
    period_end = Column(String(20), nullable=False)     # 정산 종료일 (YYYY-MM-DD)
    total_sales = Column(Integer, nullable=False)       # 해당 기간의 예상 매출액 (원)
    total_expense = Column(Integer, nullable=False)     # 해당 기간의 예상 매입/운영 비용 (원)
    total_payroll = Column(Integer, nullable=False)     # 해당 기간의 예상 총 인건비 (원)
    other_expense = Column(Integer, nullable=False, default=0) # 해당 기간의 기타 추가 지출 비용 (원)
    net_profit = Column(Integer, nullable=False)        # 예상 매출 - (비용 + 인건비 + 기타비용) 순수익 (원)
    calculated_at = Column(DateTime, nullable=False, server_default=func.now())  # 계산이 실행된 시각


# 6. 직원별 기피/불가 시간 설정을 저장하는 테이블입니다. (신규 추가)
class EmployeeUnavailability(Base):
    """직원 기피/불가 시간 설정 모델"""
    __tablename__ = "employee_unavailabilities"

    id = Column(Integer, primary_key=True, index=True)
    # 기피 시간을 신청한 직원의 외래키 아이디
    employee_id = Column(Integer, ForeignKey("employees.id", ondelete="CASCADE"), nullable=False)
    
    # 기피 유형: 'weekly_recurring' (매주 특정 요일 반복) 또는 'specific_date' (특정 날짜 지정)
    unavailability_type = Column(String(30), nullable=False, default="weekly_recurring")
    
    # 요일 반복일 때 요일 번호 (0=월요일, 1=화요일, ..., 6=일요일)
    day_of_week = Column(Integer, nullable=True)
    
    # 특정 날짜 지정일 때 날짜 문자열 (YYYY-MM-DD 포맷)
    specific_date = Column(String(10), nullable=True)
    
    # 시작 시각 (0 ~ 23시)
    start_hour = Column(Integer, nullable=False, default=0)
    
    # 종료 시각 (1 ~ 24시)
    end_hour = Column(Integer, nullable=False, default=24)
    
    # 제약 수준: 'hard' (절대 근무 불가 - 배정 금지) | 'soft' (가급적 회피 - 페널티 부여 후 가급적 배정 지양)
    restriction_level = Column(String(10), nullable=False, default="hard")
    
    # 기피 신청 사유 (예: 학원 수업, 병원 방문 등)
    reason = Column(String(255), nullable=True)
    
    # 생성 일시
    created_at = Column(DateTime, nullable=False, server_default=func.now())

