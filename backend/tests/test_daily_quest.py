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


def test_매출_올리는_순간_본전_보상(monkeypatch):
    """업로드한 날짜 중 본전 넘긴 날에 코인을 준다. 같은 날 다시 올려도 이중 지급 안 됨.
    일일 퀘스트 수령과 같은 원장(ref)을 써서 한쪽에서 받으면 다른 쪽은 no-op."""
    from datetime import date
    _stub_breakeven(monkeypatch, daily_cups=50)
    # 8/6은 본전 넘김(60잔), 8/7은 미달(20잔)
    counts = {date(2026, 8, 6): 60, date(2026, 8, 7): 20}
    monkeypatch.setattr(R, "_cups_on",
                        lambda db, s, day, avg_ticket=None: {"sale": counts.get(day, 0),
                                                             "prepaid": 0, "total": counts.get(day, 0)})

    res = R.reward_breakeven_on_dates(STORE, [date(2026, 8, 6), date(2026, 8, 7)])
    assert res["achieved"] == ["2026-08-06"], "본전 넘긴 날만"
    assert res["coins"] == R.DAILY_BE_REWARD and res["count"] == 1

    # 같은 날 다시 올려도 재지급 안 됨
    again = R.reward_breakeven_on_dates(STORE, [date(2026, 8, 6)])
    assert again["coins"] == 0 and again["achieved"] == []

    # 브루룸 일일 퀘스트 수령도 같은 ref라 no-op (이미 받음)
    monkeypatch.setattr(R, "_today_cups",
                        lambda db, s, avg_ticket=None: {"sale": 60, "prepaid": 0, "total": 60})
    # 오늘=8/6로 맞추긴 어려우니, 원장에 8/6 quest_daily가 1건뿐인지로 공유를 확인
    with R._session() as db:
        n = db.query(PointLedger).filter(
            PointLedger.store_id == STORE, PointLedger.reason == "quest_daily",
            PointLedger.ref == f"{R.DAILY_BE_ID}:2026-08-06").count()
    assert n == 1, "업로드 보상과 일일 퀘스트가 같은 원장을 공유해 하루 1회"


def test_손익분기_설정_전엔_보상_없음(monkeypatch):
    from datetime import date
    _stub_breakeven(monkeypatch, computed=False, daily_cups=None)
    res = R.reward_breakeven_on_dates(STORE, [date(2026, 8, 6)])
    assert res["coins"] == 0 and res["achieved"] == []


# --- 주간 본전 스트릭 (A) ---

def test_주간_스트릭_달력과_달성일수(monkeypatch):
    """이번 주 월~오늘 날짜별 ✓/✗ + 달성 일수. 미래 요일은 집계에서 빠진다."""
    from datetime import datetime, timezone, timedelta
    _stub_breakeven(monkeypatch, daily_cups=50)
    # 모든 날 목표 넘김으로 세팅 → 달성 일수는 '월~오늘' 일수와 같아야 한다
    monkeypatch.setattr(R, "_cups_on",
                        lambda db, s, day, avg_ticket=None: {"sale": 99, "prepaid": 0, "total": 99})

    st = R._weekly_breakeven(STORE)
    today = datetime.now(timezone(timedelta(hours=9))).date()
    elapsed = today.weekday() + 1   # 월=1 … 오늘까지 지난 날 수

    assert st["available"] is True and st["goal"] == 50
    assert len(st["days"]) == 7
    assert st["achieved_count"] == elapsed, "지난 날은 다 달성, 미래는 제외"
    # 미래 요일은 done=False
    assert all((not d["done"]) for d in st["days"] if d["is_future"])
    # 지난/오늘 요일은 done=True
    assert all(d["done"] for d in st["days"] if not d["is_future"])


def test_본전_스트릭_퀘스트가_보드에_실린다(monkeypatch):
    _stub_breakeven(monkeypatch, daily_cups=50)
    monkeypatch.setattr(R, "_weekly_breakeven", lambda s: {
        "available": True, "goal": 50, "achieved_count": 3,
        "days": [{"date": "2026-08-10", "weekday": "월", "done": True,
                  "is_today": False, "is_future": False}]})
    board = R.get_quests(STORE)
    be3 = next(q for q in board["quests"] if q["id"] == "wq-be-3")
    be5 = next(q for q in board["quests"] if q["id"] == "wq-be-5")
    assert be3["progress"] == 3 and be3["done"] is True and be3["claimable"] is True
    assert be5["progress"] == 3 and be5["done"] is False   # 5일은 아직
    assert board["breakeven_streak"]["achieved_count"] == 3


def test_본전_스트릭_설정_전엔_available_False(monkeypatch):
    _stub_breakeven(monkeypatch, computed=False, daily_cups=None)
    st = R._weekly_breakeven(STORE)
    assert st["available"] is False
    assert len(st["days"]) == 7   # 달력 틀은 주되 전부 미달성
