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
    TX_ADJUST, TX_CHARGE, TX_REFUND, TX_USE,
    BalanceTransaction, ChargePlan, Customer,
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


# --- 회원 ---

def create_customer(db: Session, store_id: str, phone: str,
                    name: Optional[str] = None,
                    memo: Optional[str] = None) -> Tuple[Optional[Customer], str]:
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
                        name=(name or "").strip() or None, memo=memo)
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
    q = db.query(Customer).filter(Customer.store_id == store_id)

    if query and query.strip():
        kw = query.strip()
        digits = re.sub(r"\D", "", kw)
        if digits:
            q = q.filter(Customer.phone.like(f"%{digits[-4:]}%"))
        else:
            q = q.filter(Customer.name.ilike(f"%{kw}%"))
        return q.order_by(Customer.is_active.desc(),
                          Customer.balance.desc()).limit(limit).all()

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
            Customer.is_active.desc(),
            last_tx.c.last_at.desc().nullslast(),
            Customer.created_at.desc(),
        )
        .limit(limit)
        .all()
    )


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
                        memo: Optional[str] = None) -> BalanceTransaction:
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
    )
    customer.balance = new_balance
    db.add(tx)
    return tx


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

    tx = _append_transaction(
        db, customer, TX_CHARGE, amount=credit_amount,
        paid_amount=pay_amount, charge_plan_id=plan.id if plan else None,
        memo=memo,
    )
    db.commit()
    db.refresh(tx)
    return tx, f"{credit_amount:,}원이 충전되었습니다."


def use(db: Session, customer: Customer, amount: int,
        memo: Optional[str] = None) -> Tuple[Optional[BalanceTransaction], str]:
    """잔액을 차감한다."""
    if amount <= 0:
        return None, "차감 금액이 올바르지 않습니다."
    if (customer.balance or 0) < amount:
        return None, (
            f"잔액이 부족합니다. (잔액 {customer.balance:,}원 / 필요 {amount:,}원)"
        )
    tx = _append_transaction(db, customer, TX_USE, amount=-amount, memo=memo)
    db.commit()
    db.refresh(tx)
    return tx, f"{amount:,}원이 사용되었습니다."


def adjust(db: Session, customer: Customer, amount: int,
           memo: str) -> Tuple[Optional[BalanceTransaction], str]:
    """사장님 수동 보정 — 실수 정정용.

    [한글 주석] 사유를 필수로 받는다. 돈이 오가는 기록에서
    이유 없는 변동은 나중에 아무도 설명하지 못한다.
    """
    if amount == 0:
        return None, "보정 금액이 0원입니다."
    if (customer.balance or 0) + amount < 0:
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
                   store_name: Optional[str] = None) -> str:
    """사장님 폰 문자앱에 채워 넣을 문구.

    [한글 주석] 한도(90바이트)를 넘으면 매장명을 먼저 줄이고,
    그래도 넘으면 잔액 안내만 남긴다.
    링크는 손님이 잔액을 확인하는 유일한 경로라 절대 자르지 않는다.
    """
    shop = (store_name or "브루노트").strip()
    url = balance_url(customer)

    if tx and tx.tx_type == TX_CHARGE:
        body = f"{tx.amount:,}원 충전. 잔액 {customer.balance:,}원"
    elif tx and tx.tx_type == TX_USE:
        body = f"{abs(tx.amount):,}원 사용. 잔액 {customer.balance:,}원"
    else:
        body = f"잔액 {customer.balance:,}원 남아있습니다"

    text = f"[{shop}] {body}\n{url}"
    if sms_byte_length(text) <= SMS_MAX_BYTES:
        return text

    # 1차 축약 — 긴 매장명이 원인인 경우가 대부분이다
    short_shop = shop[:6]
    text = f"[{short_shop}] {body}\n{url}"
    if sms_byte_length(text) <= SMS_MAX_BYTES:
        return text

    # 2차 축약 — 거래 내용을 빼고 잔액만 남긴다
    return f"[{short_shop}] 잔액 {customer.balance:,}원\n{url}"


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
    out = []
    for (d,) in rows:
        if isinstance(d, datetime):
            out.append(d)
        elif d is not None:
            out.append(datetime(d.year, d.month, d.day, tzinfo=timezone.utc))
    return out


def visit_stats(db: Session, customer_id: int) -> Dict[str, Any]:
    """개인별 방문 주기를 낸다.

    [한글 주석] 평균이 아니라 중앙값을 쓴다.
    어쩌다 한 번 두 달 비운 게 평균을 통째로 망가뜨리기 때문이다.
    (원두 시세에서 중앙값을 쓴 것과 같은 이유다.)

    간격이 최소 2개는 있어야 중앙값이 의미를 갖는다 → 방문 3회 이상이 조건.
    """
    dates = _visit_dates(db, customer_id)
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

    for c in customers:
        st = visit_stats(db, c.id)
        if st["visit_count"] < CHURN_MIN_VISITS or st["median_interval_days"] is None:
            continue  # 평소 주기를 모르면 '뜸하다'를 판단할 수 없다

        threshold = st["median_interval_days"] * CHURN_MULTIPLIER
        threshold = max(CHURN_MIN_DAYS, min(threshold, CHURN_MAX_DAYS))
        if st["days_since_visit"] < threshold:
            continue

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
            "sms_text": build_sms_text(c, None, store_name),
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
        "bonus_given": max(0, credited - charged_paid),
        "period_days": days,
    }


def list_transactions(db: Session, customer_id: int, limit: int = 30) -> List[BalanceTransaction]:
    return (
        db.query(BalanceTransaction)
        .filter(BalanceTransaction.customer_id == customer_id)
        .order_by(BalanceTransaction.created_at.desc())
        .limit(limit)
        .all()
    )
