"""AI 관련 모델 (백엔드 B)"""

import logging
from datetime import datetime

from sqlalchemy import (
    BigInteger, Boolean, DateTime, Float, ForeignKey, Integer, Numeric, String, Text,
    UniqueConstraint, func, inspect, text,
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
    # 직원 대표 색(#RRGGBB) — 근무 달력의 점·선과 아바타가 같은 색이어야 한 사람으로 읽힌다
    color: Mapped[str | None] = mapped_column(String(9), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


def ensure_employee_profile_columns(engine) -> None:
    """[자가치유 스키마] employee_profiles에 color 컬럼이 없으면 보강한다.

    create_all은 기존 테이블을 ALTER하지 않는다 — 공유 DB에는 이미 이 테이블이 있어서
    컬럼만 추가하려면 여기서 직접 붙여야 한다(안 붙이면 저장 시 500).
    """
    try:
        insp = inspect(engine)
        if not insp.has_table("employee_profiles"):
            return
        existing = {c["name"] for c in insp.get_columns("employee_profiles")}
    except Exception as e:
        logger.warning(f"[직원 프로필 스키마] 점검 실패 — 건너뜁니다: {e}")
        return
    if "color" in existing:
        return
    try:
        with engine.begin() as conn:
            conn.execute(text("ALTER TABLE employee_profiles ADD COLUMN color VARCHAR(9)"))
        logger.info("[직원 프로필 스키마] employee_profiles.color 컬럼 추가 완료")
    except Exception as e:
        logger.warning(f"[직원 프로필 스키마] color 보강 실패: {e}")


class EmployeeAvailability(Base):
    """직원이 "이 요일 이 시간대엔 일할 수 있어요"라고 알려 준 근무 가능 시간 (주간 반복).

    이미 있는 employee_unavailabilities(백엔드 C)는 반대 방향 — '기피/불가' 시간이다.
    사장님이 알바를 받을 때 실제로 물어보는 건 "언제 돼요?"이고, 그 답을 그대로 담아야
    달력에서 "이 날 넣을 수 있는 사람"을 바로 뽑을 수 있다. 불가 시간으로 뒤집어
    저장하면(24시간에서 빼기) 원래 답이 무엇이었는지 복원이 안 된다.

    한 직원이 여러 줄을 가진다 (예: 월·수 09~14, 토 13~22).
    요일 번호는 employee_unavailabilities와 같은 규칙(0=월 … 6=일)을 쓴다.
    """

    __tablename__ = "employee_availabilities"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    employee_id: Mapped[int] = mapped_column(
        ForeignKey("employees.id", ondelete="CASCADE"), index=True
    )
    store_id: Mapped[str] = mapped_column(String(100), index=True)
    day_of_week: Mapped[int] = mapped_column(Integer)  # 0=월 … 6=일
    start_hour: Mapped[int] = mapped_column(Integer, default=9)   # 0~23
    end_hour: Mapped[int] = mapped_column(Integer, default=18)    # 1~24
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
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


class FixedCostSetting(Base):
    """매장별 월 고정비 — 손익분기점 계산의 입력값.

    고정비는 '한 잔도 안 팔아도 매달 나가는 돈'이다. 임대료·인건비·공과금처럼 항목을
    나눠 받는 이유는, 합계만 받으면 사장님이 뭘 빠뜨렸는지 알 수 없기 때문이다.
    (실제로 가장 많이 빠뜨리는 게 본인 인건비와 보험료다.)

    변동비율은 평소 판매 데이터에서 자동으로 뽑지만(레시피 원가 + 카드 수수료),
    아직 메뉴 레시피를 안 넣은 매장은 자동 계산이 안 된다. 그때 직접 적은 값을
    custom_variable_ratio에 담아 두고 계산에 우선 적용한다.
    """

    __tablename__ = "fixed_cost_settings"

    store_id: Mapped[str] = mapped_column(String(100), primary_key=True)
    rent: Mapped[int] = mapped_column(Integer, default=0)          # 임대료·관리비
    labor: Mapped[int] = mapped_column(Integer, default=0)         # 고정 인건비 (사장 급여 포함)
    utilities: Mapped[int] = mapped_column(Integer, default=0)     # 전기·가스·수도·통신
    other: Mapped[int] = mapped_column(Integer, default=0)         # 보험·리스·구독료 등
    # 사장님이 직접 적은 변동비율(%) — 비워 두면 판매 데이터에서 자동으로 뽑는다
    custom_variable_ratio: Mapped[float | None] = mapped_column(Numeric(5, 2), nullable=True)
    # 한 달 영업일수 — 일 목표 매출을 내는 데 쓴다 (주 6일 영업이면 26)
    open_days_per_month: Mapped[int] = mapped_column(Integer, default=26)
    memo: Mapped[str | None] = mapped_column(Text, nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class CafeReviewLink(Base):
    """사장님이 '이게 내 카페'라고 지정한 네이버 장소 (매장당 한 곳).

    '내 카페 리뷰'는 매장 상호로 네이버 블로그를 검색하는데, 상호만으로는 이름이 같은
    다른 카페의 후기를 내 것처럼 가져올 위험이 있다. 사장님이 후보 목록에서 자기 가게를
    직접 골라 여기 저장해 두면, 그 이름+주소로만 후기를 찾아 오매칭을 막는다.
    지정 전에는 '내 카페 리뷰'가 후기를 보여주지 않고 '내 카페 연결' 안내만 띄운다.
    """

    __tablename__ = "cafe_review_links"

    store_id: Mapped[str] = mapped_column(String(100), primary_key=True)
    place_name: Mapped[str] = mapped_column(String(150))
    place_address: Mapped[str | None] = mapped_column(String(200), nullable=True)
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


class ChatQuota(Base):
    """챗봇 무료 사용량 — 하루 N턴까지 무료, 광고를 보면 충전된다 (매장별·날짜별 1행)

    date를 PK에 넣은 이유는 자정 초기화를 별도 배치 없이 처리하려는 것이다. 날짜가
    바뀌면 그냥 새 행이 만들어지고 지난 행은 조회되지 않는다. 기준은 KST — 서버가
    어느 타임존에서 돌든 사장님이 체감하는 '오늘'과 어긋나면 안 된다.

    used는 소비한 턴, granted는 광고로 추가 확보한 턴. 남은 턴은
    (무료 기본량 + granted - used)로 계산하므로 어느 값도 음수로 내려가지 않는다.
    """

    __tablename__ = "chat_quotas"

    store_id: Mapped[str] = mapped_column(String(100), primary_key=True, index=True)
    date: Mapped[str] = mapped_column(String(10), primary_key=True)  # KST 기준 YYYY-MM-DD
    used: Mapped[int] = mapped_column(Integer, default=0)
    granted: Mapped[int] = mapped_column(Integer, default=0)
    ads_watched: Mapped[int] = mapped_column(Integer, default=0)  # 하루 광고 상한 판정용
    updated_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=True
    )


class AdRewardGrant(Base):
    """광고 충전 원장 — 챗봇 턴을 충전한 '광고 시청 1건'을 한 줄씩 남긴다

    왜 필요한가: 충전은 chat_quotas.granted를 올리는 것뿐이라, 예전엔 그 증가가
    어디서 왔는지(진짜 광고인지, 앱을 뜯어 엔드포인트를 직접 때린 건지) 남지 않았다.
    AdMob 서버 사이드 검증(SSV) 콜백을 붙이면서 '무엇을 근거로 충전했는가'를
    행으로 남긴다 — 운영자는 source='ssv' 비율을 보고 검증 경로가 실제로 살아 있는지
    확인한 뒤에야 강제 모드(CHAT_AD_SSV_REQUIRED=1)로 올릴 수 있다.

    transaction_id를 PK로 둔 이유가 핵심이다. AdMob이 같은 콜백을 재전송하거나
    누군가 같은 URL을 그대로 다시 때려도 두 번째 INSERT가 PK 충돌로 튕겨,
    한 번의 광고 시청이 두 번 충전되지 않는다 (애플리케이션 조건문은 동시 요청에서 뚫린다).
    """

    __tablename__ = "ad_reward_grants"

    # SSV 경로는 AdMob이 준 거래 id, 클라이언트 보고 경로는 "client:<uuid4>"
    transaction_id: Mapped[str] = mapped_column(String(80), primary_key=True)
    store_id: Mapped[str] = mapped_column(String(100), index=True)
    date: Mapped[str] = mapped_column(String(10))  # KST 기준 YYYY-MM-DD (하루 상한과 같은 기준)
    source: Mapped[str] = mapped_column(String(16))  # ssv | client
    turns: Mapped[int] = mapped_column(Integer, default=0)  # 이 건으로 충전한 턴 수
    created_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=True
    )


class PointLedger(Base):
    """포인트 원장 — 적립·사용을 한 줄씩 남긴다 (게임화 보상)

    잔액을 별도 컬럼으로 들고 있지 않고 delta의 합으로 계산한다. 잔액 컬럼과 내역이
    어긋나는 사고(중복 적립·롤백 누락)가 이 규모에선 훨씬 비싸다. 상점 화면이
    요구하는 '적립 내역'도 이 표가 그대로 답이 된다.

    중복 적립 방지는 (store_id, reason, ref)의 유니크 제약으로 한다. 할 일 완료를
    껐다 켰다 반복해 포인트를 무한 획득하는 걸 DB 차원에서 막는다 — 애플리케이션
    조건문만으로는 동시 요청에서 뚫린다.
    """

    __tablename__ = "point_ledgers"
    __table_args__ = (
        UniqueConstraint("store_id", "reason", "ref", name="uq_point_ledger_source"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    store_id: Mapped[str] = mapped_column(String(100), index=True)
    delta: Mapped[int] = mapped_column(Integer)  # 적립은 양수, 사용은 음수
    reason: Mapped[str] = mapped_column(String(32))  # todo_done | purchase | ...
    # 적립 출처 식별자. 같은 reason 안에서 유일해야 하는 값 (예: 할 일 id).
    # 상점 구매처럼 여러 번 일어나도 되는 건 매번 다른 값을 넣는다.
    ref: Mapped[str] = mapped_column(String(64))
    memo: Mapped[str] = mapped_column(String(200), default="")  # 내역 화면에 그대로 보여줄 문구
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class OwnedItem(Base):
    """구매한 꾸미기 아이템 — 매장(사장님)별 보유 목록

    아이템 카탈로그 자체는 코드 상수(reward_service.SHOP_ITEMS)로 둔다. 종류가 적고
    가격·이름을 바꾸는 데 마이그레이션까지 필요할 이유가 없다.
    equipped는 부위(slot)당 하나만 true — 서비스 레이어가 보장한다.
    """

    __tablename__ = "owned_items"
    __table_args__ = (
        UniqueConstraint("store_id", "item_id", name="uq_owned_item"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    store_id: Mapped[str] = mapped_column(String(100), index=True)
    item_id: Mapped[str] = mapped_column(String(40))
    equipped: Mapped[bool] = mapped_column(Boolean, default=False)
    acquired_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


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
    # 직원 계정으로 로그인한 기기면 그 직원(staff_accounts.id). 사장님 기기는 NULL.
    # '특정 알바에게 지정한 업무' 푸시를 그 직원 기기로만 보내는 데 쓴다.
    # 같은 기기에서 사장님으로 다시 로그인하면 재등록 때 NULL로 덮인다 (기기 주인 추종).
    staff_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
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
    # 주변 소식(행사 D-day·경쟁 카페 개업/폐업) — 상권 변화라 재고·서류와 성격이 달라 따로 끈다
    nearby_alert: Mapped[bool] = mapped_column(Boolean, default=True)
    # 선제 인사이트(정산 미입력·뜸해진 단골·POS 연동 끊김·메뉴 원가…)와 아침 브리핑.
    # 앱 설정의 '놓친 일 먼저 알려주기' 스위치가 이 값을 함께 움직인다.
    insight_alert: Mapped[bool] = mapped_column(Boolean, default=True)
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
    category: Mapped[str] = mapped_column(String(32), index=True)  # compliance | report | stock | sensor | nearby
    title: Mapped[str] = mapped_column(String(200))
    body: Mapped[str] = mapped_column(Text, default="")
    sent_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), index=True)


# 나중에 추가된 알림 종류 스위치들 — 기존 테이블에 없으면 여기서 붙인다.
# 전부 '켜짐'으로 채운다: 새 기능은 켜진 채로 시작하고 사장님이 끄면 그때 꺼진다.
_NOTIFICATION_LATE_COLUMNS = ("nearby_alert", "insight_alert")


def ensure_notification_setting_columns(engine) -> None:
    """[자가치유 스키마] notification_settings에 뒤늦게 생긴 컬럼을 멱등하게 추가한다.

    이 테이블은 nearby_alert·insight_alert 없이 먼저 만들어졌고 create_all은 기존 테이블을
    ALTER하지 않는다 — 컬럼이 빠진 채로 두면 설정 조회가 통째로 500이 난다
    ([[create-all-no-alter-trap]]).
    """
    try:
        insp = inspect(engine)
        if not insp.has_table("notification_settings"):
            return  # 테이블 자체가 없으면 create_all이 스키마째로 만든다
        existing = {c["name"] for c in insp.get_columns("notification_settings")}
    except Exception as e:
        logger.warning(f"[알림 스키마] notification_settings 점검 실패 — 건너뜁니다: {e}")
        return

    for column in _NOTIFICATION_LATE_COLUMNS:
        if column in existing:
            continue
        try:
            with engine.begin() as conn:
                conn.execute(text(
                    f"ALTER TABLE notification_settings ADD COLUMN {column} BOOLEAN NOT NULL DEFAULT TRUE"
                ))
            logger.info("[알림 스키마] notification_settings.%s 컬럼 추가 완료", column)
        except Exception as e:
            logger.warning(f"[알림 스키마] {column} 보강 실패 — 알림 설정 조회가 막힐 수 있습니다: {e}")


def ensure_device_token_staff_column(engine) -> None:
    """[자가치유 스키마] device_tokens에 staff_id(직원 기기 구분)를 멱등하게 추가한다.

    '특정 알바에게 지정한 업무' 푸시를 그 직원 기기로만 보내려면 토큰이 누구
    로그인인지 알아야 한다. 기존 행은 NULL(사장님 기기 취급)로 남고, 직원이
    다음에 앱을 열면 재등록(upsert) 때 채워진다 ([[create-all-no-alter-trap]]).
    """
    try:
        insp = inspect(engine)
        if not insp.has_table("device_tokens"):
            return  # 테이블 자체가 없으면 create_all이 스키마째로 만든다
        existing = {c["name"] for c in insp.get_columns("device_tokens")}
    except Exception as e:
        logger.warning(f"[알림 스키마] device_tokens 점검 실패 — 건너뜁니다: {e}")
        return
    if "staff_id" in existing:
        return
    try:
        with engine.begin() as conn:
            conn.execute(text("ALTER TABLE device_tokens ADD COLUMN staff_id INTEGER"))
            conn.execute(text("CREATE INDEX IF NOT EXISTS ix_device_tokens_staff_id "
                              "ON device_tokens (staff_id)"))
        logger.info("[알림 스키마] device_tokens.staff_id 컬럼 추가 완료")
    except Exception as e:
        logger.warning(f"[알림 스키마] staff_id 보강 실패 — 직원 지정 푸시가 막힐 수 있습니다: {e}")


class NearbyCafeWatch(Base):
    """주변 경쟁 카페 관측 대장 — '어제 있던 카페'를 기억해 개업·폐업을 알아낸다.

    네이버 지역검색은 '지금 존재하는 카페'만 알려줄 뿐, 새로 생겼는지 없어졌는지는
    말해 주지 않는다. 그래서 매일 한 번 스캔한 결과를 여기 쌓아 두고 어제와 비교한다.
      · 처음 본 가게        → seen_count 1 → 다음 스캔에도 보이면(2) '신규 개업'으로 알린다
      · 안 보이기 시작한 집 → miss_count 누적 → 연속 3회 사라지면 '폐업 추정'으로 알린다

    한 번 만에 판정하지 않는 이유: 지역검색은 키워드당 상위 5건만 주고 429(초당 제한)도
    섞여서, 멀쩡한 가게가 하루 결과에서 빠지거나 처음 보이는 일이 흔하다. 두 번 연속
    확인해야 '진짜 변화'로 본다.
    """

    __tablename__ = "nearby_cafe_watch"
    __table_args__ = (UniqueConstraint("store_id", "place_key", name="uq_nearby_cafe_watch"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    store_id: Mapped[str] = mapped_column(String(100), index=True)
    # 상호+주소를 공백 제거·소문자로 정규화한 값 — 같은 가게가 표기 차이로 두 줄이 되지 않게
    place_key: Mapped[str] = mapped_column(String(200))
    name: Mapped[str] = mapped_column(String(150))
    address: Mapped[str] = mapped_column(String(200), default="")
    category: Mapped[str] = mapped_column(String(100), default="")
    lat: Mapped[float | None] = mapped_column(Float, nullable=True)
    lon: Mapped[float | None] = mapped_column(Float, nullable=True)
    distance_m: Mapped[int] = mapped_column(Integer, default=0)
    status: Mapped[str] = mapped_column(String(8), default="open", index=True)  # open | closed
    seen_count: Mapped[int] = mapped_column(Integer, default=1)   # 며칠 관측됐는지 (신규 확정 근거)
    miss_count: Mapped[int] = mapped_column(Integer, default=0)   # 연속으로 안 보인 스캔 횟수
    first_seen: Mapped[str] = mapped_column(String(10), default="")   # YYYY-MM-DD
    last_seen: Mapped[str] = mapped_column(String(10), default="", index=True)
    closed_on: Mapped[str | None] = mapped_column(String(10), nullable=True)
    # 첫 스캔에 잡힌 '원래 있던 가게'. 이 표시가 없으면 관측을 시작한 날 반경 안의 카페
    # 전부가 '신규 개업'으로 화면에 뜬다 (알림은 open_notified가 막지만 화면은 못 막는다).
    is_baseline: Mapped[bool] = mapped_column(Boolean, default=False)
    # 알림 발송 여부는 여기에 둔다 — sent_notifications는 90일 뒤 정리되므로
    # 그쪽에만 의존하면 오래된 가게가 언젠가 '신규 개업'으로 다시 나갈 수 있다.
    open_notified: Mapped[bool] = mapped_column(Boolean, default=False)
    close_notified: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


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


# ---------------------------------------------------------------------------
# POS 실시간 연동 — 매장별 POS 계정 연결과 동기화된 주문 대장
# ---------------------------------------------------------------------------


class PosConnection(Base):
    """매장별 POS(현재 Square) 연결 정보.

    토큰을 전역 env가 아니라 매장 단위로 DB에 두는 이유: 매장마다 자기 POS 계정을
    연결해야 하는 멀티테넌트 구조라서다. 토큰·웹훅 서명키는 SECRET_KEY 유도 키로
    암호화(Fernet)해 저장하고, API 응답에는 마스킹된 형태만 내보낸다.
    """

    __tablename__ = "pos_connections"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    store_id: Mapped[str] = mapped_column(String(100), unique=True, index=True)
    provider: Mapped[str] = mapped_column(String(20), default="square")
    environment: Mapped[str] = mapped_column(String(20), default="production")  # production | sandbox
    access_token_enc: Mapped[str] = mapped_column(Text)
    # 웹훅 서명 검증용 — Square 대시보드의 Webhook Signature Key (없으면 웹훅 비활성)
    webhook_signature_key_enc: Mapped[str | None] = mapped_column(Text, nullable=True)
    # 웹훅 수신 주소 — Square 서명은 '구독에 등록한 URL + 본문'을 서명하므로 그대로 보관해 검증에 쓴다
    webhook_url: Mapped[str | None] = mapped_column(String(300), nullable=True)
    # 웹훅 이벤트(merchant_id)를 어느 매장으로 보낼지 찾는 열쇠 — 연결 저장 시 Square에서 조회해 채운다
    merchant_id: Mapped[str | None] = mapped_column(String(64), index=True, nullable=True)
    auto_sync: Mapped[bool] = mapped_column(Boolean, default=True)
    last_synced_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_status: Mapped[str | None] = mapped_column(String(20), nullable=True)  # ok | error
    last_error: Mapped[str | None] = mapped_column(String(300), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class PosSyncedOrder(Base):
    """이미 매출로 반영한 POS 주문 대장 — 웹훅과 폴링이 같은 주문을 두 번 넣지 않게 한다."""

    __tablename__ = "pos_synced_orders"
    __table_args__ = (UniqueConstraint("store_id", "provider", "order_id", name="uq_pos_order"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    store_id: Mapped[str] = mapped_column(String(100), index=True)
    provider: Mapped[str] = mapped_column(String(20), default="square")
    order_id: Mapped[str] = mapped_column(String(100))
    synced_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class AiWarmCache(Base):
    """무거운 계산 결과를 DB에 남겨 두는 자리 — 서버 인스턴스가 바뀌어도 살아남는 캐시.

    인사이트 스캔과 판매 예측은 매장 데이터를 통째로 훑어 만든다. 각각 파이썬 프로세스
    메모리에 캐시를 두고 있었지만, Cloud Run은 트래픽이 없으면 인스턴스를 내려버린다.
    그래서 사장님이 아침에 앱을 처음 켤 때는 항상 캐시가 빈 인스턴스에 걸렸고,
    인사이트 7.1초 · 예측 7.0초를 그대로 기다려야 했다(2026-08-05 실측).

    여기에 한 벌 더 써 두면 새 인스턴스도 쿼리 한 번(≈0.2초)으로 지난 결과를 집어
    바로 응답하고, 진짜 계산은 백그라운드에서 돌려 다음 조회부터 최신이 된다.

    지워도 기능은 멀쩡하다 — 다시 계산할 뿐이다. 그래서 어떤 오류도 조용히 넘긴다.
    """

    __tablename__ = "ai_warm_cache"

    # 예: "insights:s@gmail.com:2026-08-05", "forecast:s@gmail.com:37.566:126.978:7"
    key: Mapped[str] = mapped_column(String(200), primary_key=True)
    payload: Mapped[str] = mapped_column(Text)  # JSON 문자열
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), index=True
    )


# ---------------------------------------------------------------------------
# 챗봇 사고 후보 — 운영 대화에서 자동으로 잡아 둔 오답
# ---------------------------------------------------------------------------


class ChatIncident(Base):
    """감시 규칙이나 사장님의 부정 반응으로 걸러진 '답이 틀린 것 같은 턴'.

    골든 회귀 테스트(evals/)는 적어 둔 질문만 지킨다. 그런데 사고가 났을 때 사람이 그
    질문을 파일에 추가해 줄 거라는 전제는 현실적이지 않다 — 그 결과 세트는 처음 만든
    문항에서 자라지 않고, 새로 생긴 오답은 계속 새로 겪게 된다.

    그래서 answer_audit이 운영 대화 매 턴을 훑어 여기 쌓고, evals/harvest.py가 재현
    검증을 거쳐 골든 세트에 자동 등록한다. status가 그 진행 상태다:
      pending    — 잡혔지만 아직 재현해 보지 않음
      confirmed  — 다시 물어봐도 재현됨 (진짜 버그)
      registered — 골든 세트에 등록 완료
      rejected   — 재현되지 않음 (일시적 잡음 — 분당 한도·외부 API 실패 등)

    같은 매장의 같은 질문·같은 규칙이면 행을 늘리지 않고 hits만 올린다. 한 사장님이
    같은 질문을 열 번 해서 문항이 열 개 생기면 세트가 금세 못 쓰게 된다.
    """

    __tablename__ = "chat_incidents"
    __table_args__ = (
        UniqueConstraint("store_id", "norm_key", "rule", name="uq_chat_incident"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    store_id: Mapped[str] = mapped_column(String(100), index=True)
    question: Mapped[str] = mapped_column(String(300))
    # 중복 판정용 정규화 키 (공백·문장부호 제거)
    norm_key: Mapped[str] = mapped_column(String(300), index=True)
    rule: Mapped[str] = mapped_column(String(40), index=True)
    detail: Mapped[str | None] = mapped_column(String(300), nullable=True)
    # 원인 분석용 답변 일부 — 전문을 남기지 않는 건 이 표가 대화 로그가 되면 안 되기 때문
    answer_excerpt: Mapped[str | None] = mapped_column(String(500), nullable=True)
    tools: Mapped[str | None] = mapped_column(String(300), nullable=True)
    experts: Mapped[str | None] = mapped_column(String(200), nullable=True)
    status: Mapped[str] = mapped_column(String(16), default="pending", index=True)
    hits: Mapped[int] = mapped_column(Integer, default=1)
    first_seen: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    last_seen: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
