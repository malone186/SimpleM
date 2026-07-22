"""AI 관련 모델 (백엔드 B)"""

from datetime import datetime

from sqlalchemy import BigInteger, Boolean, DateTime, ForeignKey, Integer, Numeric, String, Text, func
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


class GeneratedDocument(Base):
    """자동 생성 문서 (ERP-12 서류 자동화) — 발주서·임금명세서·장부 등 초안 보관

    돈이 걸린 문서(발주서·임금명세서)는 draft로만 생성되고 확정·전송은 사람이 한다 (PRD §5.3).
    임금명세서는 임금대장 겸용으로 3년 보관 의무가 있으므로 삭제하지 않는다.
    """

    __tablename__ = "generated_documents"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    store_id: Mapped[str] = mapped_column(String(100), index=True)
    # purchase_order | stocktake_sheet | inspection_report | monthly_ledger |
    # vat_reference | payslip | employment_contract
    kind: Mapped[str] = mapped_column(String(32), index=True)
    title: Mapped[str] = mapped_column(String(200))
    period: Mapped[str | None] = mapped_column(String(32), nullable=True)  # 대상 기간 (예: 2026-07, 2026-07-01~2026-10-01)
    content: Mapped[str] = mapped_column(Text)  # 문서 본문 JSON (스키마는 kind별로 다름)
    status: Mapped[str] = mapped_column(String(16), default="draft")  # draft | confirmed
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class ChatSession(Base):
    """챗봇 대화 세션 — 사용자별 대화 기록을 서버에 보관 (기기·브라우저가 바뀌어도 이어보기)

    말풍선 배열은 프론트 ChatMsg[] 모양 그대로 JSON 문자열로 저장해 복원 시 무손실.
    id는 프론트가 만드는 값(s<epoch_ms>)이라 사용자 간 충돌이 가능하므로 store_id와 복합 PK.
    시각은 프론트 정렬·표시 기준인 epoch ms 정수를 그대로 보관한다.
    """

    __tablename__ = "chat_sessions"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    store_id: Mapped[str] = mapped_column(String(100), primary_key=True, index=True)
    title: Mapped[str] = mapped_column(String(100))
    messages: Mapped[str] = mapped_column(Text)  # ChatMsg[] JSON (docs 문서 카드 포함)
    created_at_ms: Mapped[int] = mapped_column(BigInteger)
    updated_at_ms: Mapped[int] = mapped_column(BigInteger, index=True)


class AdminNotification(Base):
    """관리자 공지·알림 — 관리자 콘솔에서 발송해 사장님 앱이 폴링으로 수신한다

    target_type: all(전체) | premium(프리미엄 회원) | specific(특정 매장 1곳)
    specific일 때만 target_email에 수신 사장님 이메일이 들어간다.
    """

    __tablename__ = "admin_notifications"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    title: Mapped[str] = mapped_column(String(200))
    body: Mapped[str] = mapped_column(Text, default="")
    target_type: Mapped[str] = mapped_column(String(16), default="all", index=True)
    target_email: Mapped[str | None] = mapped_column(String(100), nullable=True, index=True)
    target_label: Mapped[str] = mapped_column(String(100), default="전체 사장님")  # 관리자 웹 표시용
    author: Mapped[str] = mapped_column(String(50), default="최고 관리자")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class ComplianceItem(Base):
    """정기 갱신 서류 만료 추적 — 위생교육 수료증·보건증·임대차/공급 계약 등

    서류 자체는 기관에서 발급받아야 하므로 만료일을 추적해 미리 알리는 것까지가 자동화 범위.
    """

    __tablename__ = "compliance_items"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    store_id: Mapped[str] = mapped_column(String(100), index=True)
    name: Mapped[str] = mapped_column(String(100))  # 예: 보건증(홍길동), 임대차계약
    expiry_date: Mapped[str] = mapped_column(String(10))  # 만료일 YYYY-MM-DD
    remind_before_days: Mapped[int] = mapped_column(Integer, default=30)  # 며칠 전부터 알릴지
    memo: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
