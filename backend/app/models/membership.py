"""단골 회원 · 선불 충전 모델 (백엔드 B)

[한글 주석] 설계에서 지킨 원칙 두 가지:

1. 잔액은 '숫자 하나'가 아니라 거래 이력의 합계다.
   손님 돈이라 "5만원 넣었는데 왜 3만원이죠?"에 답할 수 있어야 한다.
   모든 변동을 BalanceTransaction에 한 줄씩 남기고 변동 후 잔액도 함께 적는다.
   Customer.balance는 매번 합계를 내지 않기 위한 캐시일 뿐이며,
   이력과 어긋나면 이력이 옳다.

2. 충전액은 매출이 아니라 선수금(부채)이다.
   5만원 충전은 아직 커피를 안 줬으므로 빚이고, 커피가 나갈 때 비로소 매출이 된다.
   섞어 세면 사장님이 그날 매출이 뛴 걸로 착각하고 세금 신고도 틀어진다.
   그래서 충전(CHARGE)과 사용(USE)을 다른 종류로 남긴다.
"""
import logging
import secrets

from sqlalchemy import (
    Boolean, Column, DateTime, ForeignKey, Integer, String, Text,
    UniqueConstraint, func, inspect, text,
)
from sqlalchemy.orm import relationship

from app.core.database import Base

logger = logging.getLogger(__name__)


def generate_access_token() -> str:
    """손님 잔액 조회 링크에 쓰는 추측 불가능한 토큰.

    [한글 주석] 전화번호로 조회하게 두면 남의 번호를 아는 사람이 남의 잔액을 본다.
    앱 설치나 로그인 없이 링크만으로 열되, 토큰은 추측할 수 없어야 한다.
    """
    return secrets.token_urlsafe(12)


class Customer(Base):
    """단골 회원 — 매장별로 관리한다."""
    __tablename__ = "customers"
    __table_args__ = (
        # 같은 매장에 같은 번호가 두 번 등록되면 적립이 갈라진다
        UniqueConstraint("store_id", "phone", name="uq_customer_store_phone"),
    )

    id = Column(Integer, primary_key=True, index=True)
    store_id = Column(String(100), nullable=False, index=True)
    phone = Column(String(20), nullable=False)          # 010-1234-5678
    name = Column(String(50), nullable=True)            # 없으면 번호 뒷자리로 부른다

    # 잔액 캐시 — 진실은 balance_transactions다
    balance = Column(Integer, default=0, nullable=False)

    # 손님용 조회 링크 토큰
    access_token = Column(String(32), unique=True, index=True,
                          default=generate_access_token, nullable=False)

    memo = Column(Text, nullable=True)                  # 사장님 메모 ("아메리카노 연하게")
    is_active = Column(Boolean, default=True, nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)

    # [한글 주석] 동의를 누가 했는지 남긴다.
    #   SELF  — 손님이 QR을 찍어 직접 번호를 넣고 동의 체크
    #   OWNER — 사장님이 대신 입력하고 "동의를 받았다"고 체크
    #
    #   둘의 무게가 다르다. 사장님 체크는 사장님의 진술이지 손님의 동의가 아니다.
    #   나중에 "동의를 받았느냐"는 질문이 나오면 SELF만이 실제 근거가 된다.
    consent_source = Column(String(10), nullable=True)
    consent_at = Column(DateTime(timezone=True), nullable=True)

    transactions = relationship(
        "BalanceTransaction", back_populates="customer",
        cascade="all, delete-orphan",
        order_by="desc(BalanceTransaction.created_at)",
    )


class ChargePlan(Base):
    """충전 상품 — 사장님이 직접 설계한다.

    [한글 주석] 손님이 아무 금액이나 넣게 두면 할인율이 제각각이 되어
    원가 계산도 못 하고 사장님도 매번 암산해야 한다.
    "5만원 결제 → 6만원 적립" 같은 상품을 미리 정의해 두게 했다.
    """
    __tablename__ = "charge_plans"

    id = Column(Integer, primary_key=True, index=True)
    store_id = Column(String(100), nullable=False, index=True)
    pay_amount = Column(Integer, nullable=False)        # 손님이 내는 돈
    credit_amount = Column(Integer, nullable=False)     # 잔액으로 꽂히는 금액
    is_active = Column(Boolean, default=True, nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)

    @property
    def bonus_amount(self) -> int:
        return max(0, self.credit_amount - self.pay_amount)

    @property
    def discount_rate(self) -> float:
        """손님이 체감하는 할인율(%). 적립액 기준이다.

        6만원어치를 5만원에 샀으므로 (60000-50000)/60000 = 16.7%.
        결제액 기준(20%)으로 쓰면 실제보다 크게 보인다.
        """
        if not self.credit_amount:
            return 0.0
        return round((self.credit_amount - self.pay_amount) / self.credit_amount * 100, 1)


# 거래 종류
TX_CHARGE = "CHARGE"    # 충전 (선수금 증가, 매출 아님)
TX_USE = "USE"          # 사용 (매출 인식)
TX_REFUND = "REFUND"    # 환불
TX_ADJUST = "ADJUST"    # 사장님 수동 보정


class BalanceTransaction(Base):
    """잔액 변동 원장 — 이게 진실이고 Customer.balance는 캐시다."""
    __tablename__ = "balance_transactions"

    id = Column(Integer, primary_key=True, index=True)
    customer_id = Column(Integer, ForeignKey("customers.id", ondelete="CASCADE"),
                         nullable=False, index=True)
    store_id = Column(String(100), nullable=False, index=True)

    tx_type = Column(String(10), nullable=False)        # CHARGE / USE / REFUND / ADJUST
    amount = Column(Integer, nullable=False)            # 충전 +, 사용 -
    balance_after = Column(Integer, nullable=False)     # 이 거래 직후 잔액 (감사 추적용)

    # 충전이면 어떤 상품으로 샀는지, 실제로 낸 돈은 얼마인지
    charge_plan_id = Column(Integer, ForeignKey("charge_plans.id", ondelete="SET NULL"),
                            nullable=True)
    paid_amount = Column(Integer, nullable=True)        # 충전 시 실제 결제액 (선수금 계산용)

    # [한글 주석] 어떤 메뉴로 차감했는지. 메모(이름 문자열)만 있으면
    # 원가 분석 때 이름으로 메뉴를 되찾아야 하는데, 이름이 바뀌거나
    # 비슷한 메뉴가 있으면 어긋난다. 실제 원가는 레시피에서 나오므로 ID가 필요하다.
    menu_id = Column(Integer, ForeignKey("menus.id", ondelete="SET NULL"), nullable=True)

    memo = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now(),
                        nullable=False, index=True)

    customer = relationship("Customer", back_populates="transactions")


class StaffAccount(Base):
    """직원 로그인 계정.

    [한글 주석] 왜 Employee에 비밀번호를 붙이지 않고 별도 표로 두는가:

      Employee는 인사 정보(시급·고용형태·보험)를 담는 표다.
      거기에 인증 정보를 섞으면 급여 화면을 만들다 비밀번호 해시를 실수로
      내보내기 쉽다. 인증은 인증대로 분리해 두는 편이 안전하다.

      또 모든 직원이 로그인해야 하는 것도 아니다. 계산대에 서는 사람만
      계정을 만들면 되고, 계정 없는 직원은 그냥 인사 기록으로만 존재한다.

    [중요] 이 계정으로 발급하는 토큰은 sub에 '매장 이메일'을 담는다.
    직원 이메일을 담으면 기존 152군데의 store_id 계산이 전부 어긋난다
    (그 코드들은 current_user.email을 매장 식별자로 쓴다).
    매장은 사장님 이메일 그대로 두고, '누가 조작했는지'만 따로 실어 보낸다.
    """
    __tablename__ = "staff_accounts"

    id = Column(Integer, primary_key=True, index=True)
    store_id = Column(String(100), nullable=False, index=True)   # 소속 매장(사장님 이메일)
    employee_id = Column(Integer, nullable=True)                 # employees.id (선택)
    login_id = Column(String(50), unique=True, index=True, nullable=False)
    hashed_password = Column(String(255), nullable=False)
    name = Column(String(50), nullable=False)
    is_active = Column(Boolean, default=True, nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    last_login_at = Column(DateTime(timezone=True), nullable=True)


class StoreQr(Base):
    """매장별 계산대 QR 토큰.

    [한글 주석] store_id(사장님 이메일)를 QR에 그대로 넣을 수는 없다.
    QR을 찍은 사람에게 매장 계정 이메일이 노출되고, 남의 매장 주소도
    쉽게 만들어낼 수 있게 된다. 추측 불가능한 토큰을 따로 둔다.

    토큰을 새로 발급하면 이전 QR 인쇄물은 즉시 무효가 된다 —
    QR이 유출됐을 때 되돌릴 방법이 있어야 하기 때문이다.
    """
    __tablename__ = "store_qrs"

    store_id = Column(String(100), primary_key=True)
    token = Column(String(32), unique=True, index=True,
                   default=generate_access_token, nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)


# 체크인 종류
#   PAYMENT — 이미 회원인 손님이 "잔액으로 결제해 주세요"
#   SIGNUP  — 처음 온 손님이 QR로 직접 등록한 뒤 "충전해 주세요"
# [한글 주석] 사장님 화면에서 둘을 구분해야 한다.
# 결제 요청은 메뉴를 눌러 차감하면 되지만, 신규 등록은 충전부터 해야 한다.
CHECKIN_PAYMENT = "PAYMENT"
CHECKIN_SIGNUP = "SIGNUP"

# 체크인 상태
CHECKIN_WAITING = "WAITING"   # 손님이 요청함, 사장님이 아직 처리 안 함
CHECKIN_DONE = "DONE"         # 결제 처리됨
CHECKIN_CANCELED = "CANCELED"  # 취소/만료


class CheckIn(Base):
    """손님이 계산대 QR을 찍고 누른 '결제 요청'.

    [한글 주석] 왜 이게 필요한가:

      선불 잔액으로 결제하려면 직원이 '누구인지'를 알아야 하는데,
      구두로 이름이나 번호를 묻는 건 느리고 손님도 번거롭다.
      그렇다고 사장님 앱에 카메라를 넣으면 네이티브 재빌드가 필요하다.

      방향을 뒤집었다. 매장에 QR을 붙여두고 손님이 자기 폰의 기본 카메라로 찍는다.
      우리 앱에는 카메라가 필요 없고, 손님은 QR만 찍으면 된다.
      손님이 '결제 요청'을 누르면 여기에 한 줄 쌓이고,
      사장님 화면 맨 위에 떠서 탭 한 번으로 처리된다.
    """
    __tablename__ = "checkins"

    id = Column(Integer, primary_key=True, index=True)
    store_id = Column(String(100), nullable=False, index=True)
    customer_id = Column(Integer, ForeignKey("customers.id", ondelete="CASCADE"),
                         nullable=False, index=True)
    status = Column(String(10), default=CHECKIN_WAITING, nullable=False, index=True)
    kind = Column(String(10), default=CHECKIN_PAYMENT, nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now(),
                        nullable=False, index=True)
    resolved_at = Column(DateTime(timezone=True), nullable=True)

    customer = relationship("Customer")


def _ensure_transaction_menu_column(engine) -> None:
    """[자가치유 스키마] balance_transactions에 menu_id를 보강한다.

    [한글 주석] 이 컬럼이 생기기 전에 쌓인 거래는 menu_id가 비어 있다.
    메모(메뉴명)로 되채우지 않는다 — 이름이 겹치거나 바뀐 경우
    엉뚱한 메뉴의 원가가 붙어 분석이 조용히 틀어지기 때문이다.
    비어 있는 건 '알 수 없음'으로 두고 집계에서 제외하는 편이 정직하다.
    """
    try:
        insp = inspect(engine)
        if not insp.has_table("balance_transactions"):
            return
        existing = {c["name"] for c in insp.get_columns("balance_transactions")}
    except Exception as e:
        logger.warning(f"[단골 스키마] balance_transactions 점검 실패: {e}")
        return
    if "menu_id" in existing:
        return
    try:
        with engine.begin() as conn:
            conn.execute(text("ALTER TABLE balance_transactions ADD COLUMN menu_id INTEGER"))
        logger.info("[단골 스키마] balance_transactions.menu_id 추가 완료")
    except Exception as e:
        logger.warning(f"[단골 스키마] menu_id 보강 실패: {e}")


def ensure_membership_extra_columns(engine) -> None:
    """[자가치유 스키마] 나중에 추가된 컬럼들을 보강한다.

    [한글 주석] create_all은 기존 테이블을 ALTER하지 않는다.
    이 컬럼들이 없으면 QR 셀프 등록과 동의 기록이 통째로 죽는다.
    """
    targets = [
        ("customers", "consent_source", "VARCHAR(10)"),
        ("customers", "consent_at", "TIMESTAMP WITH TIME ZONE"),
        ("checkins", "kind", "VARCHAR(10)"),
    ]
    try:
        insp = inspect(engine)
    except Exception as e:
        logger.warning(f"[단골 스키마] 점검 실패: {e}")
        return

    for table, col, coltype in targets:
        try:
            if not insp.has_table(table):
                continue
            if col in {c["name"] for c in insp.get_columns(table)}:
                continue
            with engine.begin() as conn:
                conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {col} {coltype}"))
                if table == "checkins" and col == "kind":
                    # 기존 체크인은 전부 결제 요청이었다
                    conn.execute(text("UPDATE checkins SET kind = 'PAYMENT' WHERE kind IS NULL"))
            logger.info("[단골 스키마] %s.%s 추가 완료", table, col)
        except Exception as e:
            logger.warning(f"[단골 스키마] {table}.{col} 보강 실패: {e}")


def ensure_sale_customer_columns(engine) -> None:
    """[자가치유 스키마] sales 테이블에 고객·결제수단 컬럼을 보강한다.

    [한글 주석] 매출을 손님에게 연결해야 재방문 주기를 계산할 수 있다.
    create_all은 기존 테이블을 ALTER하지 않으므로 배포 시 무중단으로 보강한다.

    payment_method를 함께 두는 이유: 선불 잔액으로 결제한 건(CREDIT)은
    그 시점에 돈이 새로 들어온 게 아니라 예전에 받아둔 선수금이 매출로 바뀌는 것이다.
    현금·카드와 섞어 세면 그날 실제 입금액이 부풀어 보인다.

    ※ sales는 백엔드 A 담당 테이블이다. 이 보강은 팀에 공유할 것.
    """
    try:
        insp = inspect(engine)
        if not insp.has_table("sales"):
            return
        existing = {c["name"] for c in insp.get_columns("sales")}
    except Exception as e:
        logger.warning(f"[단골 스키마] sales 점검 실패 — 건너뜁니다: {e}")
        return

    to_add = [
        (col, coltype)
        for col, coltype in (("customer_id", "INTEGER"), ("payment_method", "VARCHAR(10)"))
        if col not in existing
    ]
    _ensure_transaction_menu_column(engine)
    if not to_add:
        return

    try:
        with engine.begin() as conn:
            for col, coltype in to_add:
                conn.execute(text(f"ALTER TABLE sales ADD COLUMN {col} {coltype}"))
            if any(c == "payment_method" for c, _ in to_add):
                # 기존 매출은 결제수단을 모른다. 선불(CREDIT)이 아닌 것만은 확실하므로
                # UNKNOWN으로 채워 '선불 사용액' 집계가 과대계상되지 않게 한다.
                conn.execute(text(
                    "UPDATE sales SET payment_method = 'UNKNOWN' WHERE payment_method IS NULL"))
        logger.info("[단골 스키마] sales에 %s 추가 완료", ", ".join(c for c, _ in to_add))
    except Exception as e:
        logger.warning(f"[단골 스키마] sales 컬럼 보강 실패: {e}")
