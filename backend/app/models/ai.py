"""AI 관련 모델 (백엔드 B)"""

from datetime import datetime

from sqlalchemy import JSON, Boolean, DateTime, Float, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class OcrDocument(Base):
    """OCR 원본 이미지·인식 결과·확정 여부 (PRD §8 ai 도메인)

    명세서/영수증 사진 1장 = 행 1개. 인식 결과(품목·금액)는 result JSON에 통째로 저장하고,
    조회·필터에 쓰는 값(status, 대상, 시각)만 컬럼으로 뺐다.
    """

    __tablename__ = "ocr_documents"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    status: Mapped[str] = mapped_column(String(16), default="draft", index=True)  # draft | confirmed | rejected
    filename: Mapped[str | None] = mapped_column(String(255), nullable=True)
    image_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    ocr_text: Mapped[str | None] = mapped_column(Text, nullable=True)  # OCR 원문 (디버깅·재구조화용)
    result: Mapped[dict] = mapped_column(JSON, default=dict)  # OcrResult 직렬화 (doc_type, vendor, items[], discount, subtotal, tax, total)
    warnings: Mapped[list] = mapped_column(JSON, default=list)  # 문서 수준 검증 경고
    suggested_target: Mapped[str | None] = mapped_column(String(32), nullable=True)  # inventory_inbound | expense | sales
    confirmed_target: Mapped[str | None] = mapped_column(String(32), nullable=True)
    applied: Mapped[bool] = mapped_column(Boolean, default=False)  # 확정 후 대상 시스템 반영 여부
    elapsed_sec: Mapped[float | None] = mapped_column(Float, nullable=True)  # OCR 처리 소요 시간
    ocr_backend: Mapped[str | None] = mapped_column(String(32), nullable=True)  # clova_gemini | paddle_gemini | ollama_vlm
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
