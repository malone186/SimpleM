# c:\STUDY\SimpleM\backend\app\models\operation.py
"""운영/예측 모델 (백엔드 C) - 백엔드 A가 SQLAlchemy 표준 ORM 규격으로 수정"""
from sqlalchemy import Column, Integer, String, DateTime, ForeignKey, Date, Float
from sqlalchemy.sql import func
from app.core.database import Base

# 1. 직원 정보를 저장할 데이터베이스 테이블 설계도입니다.
class Employee(Base):
    """직원 정보 모델"""
    __tablename__ = "employees"  # 데이터베이스 내의 실제 테이블 명

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(50), nullable=False)      # 직원 이름
    hourly_rate = Column(Integer, nullable=False)   # 시급 (KRW)
    role = Column(String(50), nullable=False)       # 직책/역할 (예: 바리스타)


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

