# c:\Users\USER\Documents\본 프로젝트\SimpleM\backend\tests\test_membership_churn.py
"""
[한글 주석] 이탈 감지 규칙을 고정한다.

이게 단골 기능의 원래 목적인데 정작 테스트가 없었다.
잔액·권한만 덮고 정작 만들려던 기능은 비어 있었다.

여기 로직은 미묘해서 리팩터링 때 조용히 깨지기 쉽다 —
평균과 중앙값을 바꿔 쓰거나, 같은 날 두 잔을 2회로 세거나,
방문 2회짜리를 포함시키면 결과가 달라지는데 에러는 안 난다.
"뜸해진 단골 0명"이 뜨면 그게 정상인지 고장인지 구분할 방법이 없다.
"""
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core.database import Base
from app.models.membership import BalanceTransaction, Customer
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


def _visit(db, customer, days_ago: int, amount: int = 4000):
    """days_ago일 전에 방문해 결제한 것으로 기록한다."""
    tx, _ = svc.use(db, customer, amount, "아메리카노")
    tx.created_at = datetime.now(timezone.utc) - timedelta(days=days_ago)
    db.commit()
    return tx


def _member(db, phone: str, balance: int = 100000) -> Customer:
    c, _ = svc.create_customer(db, STORE, phone, "단골")
    svc.charge(db, c, pay_amount=balance, credit_amount=balance)
    db.refresh(c)
    return c


# --- 방문 주기 ---

def test_같은_날_두_잔은_한_번_방문이다(db):
    """아메리카노 2잔을 따로 결제하면 거래는 2건이지만 방문은 1회다.
    2회로 세면 주기가 실제보다 짧게 나와 이탈 판정이 빨라진다."""
    c = _member(db, "01011112222")
    for d in [0, 6, 12, 12, 18]:      # 12일 전에 두 잔
        _visit(db, c, d)

    st = svc.visit_stats(db, c.id)
    assert st["visit_count"] == 4, "거래는 5건이지만 방문은 4회"
    assert st["median_interval_days"] == 6.0


def test_주기는_평균이_아니라_중앙값이다(db):
    """어쩌다 한 번 길게 비운 게 평균을 통째로 망가뜨린다.

    간격이 [3, 3, 3, 60]이면
      평균  17.25일  → 판정이 늦어져 이미 떠난 뒤에 연락하게 된다
      중앙값 3일     → 평소 리듬을 반영한다
    """
    c = _member(db, "01011112222")
    for d in [69, 9, 6, 3, 0]:        # 간격: 60, 3, 3, 3
        _visit(db, c, d)

    st = svc.visit_stats(db, c.id)
    assert st["median_interval_days"] == 3.0, "평균(17.25)이 아니라 중앙값"


def test_방문_2회면_주기를_알_수_없다(db):
    """간격이 1개뿐이면 우연일 수 있다. 중앙값이 의미를 가지려면 2개는 필요하다."""
    c = _member(db, "01011112222")
    _visit(db, c, 10)
    _visit(db, c, 0)

    st = svc.visit_stats(db, c.id)
    assert st["visit_count"] == 2
    assert st["median_interval_days"] is None


# --- 이탈 판정 ---

def test_평소_주기의_두_배를_넘으면_감지한다(db):
    # 6일마다 오던 손님이 12일째 안 옴 → 2.0배
    c2 = _member(db, "01033334444")
    for d in [24, 18, 12]:
        _visit(db, c2, d)

    risk = svc.find_churn_risk(db, STORE)
    hit = [r for r in risk if r["customer_id"] == c2.id]
    assert len(hit) == 1, "6일 주기인데 12일 지났으면 감지돼야 한다"
    assert hit[0]["overdue_ratio"] == 2.0


def test_아직_평소_주기면_감지하지_않는다(db):
    """평소대로 오고 있는 손님에게 연락하면 스팸이 된다."""
    c = _member(db, "01011112222")
    for d in [21, 14, 7, 3]:          # 7일 주기, 3일 전 방문
        _visit(db, c, d)

    risk = svc.find_churn_risk(db, STORE)
    assert not any(r["customer_id"] == c.id for r in risk)


def test_방문_3회_미만은_판정_대상이_아니다(db):
    """[핵심] 평소 주기를 모르면 '뜸하다'를 판단할 수 없다.

    90일을 안 왔어도 원래 1년에 한 번 오는 손님일 수 있다.
    근거 없이 연락하면 광고가 된다.
    """
    c = _member(db, "01011112222")
    _visit(db, c, 90)                 # 딱 1회 방문, 90일 전

    risk = svc.find_churn_risk(db, STORE)
    assert not any(r["customer_id"] == c.id for r in risk)


def test_매일_오던_손님은_하한_5일로_보호된다(db):
    """매일 오는 손님의 주기는 1일이라 2배면 이틀이다.
    이틀 만에 "안 오셨네요"는 부담스럽다."""
    c = _member(db, "01011112222")
    for d in [4, 3, 2, 1]:            # 1일 주기, 어제 방문
        _visit(db, c, d)

    risk = svc.find_churn_risk(db, STORE)
    assert not any(r["customer_id"] == c.id for r in risk), "하한 5일 전에는 안 뜬다"
    assert svc.CHURN_MIN_DAYS == 5


def test_아주_뜸한_손님은_상한_60일로_끊는다(db):
    """반년에 한 번 오던 손님을 1년 뒤에 쫓아가는 건 의미가 없다."""
    assert svc.CHURN_MAX_DAYS == 60


def test_잔액이_남은_손님을_먼저_보여준다(db):
    """연락할 명분이 있기 때문이다.
    "쿠폰 드릴게요"는 광고지만 "잔액 12,000원 남아있어요"는 안내다."""
    poor = _member(db, "01011112222", balance=30000)
    for d in [40, 30, 20]:            # 10일 주기, 20일째 안 옴 → 2.0배
        _visit(db, poor, d)
    svc.use(db, poor, poor.balance)   # 잔액 0으로 만든다
    db.refresh(poor)

    rich = _member(db, "01033334444", balance=100000)
    for d in [40, 30, 20]:
        _visit(db, rich, d)

    risk = svc.find_churn_risk(db, STORE)
    ids = [r["customer_id"] for r in risk]
    assert rich.id in ids
    if poor.id in ids:
        assert ids.index(rich.id) < ids.index(poor.id), "잔액 있는 손님이 먼저"


def test_문자_문구에_잔액이_들어간다(db):
    """광고가 아니라 안내로 읽혀야 한다 — 나중에 알림톡 심사에도 유리하다."""
    c = _member(db, "01011112222", balance=50000)
    for d in [40, 30, 20]:            # 10일 주기, 20일째 안 옴
        _visit(db, c, d)

    risk = svc.find_churn_risk(db, STORE, store_name="테스트카페")
    hit = [r for r in risk if r["customer_id"] == c.id]
    assert hit, "감지돼야 한다"
    assert "잔액" in hit[0]["sms_text"]
    assert "테스트카페" in hit[0]["sms_text"]
    assert hit[0]["balance_url"].endswith(c.access_token)


def test_문자는_단문_한도를_넘지_않는다(db):
    """90바이트(EUC-KR)를 넘으면 장문이 되어 나중에 API 전환 시 요금이 2~3배다.
    매장명이 길어도 축약해서 맞춰야 한다."""
    c = _member(db, "01011112222", balance=50000)

    # 뜸해진 단골 안내 — 링크가 없다
    text = svc.build_sms_text(c, None, "아주아주긴카페이름입니다정말로")
    assert svc.sms_byte_length(text) <= svc.SMS_MAX_BYTES
    assert "http" not in text, "이 문자에는 링크를 넣지 않는다"

    # 충전 직후 — 링크가 있고, 링크는 잘리면 안 된다
    tx, _ = svc.charge(db, c, pay_amount=10000, credit_amount=10000)
    charged = svc.build_sms_text(c, tx, "아주아주긴카페이름입니다정말로")
    assert svc.sms_byte_length(charged) <= svc.SMS_MAX_BYTES
    assert svc.balance_url(c) in charged, "앞으로 확인할 주소라 자르면 안 된다"


# --- 쿠폰 ---

def test_잔액이_남은_손님에게는_쿠폰을_주지_않는다(db):
    """[핵심] 그 손님은 이미 충전할 때 할인을 받았고 잔액이 묶여 있어 어차피 온다.
    쿠폰까지 주면 이중 혜택이고 매장만 손해다."""
    c = _member(db, "01011112222", balance=50000)
    for d in [40, 30, 20]:
        _visit(db, c, d)
    db.refresh(c)

    coupon, msg = svc.issue_coupon(db, c, "아메리카노 1잔 무료", 3000)
    assert coupon is None
    assert "잔액" in msg


def test_잔액을_다_쓴_손님에게는_쿠폰을_준다(db):
    """올 이유가 아무것도 없는 손님이다. 쿠폰이 필요한 자리는 여기다."""
    c = _member(db, "01033334444", balance=12000)
    for d in [40, 30, 20]:
        _visit(db, c, d)
    db.refresh(c)
    svc.use(db, c, c.balance)
    db.refresh(c)
    assert c.balance == 0

    coupon, _ = svc.issue_coupon(db, c, "아메리카노 1잔 무료", 3000, reason="20일째 미방문")
    assert coupon is not None
    assert coupon.expires_at is not None, "기한이 없으면 1년 뒤에 들고 와도 받아줘야 한다"


def test_쿠폰은_잔액을_건드리지_않는다(db):
    """잔액에 얹으면 공짜로 받은 쿠폰을 현금으로 환불해 갈 수 있다."""
    c = _member(db, "01055556666", balance=5000)
    svc.use(db, c, 5000)
    db.refresh(c)

    coupon, _ = svc.issue_coupon(db, c, "아메리카노 1잔 무료", 3000)
    db.refresh(c)
    assert c.balance == 0, "발급해도 잔액은 그대로"

    svc.use_coupon(db, STORE, coupon.id)
    db.refresh(c)
    assert c.balance == 0, "사용해도 잔액은 그대로"


def test_미사용_쿠폰이_있으면_또_주지_않는다(db):
    """안 쓰는 사람에게 계속 보내는 건 효과가 없고,
    여러 장을 한 번에 쓰겠다는 분쟁도 생긴다."""
    c = _member(db, "01077778888", balance=3000)
    svc.use(db, c, 3000)
    db.refresh(c)

    svc.issue_coupon(db, c, "아메리카노 1잔 무료", 3000)
    again, msg = svc.issue_coupon(db, c, "라떼 1잔 무료", 3800)
    assert again is None
    assert "쓰지 않은" in msg


def test_사용한_쿠폰은_다시_못_쓴다(db):
    c = _member(db, "01099990000", balance=3000)
    svc.use(db, c, 3000)
    db.refresh(c)
    coupon, _ = svc.issue_coupon(db, c, "아메리카노 1잔 무료", 3000)

    ok, _ = svc.use_coupon(db, STORE, coupon.id)
    assert ok
    ok, msg = svc.use_coupon(db, STORE, coupon.id)
    assert not ok
    assert "이미 사용" in msg


def test_문자_문구가_손님에_따라_갈린다(db):
    """잔액 있는 손님에게 "잔액 0원 남아있습니다"는 말이 안 되고,
    잔액 없는 손님에게 잔액 안내는 올 이유가 되지 않는다."""
    rich = _member(db, "01011113333", balance=50000)
    for d in [40, 30, 20]:
        _visit(db, rich, d)

    poor = _member(db, "01022224444", balance=12000)
    for d in [40, 30, 20]:
        _visit(db, poor, d)
    db.refresh(poor)
    svc.use(db, poor, poor.balance)
    db.refresh(poor)
    svc.issue_coupon(db, poor, "아메리카노 1잔 무료", 3000)

    risk = {r["customer_id"]: r for r in svc.find_churn_risk(db, STORE, store_name="테스트카페")}

    assert "잔액" in risk[rich.id]["sms_text"]
    assert "아메리카노 1잔 무료" in risk[poor.id]["sms_text"]
    # 뜸해진 단골 문자에는 링크를 넣지 않는다 — 금액을 이미 적어 보내는데 군더더기다
    assert "http" not in risk[rich.id]["sms_text"]
    assert "http" not in risk[poor.id]["sms_text"]
