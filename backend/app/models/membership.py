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

    memo = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now(),
                        nullable=False, index=True)

    customer = relationship("Customer", back_populates="transactions")


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
