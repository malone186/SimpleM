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


def ensure_store_profile_columns(engine) -> None:
    """[자가치유 스키마] 기존 store_profiles 테이블에 configured 컬럼이 없으면 멱등하게 추가한다.

    store_profiles는 configured 없이 먼저 만들어졌다. create_all은 기존 테이블을 ALTER하지
    않으므로, 컬럼이 빠진 채로 두면 매장 정보 조회가 통째로 500이 난다(실제로 그렇게 터졌다).
    기존 행은 사장님이 이미 저장한 값이므로 TRUE로 채운다 — FALSE로 두면 앱이
    '아직 설정 전'으로 보고 기기 기본값을 덮어써 버린다.
    """
    try:
        insp = inspect(engine)
        if not insp.has_table("store_profiles"):
            return  # 테이블 자체가 없으면 create_all이 스키마째로 생성한다
        existing = {c["name"] for c in insp.get_columns("store_profiles")}
    except Exception as e:
        logger.warning(f"[매장 스키마] store_profiles 점검 실패 — 건너뜁니다: {e}")
        return
    if "configured" in existing:
        return
    try:
        with engine.begin() as conn:
            conn.execute(text(
                "ALTER TABLE store_profiles ADD COLUMN configured BOOLEAN NOT NULL DEFAULT TRUE"
            ))
        logger.info("[매장 스키마] store_profiles.configured 컬럼 추가 완료")
    except Exception as e:
        logger.warning(f"[매장 스키마] configured 보강 실패 — 매장 정보 조회가 막힐 수 있습니다: {e}")


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


class DailySalesEntry(Base):
    """일 매출 수기 입력 — 현금/카드사별 금액을 하루 한 줄씩 저장한다.

    POS 연동이 없는 매장이 현실적으로 계속 입력할 수 있는 최소 단위다. 잔 수를
    메뉴별로 세는 건 아무도 안 하므로(사장님 피드백), 여기서는 '결제수단별 총액'만
    필수이고 잔 수(cups)는 선택이다. 메뉴별 판매는 재고 차감이 필요할 때만
    기존 Sale 테이블로 따로 넣는다.

    카드는 issuer(카드사)별로 나눠 담아야 수수료·입금예정일을 계산할 수 있다.
    (store_id, entry_date, method, issuer)로 유니크 — 같은 날 같은 카드사를 다시
    입력하면 덮어쓴다(수정 = 재입력).
    """

    __tablename__ = "daily_sales_entries"
    __table_args__ = (
        UniqueConstraint("store_id", "entry_date", "method", "issuer", "card_type",
                         name="uq_daily_sales_entry"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    store_id: Mapped[str] = mapped_column(String(100), index=True)
    entry_date: Mapped[str] = mapped_column(String(10), index=True)  # 매출 발생일 YYYY-MM-DD
    method: Mapped[str] = mapped_column(String(8), default="card")  # cash | card
    # 카드사 코드 (shinhan, kb, samsung, ...). 현금이면 빈 문자열
    issuer: Mapped[str] = mapped_column(String(20), default="")
    card_type: Mapped[str] = mapped_column(String(8), default="credit")  # credit | check (수수료율이 다르다)
    amount: Mapped[int] = mapped_column(Integer, default=0)  # 결제 총액 (원, 부가세 포함 실수령 전 금액)
    cups: Mapped[int | None] = mapped_column(Integer, nullable=True)  # 선택 — 적으면 객단가가 계산된다
    memo: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class EmployeeProfile(Base):
    """직원 고용 상세 — 이름·시급만으로는 인건비를 계산할 수 없어서 붙이는 정보.

    사장님이 실제로 구분해야 하는 건 시급이 아니라 '이 사람이 어떤 조건으로 일하는가'다:
      · 주 15시간 미만이냐(주휴수당·4대보험 대상 아님) 이상이냐
      · 시급제냐 월급제냐 (매니저는 대개 월급)
      · 4대보험 / 2대보험(고용·산재만) / 미가입
    이 세 가지에 따라 같은 시급이라도 실제 나가는 돈이 20% 넘게 차이 난다.

    employees 테이블(백엔드 C 소유)을 건드리지 않고 1:1로 붙이는 별도 테이블이다.
    """

    __tablename__ = "employee_profiles"

    employee_id: Mapped[int] = mapped_column(
        ForeignKey("employees.id", ondelete="CASCADE"), primary_key=True
    )
    store_id: Mapped[str] = mapped_column(String(100), index=True)
    # part_time(주 15시간 미만) | part_time_15(주 15시간 이상) | full_time(정규) | manager(매니저)
    employment_type: Mapped[str] = mapped_column(String(20), default="part_time")
    pay_type: Mapped[str] = mapped_column(String(10), default="hourly")  # hourly | monthly
    monthly_salary: Mapped[int] = mapped_column(Integer, default=0)  # pay_type=monthly일 때 월급(원)
    weekly_hours: Mapped[float] = mapped_column(Numeric(5, 2), default=0)  # 주 소정근로시간
    # four(4대보험) | two(고용·산재만) | none(미가입)
    insurance: Mapped[str] = mapped_column(String(8), default="two")
    # 주휴수당 지급 여부 — 법정 요건(주 15시간 이상)을 만족해도 계약으로 시급에 포함시킨
    # 경우가 있어(포괄산정) 매장이 끌 수 있게 둔다
    weekly_holiday_pay: Mapped[bool] = mapped_column(Boolean, default=True)
    hired_on: Mapped[str | None] = mapped_column(String(10), nullable=True)  # 입사일 YYYY-MM-DD
    memo: Mapped[str | None] = mapped_column(String(255), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class SettlementSetting(Base):
    """매장별 카드 정산 설정 — 수수료율 구간과 카드사별 입금 소요일.

    수수료율은 연매출 구간(영세/중소1~3/일반)에 따라 법으로 정해진 우대수수료율을
    쓰지만, 실제 계약은 매장마다 다를 수 있어 직접 입력(custom)도 허용한다.
    입금 소요일도 카드사·가맹점 등급마다 실무 차이가 있어 사장님이 통장을 보고
    고칠 수 있게 override를 JSON으로 보관한다.
    """

    __tablename__ = "settlement_settings"

    store_id: Mapped[str] = mapped_column(String(100), primary_key=True)
    # small(3억 이하) | mid1(3~5억) | mid2(5~10억) | mid3(10~30억) | general(30억 초과) | custom
    revenue_tier: Mapped[str] = mapped_column(String(16), default="small")
    # revenue_tier가 custom일 때 쓰는 직접 입력 수수료율 (%)
    custom_credit_fee: Mapped[float | None] = mapped_column(Numeric(5, 3), nullable=True)
    custom_check_fee: Mapped[float | None] = mapped_column(Numeric(5, 3), nullable=True)
    # {"shinhan": 3, "bc": 4} 형태 — 카드사별 입금 소요 영업일 덮어쓰기
    lag_overrides: Mapped[str] = mapped_column(Text, default="{}")
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class StoreProfile(Base):
    """매장 기본 정보 — 업종·영업 시작/종료 시각

    가입할 때 운영 시간을 물어보면서 정작 저장할 곳이 없었다. 입력값은 화면을 벗어나는
    순간 사라졌고, 설정 화면의 업종·운영시간도 기기 AsyncStorage에만 남아 재설치하면
    초기화됐다(그런데 화면은 "확정 업데이트됐어요"라고 말했다).

    users 테이블에 붙이는 게 자연스럽지만 그건 백엔드 A 소유이고 공유 DB에서는 postgres
    소유라 우리 계정으로 ALTER가 안 된다 — 그래서 이메일을 키로 별도 테이블에 둔다.
    ([[shared-db-table-ownership]]와 같은 이유로 admin_user_notes도 이렇게 분리했다)

    시각은 "HH:MM" 문자열로 둔다. 자정을 넘겨 닫는 가게(예: 10:00~02:00)가 흔해서
    시간 타입으로 두면 오히려 비교 로직이 꼬인다.
    """

    __tablename__ = "store_profiles"

    store_id: Mapped[str] = mapped_column(String(100), primary_key=True)
    business_type: Mapped[str] = mapped_column(String(50), default="카페")
    open_hour: Mapped[str] = mapped_column(String(5), default="09:00")
    close_hour: Mapped[str] = mapped_column(String(5), default="21:00")
    # 사장님이 실제로 저장한 적이 있는가. 조회 시 행을 기본값으로 만들어 주기 때문에,
    # 이 플래그가 없으면 '09:00이 진짜 설정값인지, 아무도 손 안 댄 기본값인지' 구분이 안 된다.
    # 앱은 이 값이 false일 때만 기기에 남아 있던 값을 서버로 올린다(가입 때 입력한 운영 시간).
    configured: Mapped[bool] = mapped_column(Boolean, default=False)
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


class AdminUserNote(Base):
    """관리자가 사장님 계정에 붙이는 운영 상태·CS 메모

    users 테이블은 백엔드 A 소유이고, 공유 DB에서는 postgres 계정 소유라 우리 계정으로
    ALTER도 안 된다. 그래서 계정 상태(활성/대기/정지)와 관리자 메모는 여기에 따로 둔다.
    이메일이 키다 — 회원이 탈퇴하면 행이 남지만, 같은 이메일로 재가입하면 이력이 이어진다.

    행이 없는 회원은 '활성 · 메모 없음'으로 본다 (관리자가 손댄 적 없다는 뜻).
    """

    __tablename__ = "admin_user_notes"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_email: Mapped[str] = mapped_column(String(100), unique=True, index=True)
    status: Mapped[str] = mapped_column(String(16), default="활성")  # 활성 | 대기 | 정지
    memo: Mapped[str] = mapped_column(Text, default="")
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


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


# ---------------------------------------------------------------------------
# 할 일 목록 — 명시적으로 적어둔 것만 저장한다
# ---------------------------------------------------------------------------


class TodoItem(Base):
    """대시보드 '오늘 할 일' 중 사장님이 직접 적었거나 브루(AI)가 추가한 항목.

    재고 부족·서류 갱신처럼 '조건에서 자동으로 도출되는' 할 일은 여기 저장하지 않는다.
    그건 대시보드가 재고·서류 API로 매번 조립하며, 재고를 채우면 저절로 사라져야 하는
    성질이다. 저장해 두면 상황이 해소된 뒤에도 유령 항목이 남는다.

    반대로 여기 담기는 건 '누군가 명시적으로 적어둔' 일이라 완료 표시 전까지 유지된다.
    """

    __tablename__ = "todo_items"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    store_id: Mapped[str] = mapped_column(String(100), index=True)
    title: Mapped[str] = mapped_column(String(200))
    # 왜 이 일이 생겼는지 — 대시보드 부제로 보인다 ("브루가 추가함", "사장님 직접 추가")
    note: Mapped[str | None] = mapped_column(String(255), nullable=True)
    source: Mapped[str] = mapped_column(String(16), default="owner", index=True)  # owner | ai
    done: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    due_date: Mapped[str | None] = mapped_column(String(10), nullable=True)  # YYYY-MM-DD
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    done_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
