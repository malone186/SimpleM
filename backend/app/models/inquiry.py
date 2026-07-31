"""
1대1 문의 및 요청사항 SQLAlchemy 데이터 모델 (한글 주석 적용)
"""
from sqlalchemy import Column, Integer, String, Text, DateTime
from app.core.database import Base
from app.utils.datetime_kst import utc_now

class Inquiry(Base):
    __tablename__ = "inquiries"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    user_email = Column(String(255), nullable=False)
    store_name = Column(String(255), nullable=True, default="포슬카페")
    category = Column(String(100), nullable=False)
    title = Column(String(255), nullable=False)
    content = Column(Text, nullable=False)
    status = Column(String(50), default="pending")  # 'pending' or 'answered'
    answer = Column(Text, nullable=True)
    # 저장은 UTC(naive)로 통일한다 — 화면에 뿌릴 때 utils.datetime_kst.fmt_kst로 KST 변환.
    # 여기서 바로 KST를 넣으면 이미 쌓인 UTC 행들과 섞여 목록의 시각 기준이 둘이 된다.
    created_at = Column(DateTime, default=utc_now)
    answered_at = Column(DateTime, nullable=True)
