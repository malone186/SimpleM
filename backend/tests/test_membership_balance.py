# c:\Users\USER\Documents\본 프로젝트\SimpleM\backend\tests\test_membership_balance.py
"""
[한글 주석] 선불 잔액이 절대 어긋나면 안 되는 규칙들을 고정한다.

손님 돈을 다루는 코드라, 여기가 회귀하면 에러가 아니라
"잔액이 마이너스가 됐다", "환불이 매출로 잡혔다" 같은 형태로 조용히 나타난다.
그래서 규칙마다 테스트를 하나씩 걸어 둔다.

특히 _lock_customer는 눈에 안 띄는 한 줄이라 리팩터링 때 지워지기 쉽다.
지워지면 동시 결제에서 잔액이 마이너스가 되므로 재조회 동작을 직접 검증한다.
"""
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core.database import Base
from app.models.membership import (
    TX_CHARGE, TX_REFUND, TX_USE, BalanceTransaction, ChargePlan, Customer,
)
from app.services import membership_service as svc

engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
TestingSession = sessionmaker(autocommit=False, autoflush=False, bind=engine)
STORE = "test@cafe.com"


@pytest.fixture()
def db():
    Base.metadata.create_all(bind=engine)
    session = TestingSession()
    try:
        yield session
    finally:
        session.close()
        Base.metadata.drop_all(bind=engine)


def _customer(db, balance: int = 0, phone: str = "01012345678") -> Customer:
    c, _ = svc.create_customer(db, STORE, phone, "테스트손님")
    if balance:
        svc.charge(db, c, pay_amount=balance, credit_amount=balance)
        db.refresh(c)
    return c


# --- 전화번호 ---

def test_같은_번호는_형태가_달라도_한_사람으로_본다(db):
    """입력 형태가 제각각이면 같은 손님이 두 번 등록돼 적립이 갈라진다."""
    forms = ["01012345678", "010-1234-5678", "010 1234 5678", "+82 10-1234-5678"]
    assert {svc.normalize_phone(f) for f in forms} == {"010-1234-5678"}
    assert svc.normalize_phone("12345") is None


def test_같은_번호로_다시_등록하면_기존_회원을_돌려준다(db):
    a, _ = svc.create_customer(db, STORE, "01012345678", "김손님")
    b, _ = svc.create_customer(db, STORE, "010-1234-5678", "김손님둘")
    assert a.id == b.id


# --- 차감 ---

def test_잔액보다_많이_차감할_수_없다(db):
    c = _customer(db, 5000)
    tx, msg = svc.use(db, c, 9000)
    db.refresh(c)
    assert tx is None
    assert c.balance == 5000
    assert "부족" in msg


def test_오래된_객체로_차감해도_현재_잔액을_다시_읽는다(db):
    """[핵심] 동시 결제로 잔액이 마이너스가 되는 걸 막는 장치.

    _lock_customer가 차감 직전에 회원 행을 다시 읽기 때문에,
    손에 든 객체가 옛 잔액을 갖고 있어도 통과하지 않는다.
    이 재조회가 사라지면 계산대 두 곳에서 동시에 결제할 때
    둘 다 옛 잔액을 보고 통과해 마이너스가 된다.
    """
    c = _customer(db, 5000)

    # 다른 곳에서 먼저 4,000원이 빠졌다
    svc.use(db, c, 4000, "먼저 결제")
    db.refresh(c)
    assert c.balance == 1000

    # 손에 든 객체가 옛 잔액(5,000)을 들고 있는 상황을 만든다
    c.balance = 5000

    tx, msg = svc.use(db, c, 4000, "동시 결제")
    assert tx is None, "옛 잔액을 그대로 믿고 통과하면 안 된다"
    assert "부족" in msg

    db.refresh(c)
    assert c.balance == 1000
    assert c.balance >= 0


def test_보정으로도_음수가_될_수_없다(db):
    c = _customer(db, 3000)
    tx, _ = svc.adjust(db, c, -9000, "실수 정정")
    db.refresh(c)
    assert tx is None
    assert c.balance == 3000


def test_보정은_사유가_기록에_남는다(db):
    c = _customer(db, 3000)
    tx, _ = svc.adjust(db, c, -1000, "이중 차감 정정")
    assert tx is not None
    assert tx.memo == "이중 차감 정정"


# --- 원장 ---

def test_모든_변동이_이력에_남고_잔액과_맞는다(db):
    c = _customer(db, 10000)
    svc.use(db, c, 3000, "아메리카노")
    svc.use(db, c, 2000, "샷추가")
    svc.adjust(db, c, 500, "서비스")

    result = svc.reconcile_balance(db, STORE)
    assert result["ok"], result["mismatches"]

    db.refresh(c)
    assert c.balance == 5500

    txs = svc.list_transactions(db, c.id)
    assert len(txs) == 4  # 충전 1 + 사용 2 + 보정 1
    # 변동 후 잔액이 함께 적혀 있어야 나중에 어긋난 지점을 찾을 수 있다
    assert txs[0].balance_after == 5500


def test_캐시된_잔액이_이력과_어긋나면_잡아낸다(db):
    c = _customer(db, 10000)
    svc.use(db, c, 3000)

    c.balance = 99999  # 버그로 캐시가 틀어진 상황
    db.commit()

    result = svc.reconcile_balance(db, STORE)
    assert not result["ok"]
    assert result["mismatch_count"] == 1
    assert result["mismatches"][0]["ledger_balance"] == 7000


# --- 환불 ---

def test_환불은_사용과_다른_종류로_남는다(db):
    """환불은 매출이 아니라 받아둔 돈을 돌려주는 것이라 섞이면 안 된다."""
    c = _customer(db, 10000)
    tx, _ = svc.refund(db, c, 4000, "고객 요청")
    assert tx is not None
    assert tx.tx_type == TX_REFUND
    db.refresh(c)
    assert c.balance == 6000
    # 보너스 없이 충전했으므로 잔액 차감액과 현금이 같다
    assert tx.paid_amount == 4000


def test_잔액보다_많이_환불할_수_없다(db):
    c = _customer(db, 3000)
    tx, _ = svc.refund(db, c, 5000)
    db.refresh(c)
    assert tx is None
    assert c.balance == 3000


def test_나눠서_환불해도_받은_돈보다_많이_나가지_않는다(db):
    """[핵심] 분할 환불에서 실제로 돈이 새던 버그.

    잔액에서 빼는 금액과 건네는 현금을 같은 값으로 쓰면
    보너스가 계속 남아 다음 계산에서 또 환불 대상이 된다.

        50,000원 받고 60,000원 적립한 손님에게
          1차 30,000 환불(잔액 30,000 남음) → 2차 25,000 → 3차 4,166 …
          총 59,166원. 9,166원 손해.

    잔액은 요청한 만큼 빼고, 현금은 거기에 (낸 돈/적립액)을 곱해 건넨다.
    """
    plan = ChargePlan(store_id=STORE, pay_amount=50000, credit_amount=60000)
    db.add(plan)
    db.commit()
    db.refresh(plan)

    c, _ = svc.create_customer(db, STORE, "01077776666", "분할환불")
    svc.charge(db, c, charge_plan_id=plan.id)

    cash_out = 0
    for _ in range(5):
        db.refresh(c)
        if c.balance <= 0:
            break
        tx, _ = svc.refund(db, c, min(30000, c.balance), "분할 환불")
        cash_out += tx.paid_amount

    db.refresh(c)
    assert c.balance == 0
    assert cash_out == 50000, f"받은 돈만큼만 나가야 한다 (실제 {cash_out:,}원)"

    s = svc.get_prepaid_summary(db, STORE)
    assert s["net_cash_in"] == 0, "충전 50,000 - 환불 50,000 = 0"


def test_환불_기준액은_보너스를_뺀_실제_낸_돈이다(db):
    """6만원을 적립받았어도 실제로 낸 돈은 5만원이다.
    잔액 전액을 현금으로 돌려주면 매장이 손해를 본다."""
    plan = ChargePlan(store_id=STORE, pay_amount=50000, credit_amount=60000)
    db.add(plan)
    db.commit()
    db.refresh(plan)

    c, _ = svc.create_customer(db, STORE, "01099998888", "환불손님")
    svc.charge(db, c, charge_plan_id=plan.id)
    svc.use(db, c, 30000, "커피")
    db.refresh(c)
    assert c.balance == 30000

    est = svc.refundable_estimate(db, c)
    assert est["balance"] == 30000, "잔액에서 뺄 금액은 전액"
    assert est["suggested"] == 25000, "건네는 현금은 30,000 × (50/60)"
    assert est["bonus_excluded"] == 5000


# --- 충전 상품 ---

def test_할인율은_결제액이_아니라_적립액_기준이다(db):
    """손님은 6만원어치를 사는 것이므로 분모가 적립액이다.
    결제액 기준(20%)으로 쓰면 실제보다 커 보여 마진 판단을 그르친다."""
    plan = ChargePlan(store_id=STORE, pay_amount=50000, credit_amount=60000)
    db.add(plan)
    db.commit()
    db.refresh(plan)
    assert plan.discount_rate == 16.7
    assert plan.bonus_amount == 10000
