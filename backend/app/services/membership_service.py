"""단골 회원 · 선불 충전 로직 (백엔드 B)

[한글 주석] 이 파일이 지키는 것:

1. 잔액은 거래 이력의 합계다.
   Customer.balance는 매번 합계를 내지 않기 위한 캐시일 뿐이다.
   손님 돈이므로 "왜 이 금액이죠?"에 이력으로 답할 수 있어야 하고,
   캐시와 이력이 어긋나면 reconcile_balance가 잡아낸다.

2. 충전은 매출이 아니다.
   5만원 충전은 아직 커피를 안 줬으니 빚(선수금)이고,
   커피가 나갈 때 비로소 매출이 된다.
   get_prepaid_summary가 이 둘을 절대 섞지 않는다.

3. 발송 수단은 갈아끼울 수 있어야 한다.
   지금은 사장님 폰 문자앱(sms: 링크)을 쓴다. 0원이고 사업자등록증도 필요 없다.
   나중에 알림톡으로 바꿀 때 호출부를 고치지 않도록 문구 생성만 여기서 담당하고,
   실제 발송 수단은 프런트가 고른다.
"""
import logging
import os
import re
import statistics
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.membership import (
    CHECKIN_CANCELED, CHECKIN_DONE, CHECKIN_PAYMENT, CHECKIN_SIGNUP, CHECKIN_WAITING,
    TX_ADJUST, TX_CHARGE, TX_REFUND, TX_USE,
    BalanceTransaction, ChargePlan, CheckIn, Coupon, Customer, StoreQr,  # noqa: F401
)

logger = logging.getLogger(__name__)

# 손님 잔액 조회 링크의 앞부분. 배포 도메인이 생기면 PUBLIC_BASE_URL로 바꾼다.
#
# [한글 주석] 프런트가 아니라 백엔드를 가리킨다.
# 조회 페이지를 백엔드가 HTML로 직접 주기 때문이다 — 손님은 앱을 깔지 않으므로
# 문자 링크를 누르면 로그인 없이, 번들 다운로드 없이 바로 열려야 한다.
#
# 주소가 짧을수록 좋다. 단문(SMS) 한도가 90바이트라 링크가 길면 본문이 줄어든다.
PUBLIC_BASE_URL = os.getenv("PUBLIC_BASE_URL", "http://localhost:8000")

TX_LABELS = {
    TX_CHARGE: "충전",
    TX_USE: "사용",
    TX_REFUND: "환불",
    TX_ADJUST: "보정",
}


# --- 전화번호 ---

def normalize_phone(raw: Optional[str]) -> Optional[str]:
    """전화번호를 010-1234-5678 형태로 통일한다.

    [한글 주석] 직원이 급하게 입력하면 '01012345678', '010 1234 5678',
    '+82 10-1234-5678'이 뒤섞인다. 통일하지 않으면 같은 손님이
    여러 번 등록되고 적립이 갈라진다.
    """
    if not raw:
        return None
    digits = re.sub(r"\D", "", raw)
    # +82 10... → 010...
    if digits.startswith("8210"):
        digits = "0" + digits[2:]
    elif digits.startswith("82") and len(digits) == 12:
        digits = "0" + digits[2:]
    if len(digits) != 11 or not digits.startswith("01"):
        return None
    return f"{digits[:3]}-{digits[3:7]}-{digits[7:]}"


def mask_phone(phone: Optional[str]) -> str:
    """010-****-5678 — 목록 화면에 그대로 노출하지 않는다."""
    if not phone:
        return ""
    parts = phone.split("-")
    if len(parts) != 3:
        return phone
    return f"{parts[0]}-****-{parts[2]}"


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _aware(dt: Optional[datetime]) -> Optional[datetime]:
    """시간대 없는 datetime에 UTC를 붙인다.

    [한글 주석] DB마다 돌려주는 형태가 다르다.
      Postgres(TIMESTAMP WITH TIME ZONE) → 시간대 있는 datetime
      SQLite                              → 시간대 없는 datetime

    섞어서 빼면 "can't subtract offset-naive and offset-aware datetimes"로 죽는다.
    운영은 Postgres라 안 터지지만, 그래서 더 위험하다 —
    테스트(SQLite)에서만 죽으면 이 경로를 아무도 검증하지 못한다.
    실제로 이탈 감지와 대기 목록에서 같은 문제가 두 번 났다.
    """
    if dt is None:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


# --- 회원 ---

def create_customer(db: Session, store_id: str, phone: str,
                    name: Optional[str] = None,
                    memo: Optional[str] = None,
                    consent_source: str = "OWNER") -> Tuple[Optional[Customer], str]:
    """회원을 등록한다. 이미 있으면 그 회원을 그대로 돌려준다.

    [한글 주석] 중복 등록을 막는 게 핵심이다. 번호가 같으면 같은 손님이므로
    에러를 내지 않고 기존 회원을 반환한다 — 계산대에서 에러를 만나면
    직원이 당황하고, 결국 이름을 바꿔 새로 만들어버린다.
    """
    normalized = normalize_phone(phone)
    if not normalized:
        return None, "휴대폰 번호 형식이 올바르지 않습니다."

    existing = (
        db.query(Customer)
        .filter(Customer.store_id == store_id, Customer.phone == normalized)
        .first()
    )
    if existing:
        # 비활성 회원이 다시 오면 되살린다
        if not existing.is_active:
            existing.is_active = True
            db.commit()
        return existing, "이미 등록된 회원입니다."

    customer = Customer(store_id=store_id, phone=normalized,
                        name=(name or "").strip() or None, memo=memo,
                        consent_source=consent_source, consent_at=_now())
    db.add(customer)
    db.commit()
    db.refresh(customer)
    return customer, "회원 등록이 완료되었습니다."


def find_customers(db: Session, store_id: str, query: Optional[str] = None,
                   limit: int = 50) -> List[Customer]:
    """회원 검색 — 계산대에서는 번호 뒷자리로 찾는 게 가장 빠르다.

    [한글 주석] 검색어가 없을 때는 '최근 이용 순'으로 준다.
    차감은 방문할 때마다 일어나는데, 오는 손님은 대개 단골이라
    최근 목록 맨 위에 있다. 이러면 검색 없이 한 번 탭으로 끝난다.
    (등록은 충전할 때 한 번뿐이지만 차감은 매 방문이라 여기가 훨씬 자주 쓰인다.)
    """
    # [한글 주석] 숨긴 회원은 목록에서 뺀다.
    #   삭제 요청을 받으면 이용 기록이 있는 회원은 지우지 않고 is_active만 내리는데,
    #   여기서 걸러주지 않으면 "숨겼습니다"라고 해놓고 그대로 보인다.
    #   (예전엔 정렬 기준으로만 써서 뒤로 밀릴 뿐 사라지지 않았다.)
    #   다시 오시면 같은 번호로 등록할 때 create_customer가 되살린다.
    q = db.query(Customer).filter(
        Customer.store_id == store_id,
        Customer.is_active.is_(True),
    )

    if query and query.strip():
        kw = query.strip()
        digits = re.sub(r"\D", "", kw)
        if digits:
            q = q.filter(Customer.phone.like(f"%{digits[-4:]}%"))
        else:
            q = q.filter(Customer.name.ilike(f"%{kw}%"))
        return q.order_by(Customer.balance.desc()).limit(limit).all()

    # 마지막 거래 시각 기준 정렬 (거래가 없는 회원은 뒤로)
    last_tx = (
        db.query(
            BalanceTransaction.customer_id.label("cid"),
            func.max(BalanceTransaction.created_at).label("last_at"),
        )
        .filter(BalanceTransaction.store_id == store_id)
        .group_by(BalanceTransaction.customer_id)
        .subquery()
    )
    return (
        q.outerjoin(last_tx, last_tx.c.cid == Customer.id)
        .order_by(
            # 활성 회원만 조회하므로 is_active로 정렬할 이유가 없다
            last_tx.c.last_at.desc().nullslast(),
            Customer.created_at.desc(),
        )
        .limit(limit)
        .all()
    )


def delete_customer(db: Session, store_id: str,
                    customer_id: int) -> Tuple[bool, str]:
    """회원을 정리한다.

    [한글 주석] 세 갈래로 나뉜다. 손님 돈이 걸려 있어서다.

      잔액이 남아 있으면      → 거부.
        지우면 그 돈이 장부에서 사라진다. 환불하거나 다른 계정으로 합친 뒤에 지운다.

      거래 이력이 있으면      → 비활성화만.
        "누가 언제 얼마를 썼나"는 지우면 안 되는 기록이다.
        목록과 이탈 감지에서만 빠지고 이력은 남는다.

      거래가 하나도 없으면    → 완전 삭제.
        번호를 잘못 눌러 만든 빈 회원이다. 남겨둘 이유가 없다.
    """
    c = db.query(Customer).filter(Customer.id == customer_id).first()
    if not c or c.store_id != store_id:
        return False, "회원을 찾을 수 없습니다."

    if (c.balance or 0) > 0:
        return False, (
            f"잔액이 {c.balance:,}원 남아 있어 삭제할 수 없습니다. "
            "환불 처리하거나 잔액을 보정한 뒤에 삭제해 주세요."
        )

    tx_count = (db.query(BalanceTransaction)
                .filter(BalanceTransaction.customer_id == customer_id).count())
    if tx_count > 0:
        c.is_active = False
        db.commit()
        return True, f"이용 기록 {tx_count}건이 있어 목록에서만 숨겼습니다."

    db.query(Coupon).filter(Coupon.customer_id == customer_id).delete(
        synchronize_session=False)
    db.query(CheckIn).filter(CheckIn.customer_id == customer_id).delete(
        synchronize_session=False)
    db.delete(c)
    db.commit()
    return True, "회원을 삭제했습니다."


def quick_menus(db: Session, store_id: str, limit: int = 8) -> List[Dict[str, Any]]:
    """차감용 메뉴 버튼 목록 — 실제로 많이 팔린 순.

    [한글 주석] 금액을 손으로 치는 대신 메뉴를 누르게 한다.
    타이핑이 사라져 빠르고, 오타로 엉뚱한 금액이 빠지는 사고도 막는다.
    덤으로 메모가 자동으로 채워져 손님 이용 내역이 '4,500원 사용'이 아니라
    '아메리카노'로 읽힌다.

    정렬을 판매량 기준으로 두는 이유: 처음엔 가격 오름차순으로 했더니
    '시럽추가·샷추가·사이즈업' 같은 500원짜리 옵션이 버튼을 다 차지했다.
    옵션은 단독으로 결제되는 물건이 아니라 버튼으로서 쓸모가 없다.
    실제로 많이 팔린 메뉴가 계산대에서 누를 확률이 가장 높다.
    """
    from app.models.inventory import Menu, Sale  # 지역 import — 모델 로딩 순서 의존을 피한다

    sold = (
        db.query(Sale.menu_id.label("mid"),
                 func.coalesce(func.sum(Sale.quantity), 0).label("qty"))
        .filter(Sale.store_id == store_id)
        .group_by(Sale.menu_id)
        .subquery()
    )
    rows = (
        db.query(Menu)
        .outerjoin(sold, sold.c.mid == Menu.id)
        .filter(Menu.store_id == store_id, Menu.is_active.is_(True),
                Menu.selling_price > 0)
        # 판매 이력이 아직 없으면 비싼 것(=옵션이 아닌 본메뉴)이 먼저 오게 한다
        .order_by(sold.c.qty.desc().nullslast(), Menu.selling_price.desc())
        .limit(limit)
        .all()
    )
    return [{"id": m.id, "name": m.name, "price": m.selling_price} for m in rows]


# --- 잔액 변동 (원장) ---

def _append_transaction(db: Session, customer: Customer, tx_type: str, amount: int,
                        paid_amount: Optional[int] = None,
                        charge_plan_id: Optional[int] = None,
                        memo: Optional[str] = None,
                        menu_id: Optional[int] = None) -> BalanceTransaction:
    """잔액을 바꾸는 유일한 통로.

    [한글 주석] 어디서든 customer.balance를 직접 건드리지 않고 이 함수만 쓴다.
    그래야 모든 변동이 빠짐없이 이력에 남는다.
    변동 후 잔액(balance_after)을 함께 적어두면 나중에 어느 지점에서
    어긋났는지 한 줄씩 대조해 찾을 수 있다.
    """
    new_balance = (customer.balance or 0) + amount
    tx = BalanceTransaction(
        customer_id=customer.id,
        store_id=customer.store_id,
        tx_type=tx_type,
        amount=amount,
        balance_after=new_balance,
        paid_amount=paid_amount,
        charge_plan_id=charge_plan_id,
        memo=memo,
        menu_id=menu_id,
    )
    customer.balance = new_balance
    db.add(tx)
    return tx


def _lock_customer(db: Session, customer: Customer) -> Customer:
    """잔액을 바꾸기 직전에 그 회원 행을 잠근다.

    [한글 주석] 잠그지 않으면 잔액이 마이너스가 될 수 있다.

      잔액 5,000원인 손님에게 계산대 두 곳에서 동시에 4,000원씩 차감하면
        A: 잔액 확인(5,000 >= 4,000) → 통과
        B: 잔액 확인(5,000 >= 4,000) → 통과   ← A가 아직 커밋 전이라 옛 값을 본다
        A: 커밋 → 1,000원
        B: 커밋 → -3,000원
      둘 다 통과해서 마이너스가 된다.

    행을 잠그면 B가 A의 커밋을 기다린 뒤 갱신된 잔액(1,000원)을 보고 거부한다.
    계산대에 기기가 둘이거나, 사장님이 뒤에서 정리하는 동안 알바가 결제하면
    실제로 겹친다.

    SQLite에는 행 잠금이 없어 폴백한다 — 개발용 폴백에서는 동시 요청이 없다.
    """
    # [한글 주석] populate_existing()이 반드시 필요하다.
    #   이 세션이 이미 같은 회원을 들고 있으면 SQLAlchemy는 identity map에 있는
    #   객체를 그대로 돌려주고 DB 값으로 덮어쓰지 않는다.
    #   그러면 잠그기만 하고 '옛 잔액'을 그대로 보게 되어 잠근 의미가 사라진다.
    #   populate_existing()은 DB에서 읽은 값으로 속성을 강제로 갱신한다.
    q = db.query(Customer).filter(Customer.id == customer.id).populate_existing()
    try:
        locked = q.with_for_update().first()
    except Exception as e:
        # [한글 주석] SQLite에는 행 잠금이 없다. 개발용 폴백에서는 동시 요청이
        # 없으므로 그냥 진행한다.
        #
        # 하지만 운영 DB(Postgres)에서 실패했다면 얘기가 다르다.
        # 잠금 없이 진행하면 동시 결제에서 잔액이 마이너스가 되는데,
        # 예전엔 이걸 debug 로그만 남기고 넘어갔다 — 아무도 못 본다.
        # 개발 편의를 위한 폴백이 조용한 사고 경로가 되면 안 되므로
        # 운영 DB에서는 막고 에러를 올린다.
        if db.bind is not None and db.bind.dialect.name == "sqlite":
            logger.debug("SQLite는 행 잠금을 지원하지 않습니다 — 폴백: %s", e)
            locked = q.first()
        else:
            logger.error("잔액 잠금 실패 — 동시 결제로 잔액이 어긋날 수 있어 중단합니다: %s", e)
            raise
    return locked or customer


def charge(db: Session, customer: Customer,
           charge_plan_id: Optional[int] = None,
           pay_amount: Optional[int] = None,
           credit_amount: Optional[int] = None,
           memo: Optional[str] = None) -> Tuple[Optional[BalanceTransaction], str]:
    """충전한다. 상품을 고르거나 금액을 직접 넣는다.

    [중요] 돈은 우리가 받지 않는다. 카페가 카드단말기나 현금으로 직접 받고,
    우리는 '얼마가 적립됐는지'만 기록한다.
    앱이 결제를 처리하면 전자금융업 이슈에 들어간다.
    """
    plan = None
    if charge_plan_id:
        plan = db.query(ChargePlan).filter(ChargePlan.id == charge_plan_id).first()
        if not plan or plan.store_id != customer.store_id:
            return None, "충전 상품을 찾을 수 없습니다."
        pay_amount = plan.pay_amount
        credit_amount = plan.credit_amount

    if not credit_amount or credit_amount <= 0:
        return None, "적립 금액이 필요합니다."
    if pay_amount is not None and pay_amount < 0:
        return None, "결제 금액이 올바르지 않습니다."

    # 충전도 잠근다 — 차감과 동시에 들어오면 balance 캐시가 어긋난다
    customer = _lock_customer(db, customer)

    tx = _append_transaction(
        db, customer, TX_CHARGE, amount=credit_amount,
        paid_amount=pay_amount, charge_plan_id=plan.id if plan else None,
        memo=memo,
    )
    db.commit()
    db.refresh(tx)
    # 신규 등록 요청으로 대기 중이었다면 충전이 곧 처리 완료다
    close_waiting_for_customer(db, customer.id)
    return tx, f"{credit_amount:,}원이 충전되었습니다."


def use(db: Session, customer: Customer, amount: int,
        memo: Optional[str] = None,
        menu_id: Optional[int] = None) -> Tuple[Optional[BalanceTransaction], str]:
    """잔액을 차감한다.

    [한글 주석] menu_id를 함께 받는 이유는 원가 분석 때문이다.
    메모(메뉴명)만 있으면 이름이 바뀌거나 비슷한 메뉴가 있을 때 어긋난다.
    """
    if amount <= 0:
        return None, "차감 금액이 올바르지 않습니다."

    # 잔액 확인 '전에' 잠근다 — 확인과 차감 사이에 다른 결제가 끼면 마이너스가 된다
    customer = _lock_customer(db, customer)

    if (customer.balance or 0) < amount:
        db.rollback()
        return None, (
            f"잔액이 부족합니다. (잔액 {customer.balance:,}원 / 필요 {amount:,}원)"
        )
    tx = _append_transaction(db, customer, TX_USE, amount=-amount, memo=memo,
                             menu_id=menu_id)
    db.commit()
    db.refresh(tx)
    # 차감이 끝났으면 대기 줄에서 뺀다 (남아 있으면 두 번 처리하게 된다)
    close_waiting_for_customer(db, customer.id)
    return tx, f"{amount:,}원이 사용되었습니다."


def _paid_ratio(db: Session, customer: Customer) -> float:
    """이 손님이 낸 돈 / 적립받은 돈.

    [한글 주석] 5만원 내고 6만원을 적립받았다면 0.8333이다.
    잔액 1원의 '현금 가치'가 0.8333원이라는 뜻이다.
    """
    rows = (
        db.query(
            func.coalesce(func.sum(BalanceTransaction.paid_amount), 0),
            func.coalesce(func.sum(BalanceTransaction.amount), 0),
        )
        .filter(BalanceTransaction.customer_id == customer.id,
                BalanceTransaction.tx_type == TX_CHARGE)
        .first()
    )
    paid, credited = int(rows[0] or 0), int(rows[1] or 0)
    if not credited or paid >= credited:
        return 1.0
    return paid / credited


def refund(db: Session, customer: Customer, amount: int,
           memo: Optional[str] = None) -> Tuple[Optional[BalanceTransaction], str]:
    """잔액을 현금으로 돌려준다.

    [한글 주석] 왜 보정(ADJUST)으로 때우면 안 되는가:

      선불충전은 상품권에 준해 규제받고 일정 조건에서 환불 의무가 있다.
      "환불 안 됩니다"로 버틸 수 있는 영역이 아니다.
      그런데 보정으로 처리하면 장부에서 환불인지 실수 정정인지 구분이 안 되고,
      나중에 "환불을 얼마나 해줬나"에 답할 수 없다.

      환불은 매출이 아니라 받아둔 선수금을 돌려주는 것이므로
      사용(USE)과도 반드시 구분해야 한다. 집계에서 매출로 잡히면 안 된다.
    """
    if amount <= 0:
        return None, "환불 금액이 올바르지 않습니다."

    customer = _lock_customer(db, customer)

    if (customer.balance or 0) < amount:
        db.rollback()
        return None, (
            f"잔액보다 많이 환불할 수 없습니다. (잔액 {customer.balance:,}원)"
        )

    # [한글 주석] amount는 '잔액에서 빼는 금액'이고, 실제로 건네는 현금은 그보다 적다.
    #
    #   처음엔 둘을 같은 값으로 썼는데 분할 환불에서 받은 돈보다 많이 나갔다.
    #   50,000원 받고 60,000원을 적립한 손님에게
    #     1차 30,000 환불(잔액 30,000 남음) → 2차에 또 25,000 → 3차 4,166 …
    #     총 59,166원. 9,166원 손해.
    #   잔액은 25,000만 줄었는데 사라져야 할 보너스 5,000이 남아
    #   다음 계산에서 또 환불 대상이 됐기 때문이다.
    #
    #   그래서 잔액은 amount만큼 빼고, 현금은 amount × (낸 돈/적립액)만 건넨다.
    #   전액 환불이면 잔액 60,000이 사라지고 현금 50,000이 나가 정확히 맞는다.
    cash = int(round(amount * _paid_ratio(db, customer)))

    tx = _append_transaction(db, customer, TX_REFUND, amount=-amount,
                             paid_amount=cash, memo=memo)
    db.commit()
    db.refresh(tx)
    return tx, f"잔액 {amount:,}원을 차감하고 현금 {cash:,}원을 환불했습니다."


def refundable_estimate(db: Session, customer: Customer) -> Dict[str, Any]:
    """전액 환불 시 잔액에서 뺄 금액과 실제로 건넬 현금을 계산한다.

    [한글 주석] 두 숫자가 다르다는 게 핵심이다.

      잔액 60,000원(실제 낸 돈 50,000원)인 손님을 전액 환불하면
        잔액에서 빼는 금액: 60,000원   (보너스까지 사라진다)
        건네는 현금:        50,000원   (실제로 받았던 돈)

      이걸 같은 값으로 쓰면 분할 환불에서 보너스가 계속 남아
      받은 돈보다 많이 나간다.

    강제하지는 않는다 — 환불 기준은 약관과 매장 정책, 나아가 법적 판단의
    영역이라 우리는 근거가 되는 숫자만 준다.
    """
    balance = customer.balance or 0
    ratio = _paid_ratio(db, customer)
    cash = int(round(balance * ratio))
    return {
        "balance": balance,          # 잔액에서 뺄 금액 (전액)
        "suggested": cash,           # 실제로 건넬 현금
        "paid_ratio": round(ratio, 4),
        "bonus_excluded": balance - cash,
    }


def adjust(db: Session, customer: Customer, amount: int,
           memo: str) -> Tuple[Optional[BalanceTransaction], str]:
    """사장님 수동 보정 — 실수 정정용.

    [한글 주석] 사유를 필수로 받는다. 돈이 오가는 기록에서
    이유 없는 변동은 나중에 아무도 설명하지 못한다.
    """
    if amount == 0:
        return None, "보정 금액이 0원입니다."

    customer = _lock_customer(db, customer)

    if (customer.balance or 0) + amount < 0:
        db.rollback()
        return None, "보정 후 잔액이 음수가 됩니다."
    tx = _append_transaction(db, customer, TX_ADJUST, amount=amount, memo=memo)
    db.commit()
    db.refresh(tx)
    return tx, "잔액이 보정되었습니다."


def reconcile_balance(db: Session, store_id: str) -> Dict[str, Any]:
    """캐시된 잔액과 거래 이력 합계가 맞는지 검증한다.

    [한글 주석] 손님 돈이라 어긋난 걸 모르고 지나가면 안 된다.
    버그든 중간 실패든, 정기적으로 대조해 불일치를 드러낸다.
    """
    rows = (
        db.query(
            BalanceTransaction.customer_id,
            func.coalesce(func.sum(BalanceTransaction.amount), 0),
        )
        .filter(BalanceTransaction.store_id == store_id)
        .group_by(BalanceTransaction.customer_id)
        .all()
    )
    ledger = {cid: total for cid, total in rows}

    mismatches = []
    for c in db.query(Customer).filter(Customer.store_id == store_id).all():
        expected = ledger.get(c.id, 0)
        if (c.balance or 0) != expected:
            mismatches.append({
                "customer_id": c.id,
                "name": c.name,
                "phone_masked": mask_phone(c.phone),
                "cached_balance": c.balance or 0,
                "ledger_balance": expected,
                "diff": (c.balance or 0) - expected,
            })
    return {
        "checked": db.query(Customer).filter(Customer.store_id == store_id).count(),
        "mismatch_count": len(mismatches),
        "mismatches": mismatches,
        "ok": not mismatches,
    }


# --- 문자 문구 ---

def balance_url(customer: Customer) -> str:
    return f"{PUBLIC_BASE_URL}/b/{customer.access_token}"


def sms_byte_length(text: str) -> int:
    """문자 규격상의 바이트 수를 센다.

    [한글 주석] UTF-8로 세면 안 된다. 국내 SMS는 EUC-KR 기준이라
    한글이 3바이트가 아니라 2바이트다. UTF-8로 재면 실제보다 길게 나와,
    단문으로 보낼 수 있는 문구를 장문으로 오판하게 된다.
    """
    try:
        return len(text.encode("euc-kr"))
    except UnicodeEncodeError:
        # EUC-KR에 없는 문자(이모지 등)가 섞이면 어차피 장문이다
        return len(text.encode("utf-8"))


# 단문(SMS) 한도. 넘으면 장문(LMS)이 되어 나중에 API 전환 시 요금이 2~3배가 된다.
SMS_MAX_BYTES = 90


def build_sms_text(customer: Customer, tx: Optional[BalanceTransaction] = None,
                   store_name: Optional[str] = None,
                   coupon_title: Optional[str] = None) -> str:
    """사장님 폰 문자앱에 채워 넣을 문구.

    [한글 주석] 상황마다 문구와 링크 포함 여부가 다르다.

      충전·사용 직후 → 링크를 넣는다.
        앞으로 계속 확인할 주소를 알려주는 자리이기 때문이다.

      뜸해진 단골 안내 → 링크를 뺀다.
        문자에 이미 금액을 적어 보내는데 "확인하러 들어오세요"는 군더더기다.
        게다가 링크가 단문 90바이트의 절반을 먹어 정작 할 말을 못 쓴다.

      잔액 0원인 손님 → 잔액 대신 쿠폰을 말한다.
        "잔액 0원 남아있습니다"는 말이 안 되고 올 이유도 되지 않는다.
    """
    shop = (store_name or "브루노트").strip()

    # --- 거래 직후: 링크 포함 ---
    if tx and tx.tx_type in (TX_CHARGE, TX_USE):
        word = "충전" if tx.tx_type == TX_CHARGE else "사용"
        url = balance_url(customer)
        body = f"{abs(tx.amount):,}원 {word}. 잔액 {customer.balance:,}원"

        for name in (shop, shop[:6]):
            text = f"[{name}] {body}\n{url}"
            if sms_byte_length(text) <= SMS_MAX_BYTES:
                return text
        return f"[{shop[:6]}] 잔액 {customer.balance:,}원\n{url}"

    # --- 뜸해진 단골 안내: 링크 없음 ---
    #
    # [한글 주석] 말투를 부드럽게 맞춘다.
    #   "기다리고 있겠습니다"는 정중하지만 손님에게 부담을 준다 —
    #   안 온 걸 알고 있다는 뜻이 되고, 와야 할 것 같은 압박이 된다.
    #   "편하실 때 들러주세요"는 같은 말을 하면서 선택권을 손님에게 남긴다.
    #   세 경우 모두 같은 맺음말을 써서 톤을 통일한다.
    if coupon_title:
        body = f"{coupon_title} 쿠폰 드려요. 편하실 때 들러주세요"
    elif (customer.balance or 0) > 0:
        body = f"잔액 {customer.balance:,}원 남아있어요. 편하실 때 들러주세요"
    else:
        # 쿠폰도 잔액도 없으면 보낼 말이 마땅치 않다 — 담백하게 안부만
        body = "오랜만이에요. 편하실 때 들러주세요"

    text = f"[{shop}] {body}"
    return text if sms_byte_length(text) <= SMS_MAX_BYTES else f"[{shop[:6]}] {body}"



# --- 계산대 QR · 체크인 ---

# [한글 주석] 대기 유효시간.
#   손님이 결제 요청을 눌러놓고 그냥 나가버리면 목록에 계속 남아 사장님이 헷갈린다.
#   반대로 너무 짧으면 줄이 길 때 손님 요청이 사라진다.
#   주문하고 받기까지의 현실적인 시간을 감안해 20분으로 뒀다.
CHECKIN_TTL_MINUTES = 20


def get_or_create_store_qr(db: Session, store_id: str) -> StoreQr:
    """매장 QR 토큰을 가져오거나 없으면 만든다."""
    qr = db.query(StoreQr).filter(StoreQr.store_id == store_id).first()
    if not qr:
        qr = StoreQr(store_id=store_id)
        db.add(qr)
        db.commit()
        db.refresh(qr)
    return qr


def store_checkin_url(token: str) -> str:
    return f"{PUBLIC_BASE_URL}/s/{token}"


def qr_svg(url: str, scale: int = 6) -> str:
    """QR을 SVG 문자열로 만든다.

    [한글 주석] PNG가 아니라 SVG인 이유는 인쇄 때문이다.
    계산대에 붙이려면 A4로 크게 뽑는 경우가 많은데, 비트맵은 확대하면
    가장자리가 뭉개져 스캔 실패가 는다. SVG는 아무리 키워도 선명하다.

    오류 정정 수준을 M으로 둔다 — 인쇄물이 커피에 젖거나 일부가 가려져도
    읽히게 하려면 여유가 필요하고, H까지 올리면 격자가 촘촘해져 오히려
    작은 인쇄에서 불리하다.
    """
    try:
        import segno
    except ImportError:
        logger.warning("segno 미설치 — QR 이미지를 만들 수 없습니다 (URL은 그대로 사용 가능)")
        return ""

    import io

    # segno의 SVG writer는 바이트를 쓴다 (StringIO를 주면 TypeError)
    buf = io.BytesIO()
    segno.make(url, error="m").save(buf, kind="svg", scale=scale, border=2,
                                    dark="#2E2521", light="#FFFFFF")
    return buf.getvalue().decode("utf-8")


def store_by_qr_token(db: Session, token: str) -> Optional[str]:
    qr = db.query(StoreQr).filter(StoreQr.token == token).first()
    return qr.store_id if qr else None


def create_checkin(db: Session, store_id: str, customer: Customer,
                   kind: str = CHECKIN_PAYMENT) -> Tuple[Optional[CheckIn], str]:
    """손님이 '결제 요청'을 눌렀을 때 대기 줄에 세운다.

    [한글 주석] 같은 손님이 연달아 누르면 줄에 여러 번 서게 되어
    사장님 화면이 지저분해진다. 이미 대기 중이면 그 요청을 그대로 돌려준다.
    """
    existing = (
        db.query(CheckIn)
        .filter(CheckIn.customer_id == customer.id,
                CheckIn.status == CHECKIN_WAITING)
        .order_by(CheckIn.created_at.desc())
        .first()
    )
    if existing:
        return existing, "이미 요청하셨습니다. 직원이 확인 중입니다."

    ci = CheckIn(store_id=store_id, customer_id=customer.id,
                 status=CHECKIN_WAITING, kind=kind)
    db.add(ci)
    db.commit()
    db.refresh(ci)
    return ci, "요청되었습니다. 직원에게 말씀해 주세요."


def list_waiting_checkins(db: Session, store_id: str) -> List[Dict[str, Any]]:
    """대기 중인 결제 요청 — 오래된 것은 자동으로 정리한다."""
    cutoff = _now() - timedelta(minutes=CHECKIN_TTL_MINUTES)

    # 만료 처리 (손님이 누르고 그냥 간 경우)
    stale = (
        db.query(CheckIn)
        .filter(CheckIn.store_id == store_id,
                CheckIn.status == CHECKIN_WAITING,
                CheckIn.created_at < cutoff)
        .all()
    )
    if stale:
        for s in stale:
            s.status = CHECKIN_CANCELED
            s.resolved_at = _now()
        db.commit()

    rows = (
        db.query(CheckIn)
        .filter(CheckIn.store_id == store_id, CheckIn.status == CHECKIN_WAITING)
        .order_by(CheckIn.created_at)
        .all()
    )
    out = []
    for ci in rows:
        c = ci.customer
        if not c:
            continue
        waited = int((_now() - _aware(ci.created_at)).total_seconds() // 60)
        out.append({
            "checkin_id": ci.id,
            "customer_id": c.id,
            "name": c.name,
            "phone": c.phone,
            "phone_masked": mask_phone(c.phone),
            "balance": c.balance or 0,
            "waited_minutes": max(0, waited),
            # [한글 주석] 신규 등록은 충전부터 해야 하므로 결제 요청과 구분한다.
            "kind": ci.kind or CHECKIN_PAYMENT,
            "is_signup": (ci.kind or CHECKIN_PAYMENT) == CHECKIN_SIGNUP,
        })
    return out


def resolve_checkin(db: Session, store_id: str, checkin_id: int,
                    status: str = CHECKIN_DONE) -> bool:
    ci = db.query(CheckIn).filter(CheckIn.id == checkin_id).first()
    if not ci or ci.store_id != store_id:
        return False
    ci.status = status
    ci.resolved_at = _now()
    db.commit()
    return True


def close_waiting_for_customer(db: Session, customer_id: int) -> None:
    """이 손님의 대기 요청을 닫는다 — 차감이 끝나면 줄에서 빠져야 한다.

    [한글 주석] 차감했는데 대기 목록에 그대로 남아 있으면
    직원이 두 번 처리하거나 다음 손님과 헷갈린다.
    """
    rows = (
        db.query(CheckIn)
        .filter(CheckIn.customer_id == customer_id,
                CheckIn.status == CHECKIN_WAITING)
        .all()
    )
    for r in rows:
        r.status = CHECKIN_DONE
        r.resolved_at = _now()
    if rows:
        db.commit()


# --- 쿠폰 ---

# [한글 주석] 이탈 방지 쿠폰의 유효기간.
#   "지금 오시라"는 뜻의 쿠폰이라 기한이 없으면 의미가 흐려진다.
#   반대로 일주일은 짧아서 못 오고 버려진다. 한 달이면 한 번은 지나간다.
COUPON_VALID_DAYS = 30


def issue_coupon(db: Session, customer: Customer, title: str,
                 amount: int = 0, menu_id: Optional[int] = None,
                 reason: Optional[str] = None) -> Tuple[Optional[Coupon], str]:
    """이탈 방지 쿠폰을 발급한다.

    [한글 주석] 잔액이 남은 손님에게는 주지 않는다.

      그 손님은 이미 충전할 때 할인을 받았고, 잔액이 묶여 있어 어차피 온다.
      쿠폰까지 주면 이중 혜택이고 매장만 손해다.
      쿠폰이 필요한 건 '올 이유가 아무것도 없는' 잔액 0원 손님이다.

    미사용 쿠폰이 남아 있으면 또 주지 않는다 — 안 쓰는 사람에게 계속 보내는 건
    효과가 없고, 여러 장을 들고 와 한 번에 쓰겠다는 분쟁도 생긴다.
    """
    if (customer.balance or 0) > 0:
        return None, (
            f"잔액이 {customer.balance:,}원 남아 있어 쿠폰 대상이 아닙니다. "
            "잔액 안내를 보내 주세요."
        )

    existing = (
        db.query(Coupon)
        .filter(Coupon.customer_id == customer.id, Coupon.used_at.is_(None))
        .first()
    )
    if existing and (existing.expires_at is None or _aware(existing.expires_at) > _now()):
        return None, "아직 쓰지 않은 쿠폰이 있습니다."

    coupon = Coupon(
        store_id=customer.store_id,
        customer_id=customer.id,
        title=title.strip(),
        amount=max(0, amount),
        menu_id=menu_id,
        expires_at=_now() + timedelta(days=COUPON_VALID_DAYS),
        issue_reason=reason,
    )
    db.add(coupon)
    db.commit()
    db.refresh(coupon)
    return coupon, f"{title} 쿠폰을 발급했습니다. ({COUPON_VALID_DAYS}일간 유효)"


def list_coupons(db: Session, customer_id: int,
                 only_usable: bool = False) -> List[Dict[str, Any]]:
    q = db.query(Coupon).filter(Coupon.customer_id == customer_id)
    rows = q.order_by(Coupon.issued_at.desc()).limit(20).all()
    now = _now()
    out = []
    for c in rows:
        expired = c.expires_at is not None and _aware(c.expires_at) < now
        usable = c.used_at is None and not expired
        if only_usable and not usable:
            continue
        out.append({
            "id": c.id,
            "title": c.title,
            "amount": c.amount,
            "issued_at": c.issued_at,
            "expires_at": c.expires_at,
            "used_at": c.used_at,
            "is_used": c.used_at is not None,
            "is_expired": expired,
            "usable": usable,
        })
    return out


def use_coupon(db: Session, store_id: str, coupon_id: int) -> Tuple[bool, str]:
    """쿠폰을 사용 처리한다.

    [한글 주석] 잔액을 건드리지 않는다. 쿠폰은 잔액과 다른 물건이다.
    잔액에 얹으면 손님이 공짜로 받은 쿠폰을 현금으로 환불해 갈 수 있다.
    """
    c = db.query(Coupon).filter(Coupon.id == coupon_id).first()
    if not c or c.store_id != store_id:
        return False, "쿠폰을 찾을 수 없습니다."
    if c.used_at is not None:
        return False, "이미 사용한 쿠폰입니다."
    if c.expires_at is not None and _aware(c.expires_at) < _now():
        return False, "유효기간이 지난 쿠폰입니다."
    c.used_at = _now()
    db.commit()
    return True, f"{c.title} 쿠폰을 사용 처리했습니다."


# --- 방문 지표 ---

def _visit_dates(db: Session, customer_id: int) -> List[datetime]:
    """방문 '날짜' 목록 — 같은 날 여러 잔은 1회로 센다.

    [한글 주석] 아메리카노 2잔을 따로 결제하면 거래는 2건이지만 방문은 1회다.
    이걸 2회로 세면 방문 주기가 실제보다 짧게 나와 이탈 판정이 빨라진다.
    """
    rows = (
        db.query(func.date(BalanceTransaction.created_at))
        .filter(
            BalanceTransaction.customer_id == customer_id,
            BalanceTransaction.tx_type == TX_USE,
        )
        .distinct()
        .order_by(func.date(BalanceTransaction.created_at))
        .all()
    )
    # [한글 주석] func.date()의 반환 타입이 DB마다 다르다.
    #   Postgres는 date 객체, SQLite는 'YYYY-MM-DD' 문자열을 준다.
    #   문자열을 date처럼 다루면 AttributeError로 이탈 감지가 통째로 죽는다.
    #   운영에서는 Postgres라 안 터지지만, 그래서 더 위험하다 —
    #   테스트(SQLite)에서만 죽으면 아무도 이 함수를 검증하지 못한다.
    out = []
    for (d,) in rows:
        if d is None:
            continue
        if isinstance(d, datetime):
            out.append(d)
        elif isinstance(d, str):
            try:
                parsed = datetime.strptime(d[:10], "%Y-%m-%d")
            except ValueError:
                logger.warning("방문일 형식을 읽지 못했습니다: %r", d)
                continue
            out.append(parsed.replace(tzinfo=timezone.utc))
        else:
            # date 객체 (Postgres)
            out.append(datetime(d.year, d.month, d.day, tzinfo=timezone.utc))
    return out


def _stats_from_dates(dates: List[datetime]) -> Dict[str, Any]:
    """방문 날짜 목록 → 주기 지표. visit_stats(단건)와 bulk 경로가 공유하는 계산부."""
    if not dates:
        return {"visit_count": 0, "last_visit_at": None,
                "days_since_visit": None, "median_interval_days": None}

    last = dates[-1]
    days_since = (_now().date() - last.date()).days

    intervals = [
        (dates[i] - dates[i - 1]).days
        for i in range(1, len(dates))
        if (dates[i] - dates[i - 1]).days > 0
    ]
    median = round(statistics.median(intervals), 1) if len(intervals) >= 2 else None

    return {
        "visit_count": len(dates),
        "last_visit_at": last,
        "days_since_visit": days_since,
        "median_interval_days": median,
    }


def visit_stats(db: Session, customer_id: int) -> Dict[str, Any]:
    """개인별 방문 주기를 낸다.

    [한글 주석] 평균이 아니라 중앙값을 쓴다.
    어쩌다 한 번 두 달 비운 게 평균을 통째로 망가뜨리기 때문이다.
    (원두 시세에서 중앙값을 쓴 것과 같은 이유다.)

    간격이 최소 2개는 있어야 중앙값이 의미를 갖는다 → 방문 3회 이상이 조건.
    """
    return _stats_from_dates(_visit_dates(db, customer_id))


def _normalize_visit_date(d: Any) -> Optional[datetime]:
    """func.date() 반환값을 datetime으로 — Postgres는 date, SQLite는 문자열을 준다."""
    if d is None:
        return None
    if isinstance(d, datetime):
        return d
    if isinstance(d, str):
        try:
            return datetime.strptime(d[:10], "%Y-%m-%d").replace(tzinfo=timezone.utc)
        except ValueError:
            logger.warning("방문일 형식을 읽지 못했습니다: %r", d)
            return None
    return datetime(d.year, d.month, d.day, tzinfo=timezone.utc)


def visit_stats_bulk(db: Session, customer_ids: List[int]) -> Dict[int, Dict[str, Any]]:
    """여러 고객의 방문 지표를 쿼리 1번으로 낸다.

    고객당 visit_stats를 부르면 Neon 왕복(~0.2초)이 사람 수만큼 쌓여
    회원 50명 목록이 10초, 이탈 스캔 100명이 수십 초였다 (2026-08-06 감사).
    """
    if not customer_ids:
        return {}
    rows = (
        db.query(BalanceTransaction.customer_id, func.date(BalanceTransaction.created_at))
        .filter(
            BalanceTransaction.customer_id.in_(customer_ids),
            BalanceTransaction.tx_type == TX_USE,
        )
        .distinct()
        .order_by(BalanceTransaction.customer_id, func.date(BalanceTransaction.created_at))
        .all()
    )
    dates_by_customer: Dict[int, List[datetime]] = {}
    for cid, d in rows:
        parsed = _normalize_visit_date(d)
        if parsed is not None:
            dates_by_customer.setdefault(cid, []).append(parsed)
    return {cid: _stats_from_dates(dates_by_customer.get(cid, [])) for cid in customer_ids}


# [한글 주석] 이탈 판정 기준.
#   배수 2.0: 평소 주기의 2배를 넘으면 '뜸해졌다'고 본다.
#     고정 '2주'를 쓰지 않는 이유 — 매일 오던 손님의 2주 공백은 이미 늦었고,
#     격주로 오던 손님의 2주는 정상이다. 같은 잣대를 댈 수 없다.
#   하한 5일: 매일 오던 손님에게 이틀 만에 연락하면 부담스럽다.
#   상한 60일: 반년에 한 번 오던 손님을 1년 뒤에 쫓아가는 건 의미가 없다.
CHURN_MULTIPLIER = 2.0
CHURN_MIN_DAYS = 5
CHURN_MAX_DAYS = 60
CHURN_MIN_VISITS = 3


def find_churn_risk(db: Session, store_id: str, limit: int = 20,
                    store_name: Optional[str] = None) -> List[Dict[str, Any]]:
    """평소보다 오래 안 온 단골을 찾는다.

    [한글 주석] 잔액이 남은 손님을 우선한다. 연락할 명분이 있기 때문이다.
    "쿠폰 드릴게요"는 광고지만 "잔액 12,000원 남아있어요"는 안내다.
    받는 사람 입장에서도, 나중에 알림톡으로 전환할 때 심사 측면에서도 다르다.
    """
    out: List[Dict[str, Any]] = []
    customers = (
        db.query(Customer)
        .filter(Customer.store_id == store_id, Customer.is_active.is_(True))
        .all()
    )

    # 고객당 2쿼리(N+1)를 매장 전체 2쿼리로 — 방문 지표는 일괄, 쿠폰은 이탈 후보만 일괄
    stats_map = visit_stats_bulk(db, [c.id for c in customers])

    candidates = []
    for c in customers:
        st = stats_map.get(c.id) or _stats_from_dates([])
        if st["visit_count"] < CHURN_MIN_VISITS or st["median_interval_days"] is None:
            continue  # 평소 주기를 모르면 '뜸하다'를 판단할 수 없다

        threshold = st["median_interval_days"] * CHURN_MULTIPLIER
        threshold = max(CHURN_MIN_DAYS, min(threshold, CHURN_MAX_DAYS))
        if st["days_since_visit"] < threshold:
            continue
        candidates.append((c, st))

    now = _now()
    usable_by_customer: Dict[int, List[str]] = {}
    if candidates:
        coupon_rows = (
            db.query(Coupon)
            .filter(Coupon.customer_id.in_([c.id for c, _ in candidates]), Coupon.used_at.is_(None))
            .order_by(Coupon.issued_at.desc())
            .all()
        )
        for cp in coupon_rows:
            if cp.expires_at is not None and _aware(cp.expires_at) < now:
                continue
            usable_by_customer.setdefault(cp.customer_id, []).append(cp.title)

    for c, st in candidates:
        # [한글 주석] 손님을 두 종류로 나눈다.
        #   잔액 있음 → 이미 올 이유가 있다. 잔액을 알려주면 된다.
        #   잔액 0원  → 올 이유가 없다. 쿠폰이 필요한 자리다.
        # 잔액 있는 손님에게 쿠폰까지 주면 이중 혜택이라 매장만 손해다.
        usable = usable_by_customer.get(c.id, [])
        coupon_title = usable[0] if usable else None
        needs_coupon = (c.balance or 0) <= 0 and not usable

        out.append({
            "customer_id": c.id,
            "name": c.name,
            "phone": c.phone,
            "phone_masked": mask_phone(c.phone),
            "balance": c.balance or 0,
            "visit_count": st["visit_count"],
            "median_interval_days": st["median_interval_days"],
            "days_since_visit": st["days_since_visit"],
            "overdue_ratio": round(st["days_since_visit"] / st["median_interval_days"], 1),
            "coupon_title": coupon_title,
            "needs_coupon": needs_coupon,
            "sms_text": build_sms_text(c, None, store_name, coupon_title),
            "balance_url": balance_url(c),
        })

    # 잔액 있는 손님 먼저, 그다음 많이 밀린 순
    out.sort(key=lambda x: (x["balance"] > 0, x["overdue_ratio"]), reverse=True)
    return out[:limit]


# --- 집계 (매출과 분리) ---

def get_prepaid_summary(db: Session, store_id: str, days: int = 30) -> Dict[str, Any]:
    """선수금 현황 — 매출과 절대 섞지 않는다.

    [한글 주석] 충전 5만원은 매출이 아니라 부채다. 아직 커피를 안 줬으니
    언제든 커피로 돌려줘야 할 빚이다. 커피가 나갈 때 비로소 매출이 된다.

    이걸 섞으면 사장님이 충전 많은 날 매출이 뛴 걸로 착각하고,
    정작 그 손님이 커피를 마실 땐 매출이 안 잡혀 혼란스러워한다.
    세금 신고에도 영향이 간다.
    """
    since = _now() - timedelta(days=days)
    base = db.query(BalanceTransaction).filter(
        BalanceTransaction.store_id == store_id,
        BalanceTransaction.created_at >= since,
    )

    def _sum(q) -> int:
        return int(q.with_entities(
            func.coalesce(func.sum(BalanceTransaction.amount), 0)).scalar() or 0)

    charged_paid = int(
        base.filter(BalanceTransaction.tx_type == TX_CHARGE)
        .with_entities(func.coalesce(func.sum(BalanceTransaction.paid_amount), 0))
        .scalar() or 0
    )
    credited = _sum(base.filter(BalanceTransaction.tx_type == TX_CHARGE))
    used = abs(_sum(base.filter(BalanceTransaction.tx_type == TX_USE)))
    # [한글 주석] 환불은 매출이 아니라 받아둔 돈을 돌려주는 현금 유출이다.
    # 사용액과 섞으면 매출이 부풀고, 현금 유입에서 빼지 않으면 실제 남은 돈이 과대계상된다.
    # [한글 주석] 환불의 현금 유출은 amount(잔액 차감분)가 아니라
    # paid_amount(실제 건넨 현금)로 세야 한다.
    # 잔액 60,000을 지우고 현금 50,000을 줬다면 나간 돈은 50,000이다.
    refunded = int(
        base.filter(BalanceTransaction.tx_type == TX_REFUND)
        .with_entities(func.coalesce(func.sum(BalanceTransaction.paid_amount), 0))
        .scalar() or 0
    )

    # 미사용 잔액 = 지금 우리가 진 빚 (기간과 무관한 현재 시점 값)
    outstanding = int(
        db.query(func.coalesce(func.sum(Customer.balance), 0))
        .filter(Customer.store_id == store_id).scalar() or 0
    )
    customer_count = db.query(Customer).filter(Customer.store_id == store_id).count()

    return {
        "customer_count": customer_count,
        "active_balance_total": outstanding,
        "charged_total": charged_paid,
        "credited_total": credited,
        "used_total": used,
        "refunded_total": refunded,
        "net_cash_in": charged_paid - refunded,
        "bonus_given": max(0, credited - charged_paid),
        "period_days": days,
    }


def get_prepaid_cost_analysis(db: Session, store_id: str, days: int = 90) -> Dict[str, Any]:
    """선불 고객의 '실질' 원가율.

    [한글 주석] 왜 그냥 원가율이 아니라 '실질'인가:

      아메리카노 3,000원 / 원가 900원이면 원가율은 30%다.
      그런데 5만원에 6만원을 적립해 줬다면 손님이 실제로 낸 돈은
      3,000원이 아니라 2,500원이다(16.7% 할인).
      실질 원가율 = 900 / 2,500 = 36%.

      메뉴판 원가율만 보면 이 6%p가 통째로 안 보인다.
      게다가 손님이 원가율 높은 메뉴에 몰리면 차이는 더 벌어진다.
      선불 회원제가 남는 장사인지 아닌지는 이 숫자로 판단해야 한다.

      할인율은 매장이 실제로 팔아온 충전 상품들의 가중평균으로 낸다.
      상품마다 할인율이 다르므로 특정 상품 기준으로 잡으면 왜곡된다.
    """
    from app.models.inventory import Menu, Recipe  # 지역 import

    since = _now() - timedelta(days=days)

    # 1) 실효 할인율 — 이 매장이 실제로 내준 보너스 비중
    charged = (
        db.query(
            func.coalesce(func.sum(BalanceTransaction.paid_amount), 0),
            func.coalesce(func.sum(BalanceTransaction.amount), 0),
        )
        .filter(BalanceTransaction.store_id == store_id,
                BalanceTransaction.tx_type == TX_CHARGE,
                BalanceTransaction.created_at >= since)
        .first()
    )
    paid_total, credited_total = int(charged[0] or 0), int(charged[1] or 0)
    # 손님이 6만원어치를 5만원에 샀으므로 분모는 적립액이다
    discount_rate = ((credited_total - paid_total) / credited_total
                     if credited_total else 0.0)

    # 2) 메뉴별 원가 (레시피량 × 재료 현재단가) — 기존 원가 계산과 같은 공식
    menus = db.query(Menu).filter(Menu.store_id == store_id).all()
    cost_by_menu: Dict[int, int] = {}
    for m in menus:
        total = 0
        for r in m.recipes:
            if r.ingredient:
                total += int(r.quantity * (r.ingredient.current_price or 0))
        cost_by_menu[m.id] = total

    # 3) 선불로 나간 메뉴들을 집계
    rows = (
        db.query(BalanceTransaction.menu_id,
                 func.count(BalanceTransaction.id),
                 func.coalesce(func.sum(func.abs(BalanceTransaction.amount)), 0))
        .filter(BalanceTransaction.store_id == store_id,
                BalanceTransaction.tx_type == TX_USE,
                BalanceTransaction.created_at >= since)
        .group_by(BalanceTransaction.menu_id)
        .all()
    )

    menu_names = {m.id: m.name for m in menus}
    items: List[Dict[str, Any]] = []
    known_sales = known_cost = 0
    unknown_count = unknown_sales = 0

    for menu_id, cnt, amount in rows:
        amount = int(amount or 0)
        if menu_id is None or menu_id not in cost_by_menu:
            # menu_id 없이 금액만 차감한 건 — 원가를 알 수 없어 집계에서 뺀다
            unknown_count += int(cnt)
            unknown_sales += amount
            continue
        cost = cost_by_menu[menu_id] * int(cnt)
        known_sales += amount
        known_cost += cost
        # 손님이 실제로 낸 돈 기준 (할인 반영)
        effective = amount * (1 - discount_rate)
        items.append({
            "menu_id": menu_id,
            "name": menu_names.get(menu_id, "(삭제된 메뉴)"),
            "count": int(cnt),
            "sales": amount,
            "cost": cost,
            "list_cost_rate": round(cost / amount * 100, 1) if amount else 0.0,
            "real_cost_rate": round(cost / effective * 100, 1) if effective else 0.0,
        })

    items.sort(key=lambda x: x["sales"], reverse=True)

    effective_sales = known_sales * (1 - discount_rate)
    list_rate = round(known_cost / known_sales * 100, 1) if known_sales else 0.0
    real_rate = round(known_cost / effective_sales * 100, 1) if effective_sales else 0.0

    # 4) 비교군 — 일반 판매(선불이 아닌 매출)의 원가율
    from app.models.inventory import Sale

    normal = (
        db.query(Sale.menu_id,
                 func.coalesce(func.sum(Sale.quantity), 0),
                 func.coalesce(func.sum(Sale.total_price), 0))
        .filter(Sale.store_id == store_id, Sale.sold_at >= since)
        .group_by(Sale.menu_id)
        .all()
    )
    n_sales = n_cost = 0
    for menu_id, qty, total in normal:
        if menu_id in cost_by_menu:
            n_sales += int(total or 0)
            n_cost += cost_by_menu[menu_id] * int(qty or 0)
    normal_rate = round(n_cost / n_sales * 100, 1) if n_sales else None

    return {
        "period_days": days,
        "discount_rate": round(discount_rate * 100, 1),
        "prepaid_sales": known_sales,
        "prepaid_cost": known_cost,
        "list_cost_rate": list_rate,      # 메뉴판 기준
        "real_cost_rate": real_rate,      # 충전 할인까지 반영
        "normal_cost_rate": normal_rate,  # 일반 판매 비교군
        "gap": (round(real_rate - normal_rate, 1)
                if normal_rate is not None else None),
        "items": items[:10],
        "unknown_count": unknown_count,   # 메뉴 없이 금액만 차감한 건
        "unknown_sales": unknown_sales,
        "has_data": bool(items),
    }


def list_transactions(db: Session, customer_id: int, limit: int = 30) -> List[BalanceTransaction]:
    return (
        db.query(BalanceTransaction)
        .filter(BalanceTransaction.customer_id == customer_id)
        # [한글 주석] created_at만으로 정렬하면 같은 초에 들어온 거래들의 순서가
        # 실행할 때마다 달라진다(계산대에서는 몇 초 안에 여러 건이 찍힌다).
        # 손님 이용 내역이 뒤죽박죽 보이므로 id를 보조 기준으로 고정한다.
        .order_by(BalanceTransaction.created_at.desc(), BalanceTransaction.id.desc())
        .limit(limit)
        .all()
    )
