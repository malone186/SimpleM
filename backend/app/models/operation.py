# c:\STUDY\SimpleM\backend\app\models\operation.py
"""운영/예측 모델 (백엔드 C) - 백엔드 A가 SQLAlchemy 표준 ORM 규격으로 수정"""
from sqlalchemy import Column, Integer, String, DateTime, ForeignKey
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
