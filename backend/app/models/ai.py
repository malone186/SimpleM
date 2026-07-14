"""AI 관련 모델 (백엔드 B)

주의: core/database.py(백엔드 A)의 Base가 아직 스텁이라 이 모듈은 어디서도 import하지 않는다.
A가 Base를 구현하고 models/__init__.py에 알파벳순 등록되는 시점부터 활성화된다.
그때까지 OCR 초안은 services/ai/ocr_service.py의 인메모리 저장소를 쓴다.
"""

from datetime import datetime

from sqlalchemy import JSON, Boolean, DateTime, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class OcrDocument(Base):
    """OCR 원본 이미지·인식 결과·확정 여부 (PRD §8 ai 도메인)"""

    __tablename__ = "ocr_documents"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    status: Mapped[str] = mapped_column(String(16), default="draft")  # draft | confirmed | rejected
    filename: Mapped[str | None] = mapped_column(String(255), nullable=True)
    image_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    result: Mapped[dict] = mapped_column(JSON, default=dict)  # OcrResult 직렬화
    warnings: Mapped[list] = mapped_column(JSON, default=list)
    suggested_target: Mapped[str | None] = mapped_column(String(32), nullable=True)
    confirmed_target: Mapped[str | None] = mapped_column(String(32), nullable=True)
    applied: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
