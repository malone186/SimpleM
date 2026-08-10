"""일일 퀘스트 — 오늘 본전 넘기기 (손익분기 연동)

검증하는 것:
  · 손익분기가 안 갖춰지면 목표 대신 'setup 안내'를 준다 (반쪽 숫자 대신).
  · 목표 잔수 대비 오늘 판매량으로 진행/완료를 판정한다.
  · 달성 전 수령은 막고, 달성 후 수령은 하루 1회만 (이중 수령 차단).

손익분기 계산과 오늘 판매량은 목킹한다 — 여기서 보려는 건 퀘스트 로직이지
손익분기 공식(그건 test_breakeven)이나 매출 집계가 아니다.
"""
import pytest

import app.models  # noqa: F401
from app.core.database import engine
from app.models.ai import PointLedger
from app.services.ai import reward_service as R

PointLedger.__table__.create(bind=engine, checkfirst=True)

STORE = "daily-quest-test@test.com"


@pytest.fixture(autouse=True)
def _clean():
    def _wipe():
        with R._session() as db:
            db.query(PointLedger).filter(PointLedger.store_id == STORE).delete()
            db.commit()
    _wipe()
    yield
    _wipe()


def _stub_breakeven(monkeypatch, *, computed=True, daily_cups=80, avg_ticket=4500,
                    daily_revenue=360_000, message="msg"):
    def fake(store_id, **kw):
        return {"computed": computed, "breakeven_daily_cups": daily_cups if computed else None,
                "breakeven_daily_revenue": daily_revenue, "avg_ticket": avg_ticket,
                "message": message}
    from app.services.ai import breakeven_service
    monkeypatch.setattr(breakeven_service, "compute_breakeven", fake)


def _stub_cups(monkeypatch, n, *, prepaid=0):
    # 새 _today_cups는 출처별 dict를 돌려준다: sale(업로드/POS) + prepaid(단골 실시간)
    sale = n - prepaid
    monkeypatch.setattr(R, "_today_cups",
                        lambda db, store_id, avg_ticket=None: {"sale": sale, "prepaid": prepaid, "total": n})


def test_손익분기_없으면_설정_안내(monkeypatch):
    _stub_breakeven(monkeypatch, computed=False, daily_cups=None,
                    message="고정비를 적어 주세요.")
    q = R.get_daily_quest(STORE)
    assert q["available"] is False
    assert q["needs_setup"] is True
    assert "고정비" in q["message"]
    assert "goal" not in q  # 반쪽짜리 목표를 주지 않는다


def test_목표_대비_진행도(monkeypatch):
    _stub_breakeven(monkeypatch, daily_cups=80)
    _stub_cups(monkeypatch, 62)
    q = R.get_daily_quest(STORE)
    assert q["available"] and q["goal"] == 80
    assert q["progress"] == 62 and q["sold_cups"] == 62
    assert q["done"] is False and q["claimable"] is False


def test_목표_채우면_완료_후_수령(monkeypatch):
    _stub_breakeven(monkeypatch, daily_cups=80)
    _stub_cups(monkeypatch, 85)
    q = R.get_daily_quest(STORE)
    assert q["done"] is True and q["claimable"] is True
    assert q["progress"] == 80  # 목표 이상이어도 진행 표시는 목표에서 멈춘다

    res = R.claim_daily_quest(STORE)
    assert res["awarded"] == R.DAILY_BE_REWARD
    assert res["claimed"] is True and res["claimable"] is False


def test_달성_전_수령은_막는다(monkeypatch):
    _stub_breakeven(monkeypatch, daily_cups=80)
    _stub_cups(monkeypatch, 10)
    with pytest.raises(R.RewardError):
        R.claim_daily_quest(STORE)


def test_설정_전_수령은_막는다(monkeypatch):
    _stub_breakeven(monkeypatch, computed=False, daily_cups=None)
    with pytest.raises(R.RewardError):
        R.claim_daily_quest(STORE)


def test_하루_한_번만_수령(monkeypatch):
    _stub_breakeven(monkeypatch, daily_cups=50)
    _stub_cups(monkeypatch, 60)
    first = R.claim_daily_quest(STORE)
    assert first["awarded"] == R.DAILY_BE_REWARD

    second = R.claim_daily_quest(STORE)
    assert second["awarded"] == 0            # 이미 받았다 — 코인 안 준다
    assert second["claimed"] is True

    # 원장에 quest_daily 적립은 한 줄뿐
    with R._session() as db:
        n = db.query(PointLedger).filter(
            PointLedger.store_id == STORE, PointLedger.reason == "quest_daily").count()
    assert n == 1


def test_get_quests에_daily가_실린다(monkeypatch):
    _stub_breakeven(monkeypatch, daily_cups=70)
    _stub_cups(monkeypatch, 30)
    board = R.get_quests(STORE)
    assert "daily" in board
    assert board["daily"]["goal"] == 70 and board["daily"]["progress"] == 30


def test_단골_선불_결제가_실시간_반영된다(monkeypatch):
    """단골 선불 '사용'은 계산대에서 앱으로 찍히니 실시간으로 잔 수에 잡힌다.
    충전(CHARGE)은 판매가 아니라 제외한다 — 이게 어긋나면 5만원 충전이 매출로 둔갑한다.

    _today_cups는 db를 인자로 받으므로 인메모리 세션을 직접 넘겨 격리 검증한다.
    """
    from datetime import datetime, timezone
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from sqlalchemy.pool import StaticPool

    from app.core.database import Base
    from app.models.inventory import Menu, Sale
    from app.models.membership import BalanceTransaction, Customer

    eng = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(eng)
    db = sessionmaker(bind=eng)()
    now = datetime.now(timezone.utc)

    menu = Menu(name="아메리카노", selling_price=4500, store_id=STORE); db.add(menu); db.commit()
    cust = Customer(store_id=STORE, phone="01000000000", name="단골", balance=50000); db.add(cust); db.commit()
    # 업로드/POS 판매 2잔
    db.add(Sale(menu_id=menu.id, quantity=2, total_price=9000, store_id=STORE, sold_at=now))
    # 단골 선불 사용 3건(=3잔) + 충전 1건(제외돼야)
    for _ in range(3):
        db.add(BalanceTransaction(customer_id=cust.id, store_id=STORE, tx_type="USE",
                                  amount=-4500, balance_after=0, menu_id=menu.id, created_at=now))
    db.add(BalanceTransaction(customer_id=cust.id, store_id=STORE, tx_type="CHARGE",
                              amount=50000, balance_after=50000, paid_amount=50000, created_at=now))
    db.commit()

    cups = R._today_cups(db, STORE, avg_ticket=4500)
    assert cups["sale"] == 2, "POS/업로드 판매"
    assert cups["prepaid"] == 3, "단골 선불 사용만 — 충전은 빠져야 한다"
    assert cups["total"] == 5
    db.close(); eng.dispose()
