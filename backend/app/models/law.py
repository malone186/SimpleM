# backend/app/models/law.py
"""
[한글 주석] 법령 RAG 원문 보관용 RDB 모델 (LawArticle)

본 모델은 ChromaDB 임베딩의 원천 데이터가 되는 법령 조문 원문과 
변경 감지용 content_hash, 시행일, 출처 정보 등을 RDB에 안전하게 보관합니다.
"""

from sqlalchemy import Column, Integer, String, Text, DateTime
from sqlalchemy.sql import func
from app.core.database import Base


class LawArticle(Base):
    """법령 조문 원문 보관 모델"""
    __tablename__ = "law_articles"

    id = Column(Integer, primary_key=True, index=True)
    law_name = Column(String(100), nullable=False, index=True)      # 법령명 (예: 근로기준법)
    article_no = Column(String(50), nullable=False, index=True)      # 조문번호 (예: 제54조)
    category = Column(String(50), nullable=False, index=True)        # 법령 카테고리 (노무, 임대차, 위생 등)
    content = Column(Text, nullable=False)                          # 조문 원문 내용
    summary = Column(Text, nullable=True)                           # 조문 요약 (선택)
    source = Column(String(255), nullable=False)                    # 출처 (예: 국가법령정보센터)
    effective_date = Column(String(20), nullable=False, default="2026-01-01") # 시행일자 (YYYY-MM-DD)
    content_hash = Column(String(64), nullable=False, index=True)   # 변경 감지용 SHA256 해시값
    
    created_at = Column(DateTime, nullable=False, server_default=func.now())
    updated_at = Column(DateTime, nullable=False, server_default=func.now(), onupdate=func.now())
