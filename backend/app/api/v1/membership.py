"""단골 회원 · 선불 충전 API (백엔드 B)

[한글 주석] 손님용 조회(/public/balance/{token})만 인증이 없다.
그 외 모든 변경은 사장님 인증이 필요하다 — 손님이 직접 차감할 수 있으면
부정 사용이 생기므로 손님 화면은 철저히 읽기 전용이다.
"""
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.core.auth import get_current_user
from app.core.database import get_db
from app.models.membership import ChargePlan, Customer
from app.models.user import User
from app.schemas.membership import (
    AdjustRequest, BalanceResult, ChargePlanCreate, ChargePlanOut, ChargeRequest,
    ChurnRiskCustomer, CustomerCreate, CustomerOut, CustomerUpdate,
    PrepaidSummary, PublicBalanceOut, TransactionOut, UseRequest,
)
from app.services import membership_service as svc

router = APIRouter(prefix="/membership", tags=["단골 회원 · 선불 충전 (Membership)"])


def _tx_out(tx) -> TransactionOut:
    return TransactionOut(
        id=tx.id,
        tx_type=tx.tx_type,
        tx_label=svc.TX_LABELS.get(tx.tx_type, tx.tx_type),
        amount=tx.amount,
        balance_after=tx.balance_after,
        paid_amount=tx.paid_amount,
        memo=tx.memo,
        created_at=tx.created_at,
    )


def _customer_out(db: Session, c: Customer) -> CustomerOut:
    st = svc.visit_stats(db, c.id)
    return CustomerOut(
        id=c.id, phone=c.phone, phone_masked=svc.mask_phone(c.phone),
        name=c.name, balance=c.balance or 0, memo=c.memo,
        is_active=c.is_active, created_at=c.created_at,
        visit_count=st["visit_count"],
        last_visit_at=st["last_visit_at"],
        days_since_visit=st["days_since_visit"],
    )


def _get_customer(db: Session, customer_id: int, store_id: str) -> Customer:
    c = db.query(Customer).filter(Customer.id == customer_id).first()
    if not c or c.store_id != store_id:
        raise HTTPException(status_code=404, detail="회원을 찾을 수 없습니다.")
    return c


# --- 회원 ---

@router.post("/customers", response_model=CustomerOut, summary="단골 회원 등록")
def create_customer_api(payload: CustomerCreate, db: Session = Depends(get_db),
                        user: User = Depends(get_current_user)):
    """[한글 주석] 이미 등록된 번호면 에러 대신 기존 회원을 돌려준다.
    계산대에서 에러가 뜨면 직원이 이름을 바꿔 새로 만들어버려 적립이 갈라진다."""
    customer, msg = svc.create_customer(
        db, user.email, payload.phone, payload.name, payload.memo)
    if not customer:
        raise HTTPException(status_code=400, detail=msg)
    return _customer_out(db, customer)


@router.get("/customers", response_model=List[CustomerOut], summary="회원 검색")
def list_customers_api(
    query: Optional[str] = Query(None, description="이름 또는 번호 뒷자리"),
    limit: int = Query(50, ge=1, le=200),
    db: Session = Depends(get_db), user: User = Depends(get_current_user),
):
    return [_customer_out(db, c) for c in svc.find_customers(db, user.email, query, limit)]


@router.get("/customers/{customer_id}", response_model=CustomerOut, summary="회원 상세")
def get_customer_api(customer_id: int, db: Session = Depends(get_db),
                     user: User = Depends(get_current_user)):
    return _customer_out(db, _get_customer(db, customer_id, user.email))


@router.patch("/customers/{customer_id}", response_model=CustomerOut, summary="회원 수정")
def update_customer_api(customer_id: int, payload: CustomerUpdate,
                        db: Session = Depends(get_db),
                        user: User = Depends(get_current_user)):
    c = _get_customer(db, customer_id, user.email)
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(c, field, value)
    db.commit()
    db.refresh(c)
    return _customer_out(db, c)


@router.get("/customers/{customer_id}/transactions",
            response_model=List[TransactionOut], summary="거래 내역")
def list_transactions_api(customer_id: int, limit: int = Query(30, ge=1, le=200),
                          db: Session = Depends(get_db),
                          user: User = Depends(get_current_user)):
    _get_customer(db, customer_id, user.email)
    return [_tx_out(t) for t in svc.list_transactions(db, customer_id, limit)]


@router.get("/quick-menus", summary="차감용 메뉴 버튼 목록")
def quick_menus_api(limit: int = Query(8, ge=1, le=20), db: Session = Depends(get_db),
                    user: User = Depends(get_current_user)):
    """[한글 주석] 금액을 손으로 치는 대신 메뉴를 눌러 차감하기 위한 목록입니다.
    타이핑이 사라져 빠르고, 오타로 엉뚱한 금액이 빠지는 사고도 막습니다."""
    return svc.quick_menus(db, user.email, limit)


# --- 충전 상품 ---

@router.get("/plans", response_model=List[ChargePlanOut], summary="충전 상품 목록")
def list_plans_api(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    plans = (db.query(ChargePlan)
             .filter(ChargePlan.store_id == user.email)
             .order_by(ChargePlan.pay_amount).all())
    return [ChargePlanOut(
        id=p.id, pay_amount=p.pay_amount, credit_amount=p.credit_amount,
        bonus_amount=p.bonus_amount, discount_rate=p.discount_rate,
        is_active=p.is_active) for p in plans]


@router.post("/plans", response_model=ChargePlanOut, summary="충전 상품 추가")
def create_plan_api(payload: ChargePlanCreate, db: Session = Depends(get_db),
                    user: User = Depends(get_current_user)):
    """[한글 주석] 사장님이 자유롭게 설계한다. 5만원→6만원처럼 미리 정해두면
    할인율이 명확해지고 나중에 구간별 원가율도 볼 수 있다."""
    plan = ChargePlan(store_id=user.email, pay_amount=payload.pay_amount,
                      credit_amount=payload.credit_amount)
    db.add(plan)
    db.commit()
    db.refresh(plan)
    return ChargePlanOut(
        id=plan.id, pay_amount=plan.pay_amount, credit_amount=plan.credit_amount,
        bonus_amount=plan.bonus_amount, discount_rate=plan.discount_rate,
        is_active=plan.is_active)


@router.delete("/plans/{plan_id}", summary="충전 상품 삭제")
def delete_plan_api(plan_id: int, db: Session = Depends(get_db),
                    user: User = Depends(get_current_user)):
    """[한글 주석] 실제로 지우지 않고 비활성화한다.
    이미 이 상품으로 충전한 거래가 남아 있어, 지우면 이력에서 근거가 사라진다."""
    plan = db.query(ChargePlan).filter(ChargePlan.id == plan_id).first()
    if not plan or plan.store_id != user.email:
        raise HTTPException(status_code=404, detail="충전 상품을 찾을 수 없습니다.")
    plan.is_active = False
    db.commit()
    return {"success": True, "message": "충전 상품을 비활성화했습니다."}


# --- 잔액 변동 ---

def _balance_result(c: Customer, tx, user: User) -> BalanceResult:
    return BalanceResult(
        customer_id=c.id, customer_name=c.name, phone=c.phone,
        balance=c.balance or 0, transaction=_tx_out(tx),
        sms_text=svc.build_sms_text(c, tx, getattr(user, "store_name", None)),
        balance_url=svc.balance_url(c),
    )


@router.post("/customers/{customer_id}/charge", response_model=BalanceResult,
             summary="충전 (돈은 카페가 직접 받고 여기엔 기록만)")
def charge_api(customer_id: int, payload: ChargeRequest,
               db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    c = _get_customer(db, customer_id, user.email)
    tx, msg = svc.charge(db, c, payload.charge_plan_id, payload.pay_amount,
                         payload.credit_amount, payload.memo)
    if not tx:
        raise HTTPException(status_code=400, detail=msg)
    return _balance_result(c, tx, user)


@router.post("/customers/{customer_id}/use", response_model=BalanceResult,
             summary="잔액 사용")
def use_api(customer_id: int, payload: UseRequest,
            db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    c = _get_customer(db, customer_id, user.email)
    tx, msg = svc.use(db, c, payload.amount, payload.memo)
    if not tx:
        raise HTTPException(status_code=400, detail=msg)
    return _balance_result(c, tx, user)


@router.post("/customers/{customer_id}/adjust", response_model=BalanceResult,
             summary="잔액 수동 보정 (사유 필수)")
def adjust_api(customer_id: int, payload: AdjustRequest,
               db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    c = _get_customer(db, customer_id, user.email)
    tx, msg = svc.adjust(db, c, payload.amount, payload.memo)
    if not tx:
        raise HTTPException(status_code=400, detail=msg)
    return _balance_result(c, tx, user)


# --- 집계 ---

@router.get("/summary", response_model=PrepaidSummary,
            summary="선수금 현황 (매출과 분리된 부채 집계)")
def summary_api(days: int = Query(30, ge=1, le=365), db: Session = Depends(get_db),
                user: User = Depends(get_current_user)):
    """[한글 주석] 충전액은 매출이 아니라 부채다.
    아직 커피를 안 줬으니 언제든 돌려줘야 할 빚이고, 커피가 나갈 때 매출이 된다.
    섞어 보면 충전 많은 날 매출이 뛴 것처럼 착각하게 된다."""
    return PrepaidSummary(**svc.get_prepaid_summary(db, user.email, days))


@router.get("/churn-risk", response_model=List[ChurnRiskCustomer],
            summary="뜸해진 단골 (평소 주기 대비)")
def churn_risk_api(limit: int = Query(20, ge=1, le=100), db: Session = Depends(get_db),
                   user: User = Depends(get_current_user)):
    """[한글 주석] '2주 이상'처럼 고정 기준을 쓰지 않는다.
    매일 오던 손님의 2주 공백은 이미 늦었고, 격주 손님의 2주는 정상이다.
    각자의 평소 주기(중앙값) 대비로 판단한다."""
    return [ChurnRiskCustomer(**x) for x in
            svc.find_churn_risk(db, user.email, limit, getattr(user, "store_name", None))]


@router.get("/reconcile", summary="잔액 검증 (캐시 vs 거래이력)")
def reconcile_api(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """[한글 주석] 손님 돈이므로 캐시된 잔액과 이력 합계가 어긋나면 즉시 드러나야 한다."""
    return svc.reconcile_balance(db, user.email)


# --- 손님용 (인증 없음, 읽기 전용) ---

@router.get("/public/balance/{token}", response_model=PublicBalanceOut,
            summary="[손님용] 토큰으로 잔액 조회")
def public_balance_api(token: str, db: Session = Depends(get_db)):
    """[한글 주석] 앱 설치도 로그인도 없이 문자로 받은 링크만으로 연다.
    전화번호로 조회하게 두면 남의 번호를 아는 사람이 남의 잔액을 보게 되므로
    추측 불가능한 토큰을 쓴다. 조회만 되고 차감은 불가능하다."""
    c = db.query(Customer).filter(Customer.access_token == token).first()
    if not c or not c.is_active:
        raise HTTPException(status_code=404, detail="유효하지 않은 링크입니다.")

    owner = db.query(User).filter(User.email == c.store_id).first()
    return PublicBalanceOut(
        store_name=getattr(owner, "store_name", None) if owner else None,
        name=c.name,
        balance=c.balance or 0,
        transactions=[_tx_out(t) for t in svc.list_transactions(db, c.id, 20)],
    )
