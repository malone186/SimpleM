"""AI 관련 모델 (백엔드 B)"""

import logging
from datetime import datetime

from sqlalchemy import (
    BigInteger, Boolean, DateTime, ForeignKey, Integer, Numeric, String, Text, UniqueConstraint,
    func, inspect, text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base

logger = logging.getLogger(__name__)


class OcrDocument(Base):
    """OCR 문서 헤더 — 명세서/영수증 사진 1장 = 행 1개 (PRD §8 ai 도메인)

    품목 상세는 ocr_items에 행 단위로 저장한다. 검증 경고는 저장하지 않고 조회 시 재계산.
    """

    __tablename__ = "ocr_documents"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    # 업로드한 매장(로그인 이메일) — 초안은 매장별로만 보인다. NULL은 비로그인 업로드(개발 데모)
    store_id: Mapped[str | None] = mapped_column(String(100), index=True, nullable=True)
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


def ensure_ocr_store_column(engine) -> None:
    """[자가치유 스키마] 기존 ocr_documents 테이블에 store_id 컬럼이 없으면 멱등하게 추가한다.

    store_id는 나중에 도입된 컬럼이라 그 전에 만들어진 DB에는 없다. create_all은 기존
    테이블을 ALTER하지 않으므로, 컬럼이 빠진 채로 두면 매장별 OCR 조회가 전부 실패한다.
    nullable이라 기존 행(비로그인 업로드분)은 그대로 남는다.
    """
    try:
        insp = inspect(engine)
        if not insp.has_table("ocr_documents"):
            return  # 테이블 자체가 없으면 create_all이 스키마째로 생성한다
        existing = {c["name"] for c in insp.get_columns("ocr_documents")}
    except Exception as e:
        logger.warning(f"[OCR 스키마] ocr_documents 점검 실패 — 건너뜁니다: {e}")
        return
    if "store_id" in existing:
        return
    try:
        with engine.begin() as conn:
            conn.execute(text("ALTER TABLE ocr_documents ADD COLUMN store_id VARCHAR(100)"))
            conn.execute(text("CREATE INDEX IF NOT EXISTS ix_ocr_documents_store_id "
                              "ON ocr_documents (store_id)"))
        logger.info("[OCR 스키마] ocr_documents.store_id 컬럼 추가 완료")
    except Exception as e:
        logger.warning(f"[OCR 스키마] store_id 보강 실패 — 매장별 OCR 조회가 막힐 수 있습니다: {e}")


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


class AdminAccount(Base):
    """관리자 콘솔 계정 — 비밀번호를 공유 DB에 bcrypt 해시로 저장한다

    각 팀원 PC의 .env(ADMIN_PASSWORD)에 의존하지 않고, 어느 컴퓨터에서 백엔드를
    띄우든 같은 아이디·비밀번호로 로그인되게 한다. 행이 없으면 최초 로그인 시
    env 자격증명으로 검증 후 자동 생성된다(무중단 이행).
    """

    __tablename__ = "admin_accounts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    email: Mapped[str] = mapped_column(String(100), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(100))  # bcrypt
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), onupdate=func.now(), nullable=True)


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


class InsightAck(Base):
    """선제 인사이트 확인·미루기 기록 — 같은 알림이 계속 다시 뜨지 않게 한다

    인사이트 자체는 저장하지 않는다(매번 DB에서 새로 계산). 여기 남기는 건
    "사장님이 이 건을 이미 봤다"는 사실뿐이라, 상황이 바뀌면 key가 달라져
    새 인사이트로 다시 올라온다. snooze_until이 지나면 자동으로 되살아난다.
    """

    __tablename__ = "insight_acks"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    store_id: Mapped[str] = mapped_column(String(100), index=True)
    insight_key: Mapped[str] = mapped_column(String(200), index=True)  # insight_service가 만든 dedup 키
    acked_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    # NULL이면 영구 숨김, 값이 있으면 그 시각 이후 다시 알린다
    snooze_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


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


# ---------------------------------------------------------------------------
# 푸시 알림 (FCM) — 앱을 닫아둔 사이에 놓치면 손해가 나는 사건만 내보낸다
# ---------------------------------------------------------------------------


class DeviceToken(Base):
    """FCM 기기 등록 토큰 — 한 매장이 여러 기기(사장님 폰·태블릿)를 쓸 수 있다.

    토큰은 앱 재설치·데이터 삭제·장기 미사용으로 언제든 무효화되므로 영구 식별자가 아니다.
    프론트가 갱신 이벤트를 받을 때마다 재등록하고(upsert), 발송 시 FCM이 UNREGISTERED로
    거절한 토큰은 push_service가 즉시 지운다. 죽은 토큰을 쌓아두면 발송량만 늘고
    성공률 지표가 망가진다.
    """

    __tablename__ = "device_tokens"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    store_id: Mapped[str] = mapped_column(String(100), index=True)
    token: Mapped[str] = mapped_column(String(255), unique=True, index=True)  # FCM registration token
    platform: Mapped[str] = mapped_column(String(16), default="android")
    device_name: Mapped[str | None] = mapped_column(String(100), nullable=True)  # 관리 화면 표시용
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    # 마지막으로 앱이 이 토큰을 다시 등록한 시각 — 오래 갱신되지 않은 토큰 정리 기준
    last_seen_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class NotificationSetting(Base):
    """매장별 푸시 수신 설정 — 기기 로컬(AsyncStorage) 설정의 서버 사본.

    푸시는 서버가 보내므로 방해금지 구간과 종류별 on/off를 서버가 알아야 한다.
    프론트 설정 화면이 바뀔 때마다 PUT으로 동기화한다.
    """

    __tablename__ = "notification_settings"

    store_id: Mapped[str] = mapped_column(String(100), primary_key=True)
    push_enabled: Mapped[bool] = mapped_column(Boolean, default=True)  # 마스터 스위치
    compliance_alert: Mapped[bool] = mapped_column(Boolean, default=True)   # 갱신 임박 서류
    report_alert: Mapped[bool] = mapped_column(Boolean, default=True)       # 경영 리포트 도착
    stock_alert: Mapped[bool] = mapped_column(Boolean, default=True)        # 재고 소진 임박
    sensor_alert: Mapped[bool] = mapped_column(Boolean, default=True)       # 설비 이상(긴급)
    report_frequency: Mapped[str] = mapped_column(String(10), default="weekly")  # daily | weekly
    dnd_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    dnd_start: Mapped[str] = mapped_column(String(5), default="22:00")  # HH:MM
    dnd_end: Mapped[str] = mapped_column(String(5), default="08:00")
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class SentNotification(Base):
    """발송 이력 — 같은 사건을 두 번 보내지 않기 위한 멱등 키 저장소.

    dedupe_key에 '무엇에 대한 몇 번째 알림인지'를 담는다 (예: compliance:12:D-7,
    report:weekly:2026-07-27). 스케줄러가 재시도되거나 두 번 겹쳐 돌아도
    (store_id, dedupe_key) 유니크 제약이 중복 발송을 막는다.
    """

    __tablename__ = "sent_notifications"
    __table_args__ = (UniqueConstraint("store_id", "dedupe_key", name="uq_sent_notification"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    store_id: Mapped[str] = mapped_column(String(100), index=True)
    dedupe_key: Mapped[str] = mapped_column(String(120))
    category: Mapped[str] = mapped_column(String(32), index=True)  # compliance | report | stock | sensor
    title: Mapped[str] = mapped_column(String(200))
    body: Mapped[str] = mapped_column(Text, default="")
    sent_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), index=True)
