# c:\Users\USER\Documents\본 프로젝트\SimpleM\backend\tests\test_membership_prepaid_summary.py
"""
[한글 주석] 충전액이 매출로 잡히지 않도록 고정한다.

5만원 충전은 아직 커피를 안 줬으므로 매출이 아니라 부채(선수금)다.
커피가 나갈 때 비로소 매출이 된다.

이걸 섞으면 사장님이 충전 많은 날 매출이 뛴 걸로 착각하고,
정작 그 손님이 커피를 마실 땐 매출이 안 잡혀 혼란스러워한다.
세금 신고에도 영향이 간다.

한 번 섞여서 쌓이면 되돌리기 어려운 종류의 실수라 테스트로 묶어 둔다.
"""
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core.database import Base
from app.models.membership import ChargePlan, Customer
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


@pytest.fixture()
def plan(db):
    p = ChargePlan(store_id=STORE, pay_amount=50000, credit_amount=60000)
    db.add(p)
    db.commit()
    db.refresh(p)
    return p


def test_충전만_하면_매출은_0원이다(db, plan):
    """커피를 아직 안 줬으므로 매출이 아니다."""
    c, _ = svc.create_customer(db, STORE, "01011112222")
    svc.charge(db, c, charge_plan_id=plan.id)

    s = svc.get_prepaid_summary(db, STORE)
    assert s["used_total"] == 0, "충전은 매출이 아니다"
    assert s["charged_total"] == 50000, "실제 들어온 현금은 결제액"
    assert s["credited_total"] == 60000, "적립액은 따로 센다"
    assert s["active_balance_total"] == 60000, "전액이 아직 갚아야 할 빚"


def test_커피가_나갈_때_매출이_된다(db, plan):
    c, _ = svc.create_customer(db, STORE, "01011112222")
    svc.charge(db, c, charge_plan_id=plan.id)
    svc.use(db, c, 4500, "아메리카노")

    s = svc.get_prepaid_summary(db, STORE)
    assert s["used_total"] == 4500
    assert s["charged_total"] == 50000, "사용한다고 현금 유입이 늘지 않는다"
    assert s["active_balance_total"] == 55500, "쓴 만큼 빚이 줄어든다"


def test_현금유입은_적립액이_아니라_결제액이다(db, plan):
    """6만원이 적립돼도 실제로 받은 돈은 5만원이다.
    적립액을 현금으로 세면 있지도 않은 1만원이 장부에 생긴다."""
    c, _ = svc.create_customer(db, STORE, "01011112222")
    svc.charge(db, c, charge_plan_id=plan.id)

    s = svc.get_prepaid_summary(db, STORE)
    assert s["charged_total"] == 50000
    assert s["bonus_given"] == 10000, "나간 보너스가 곧 실질 할인 총액"


def test_환불은_매출이_아니라_현금_유출이다(db, plan):
    """환불을 사용액에 섞으면 매출이 부풀고,
    현금 유입에서 빼지 않으면 실제 남은 돈이 과대계상된다."""
    c, _ = svc.create_customer(db, STORE, "01011112222")
    svc.charge(db, c, charge_plan_id=plan.id)
    svc.use(db, c, 4500, "아메리카노")
    svc.refund(db, c, 20000, "고객 요청")

    s = svc.get_prepaid_summary(db, STORE)
    assert s["used_total"] == 4500, "환불이 매출에 섞이면 안 된다"
    assert s["refunded_total"] == 20000
    assert s["net_cash_in"] == 30000, "실제 남은 현금 = 충전 50,000 - 환불 20,000"
    assert s["active_balance_total"] == 35500


def test_회원이_없어도_안전하게_0을_돌려준다(db):
    s = svc.get_prepaid_summary(db, "없는매장@cafe.com")
    assert s["customer_count"] == 0
    assert s["used_total"] == 0
    assert s["active_balance_total"] == 0


def test_미사용_잔액은_매장_전체_합계다(db, plan):
    """지금 이 순간 갚아야 할 총액 — 사장님이 폐업·양도 때 반드시 알아야 하는 숫자."""
    for i, phone in enumerate(["01011112222", "01033334444", "01055556666"]):
        c, _ = svc.create_customer(db, STORE, phone)
        svc.charge(db, c, pay_amount=10000, credit_amount=10000)
        if i == 0:
            svc.use(db, c, 3000)

    s = svc.get_prepaid_summary(db, STORE)
    assert s["customer_count"] == 3
    assert s["active_balance_total"] == 27000  # 30,000 - 3,000
