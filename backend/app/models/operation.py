"""운영/예측 모델 (백엔드 C)"""
from datetime import datetime

# 백엔드 A의 DB 연결 설정(Base) 존재 여부에 따른 임시 상속 구조 대응
try:
    from app.core.database import Base
except ImportError:
    class Base:
        pass

class Employee(Base):
    """직원 정보 모델"""
    def __init__(self, id: int, name: str, hourly_rate: int, role: str):
        self.id = id                  # 직원 고유 ID
        self.name = name              # 직원 이름
        self.hourly_rate = hourly_rate # 시급 (KRW)
        self.role = role              # 직책/역할 (예: 바리스타)

class Schedule(Base):
    """근무 스케줄 모델"""
    def __init__(self, id: int, employee_id: int, start_time: datetime, end_time: datetime, date: str):
        self.id = id                  # 스케줄 고유 ID
        self.employee_id = employee_id # 근무 직원 ID
        self.start_time = start_time   # 근무 시작 시간
        self.end_time = end_time       # 근무 종료 시간
        self.date = date              # 근무 일자 (YYYY-MM-DD)
