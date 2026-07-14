"""AI 관련 모델 (백엔드 B)"""

from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, Numeric, String, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base


class OcrDocument(Base):
    """OCR 문서 헤더 — 명세서/영수증 사진 1장 = 행 1개 (PRD §8 ai 도메인)

    품목 상세는 ocr_items에 행 단위로 저장한다. 검증 경고는 저장하지 않고 조회 시 재계산.
    """

    __tablename__ = "ocr_documents"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    status: Mapped[str] = mapped_column(String(16), default="draft", index=True)  # draft | confirmed | rejected
    doc_type: Mapped[str] = mapped_column(String(32), default="unknown")  # purchase_statement | tax_invoice | receipt | sales_summary
    vendor_name: Mapped[str | None] = mapped_column(String(100), nullable=True)  # 거래처(공급자) 이름
    issued_date: Mapped[str | None] = mapped_column(String(10), nullable=True)  # 발행일 YYYY-MM-DD
    discount: Mapped[float | None] = mapped_column(Numeric(12, 2), nullable=True)  # 할인 총액 (양수)
    subtotal: Mapped[float | None] = mapped_column(Numeric(12, 2), nullable=True)  # 공급가액
    tax: Mapped[float | None] = mapped_column(Numeric(12, 2), nullable=True)  # 세액
    total: Mapped[float | None] = mapped_column(Numeric(12, 2), nullable=True)  # 합계
    # 등록 대상 (inventory_inbound | expense | sales) — draft 상태면 AI 추천값, confirmed면 사람이 확정한 값
    target: Mapped[str | None] = mapped_column(String(32), nullable=True)
    applied: Mapped[bool] = mapped_column(Boolean, default=False)  # 확정 후 대상 시스템 반영 여부 (A의 재고 반영 훅이 사용)
    # 원본 사진은 uploads/ocr/{id}.jpg 규칙으로 저장되므로 경로 컬럼 불필요
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    items: Mapped[list["OcrItem"]] = relationship(
        back_populates="document", cascade="all, delete-orphan", order_by="OcrItem.position"
    )


class OcrItem(Base):
    """OCR 인식 품목 — 재료명·개수·단가를 컬럼으로 분리 저장"""

    __tablename__ = "ocr_items"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    document_id: Mapped[str] = mapped_column(
        ForeignKey("ocr_documents.id", ondelete="CASCADE"), index=True
    )
    position: Mapped[int] = mapped_column(Integer, default=0)  # 문서 내 순서
    name: Mapped[str] = mapped_column(String(200))  # 재료(품목)명
    spec: Mapped[str | None] = mapped_column(String(100), nullable=True)  # 규격 (예: 1L, 500g)
    quantity: Mapped[float | None] = mapped_column(Numeric(12, 3), nullable=True)  # 개수/수량
    unit: Mapped[str | None] = mapped_column(String(20), nullable=True)  # 단위 (개, box, kg 등)
    unit_price: Mapped[float | None] = mapped_column(Numeric(12, 2), nullable=True)  # 단가
    amount: Mapped[float | None] = mapped_column(Numeric(12, 2), nullable=True)  # 금액

    document: Mapped[OcrDocument] = relationship(back_populates="items")
