"""단골 회원 · 선불 충전 API (백엔드 B)

[한글 주석] 손님용 조회(/public/balance/{token})만 인증이 없다.
그 외 모든 변경은 사장님 인증이 필요하다 — 손님이 직접 차감할 수 있으면
부정 사용이 생기므로 손님 화면은 철저히 읽기 전용이다.
"""
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.core.auth import get_current_user, require_owner
from app.core.database import get_db
from app.models.membership import ChargePlan, Customer
from app.models.user import User
from app.schemas.membership import (
    AdjustRequest, BalanceResult, ChargePlanCreate, ChargePlanOut, ChargeRequest,
    ChurnRiskCustomer, CustomerCreate, CustomerOut, CustomerUpdate,
    PrepaidSummary, PublicBalanceOut, RefundEstimate, RefundRequest,
    TransactionOut, UseRequest,
)
from app.services import membership_service as svc

router = APIRouter(prefix="/membership", tags=["단골 회원 · 선불 충전 (Membership)"])


def _tx_out(tx) -> TransactionOut:
    # [한글 주석] 환불은 잔액 차감분이 아니라 실제로 건넨 현금을 보여줘야 한다.
    # 화면마다 이 판단을 반복하면 한 곳이 틀려도 모른다. 서버가 정해서 내려준다.
    if tx.tx_type == "REFUND" and tx.paid_amount is not None:
        display = tx.paid_amount
    else:
        display = abs(tx.amount)
    return TransactionOut(
        display_amount=display,
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


@router.get("/store-qr", summary="계산대 QR (손님이 자기 폰으로 찍는다)")
def store_qr_api(db: Session = Depends(get_db), user: User = Depends(require_owner)):
    """[한글 주석] 계산대에 붙여둘 QR입니다.

    손님 QR을 사장님 앱이 읽으려면 앱에 카메라가 필요하고 네이티브 재빌드를 해야 합니다.
    방향을 뒤집어, 매장에 QR을 붙여두고 손님이 자기 폰의 기본 카메라로 찍게 했습니다.
    iOS·안드로이드 모두 기본 카메라가 QR을 인식해 브라우저를 열어줍니다.

    SVG로 주는 이유는 인쇄 때문입니다. 확대해도 깨지지 않아
    A4로 뽑아 붙여도 스캔이 잘 됩니다.
    """
    qr = svc.get_or_create_store_qr(db, user.email)
    url = svc.store_checkin_url(qr.token)
    return {
        "token": qr.token,
        "url": url,
        "svg": svc.qr_svg(url),
        "store_name": getattr(user, "store_name", None),
        "guide": "이 QR을 계산대에 붙여 두세요. 손님이 폰 카메라로 찍으면 결제 요청이 사장님 화면에 뜹니다.",
    }


@router.get("/checkins", summary="결제 요청 대기 목록")
def list_checkins_api(db: Session = Depends(get_db),
                      user: User = Depends(get_current_user)):
    """[한글 주석] 손님이 QR을 찍고 '결제 요청'을 누른 목록입니다.
    20분이 지난 요청은 자동으로 정리됩니다 — 누르고 그냥 가신 분이
    계속 남아 있으면 직원이 헷갈립니다."""
    return svc.list_waiting_checkins(db, user.email)


@router.post("/checkins/{checkin_id}/dismiss", summary="결제 요청 무시")
def dismiss_checkin_api(checkin_id: int, db: Session = Depends(get_db),
                        user: User = Depends(get_current_user)):
    from app.models.membership import CHECKIN_CANCELED
    if not svc.resolve_checkin(db, user.email, checkin_id, CHECKIN_CANCELED):
        raise HTTPException(status_code=404, detail="요청을 찾을 수 없습니다.")
    return {"success": True}


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
                    user: User = Depends(require_owner)):
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
                    user: User = Depends(require_owner)):
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
    tx, msg = svc.use(db, c, payload.amount, payload.memo, payload.menu_id)
    if not tx:
        raise HTTPException(status_code=400, detail=msg)
    return _balance_result(c, tx, user)


@router.get("/customers/{customer_id}/refund-estimate", response_model=RefundEstimate,
            summary="환불 기준액 (보너스 제외)")
def refund_estimate_api(customer_id: int, db: Session = Depends(get_db),
                        user: User = Depends(require_owner)):
    """[한글 주석] 6만원을 적립받았어도 실제 낸 돈은 5만원입니다.
    잔액을 전액 현금으로 돌려주면 매장이 손해를 보므로 결제액 비율을 곱해
    기준액을 제시합니다. 강제하지는 않습니다 — 환불 기준은 약관과 매장 정책,
    나아가 법적 판단의 영역이라 근거가 되는 숫자만 드립니다."""
    c = _get_customer(db, customer_id, user.email)
    return RefundEstimate(**svc.refundable_estimate(db, c))


@router.post("/customers/{customer_id}/refund", response_model=BalanceResult,
             summary="잔액 환불 (현금으로 돌려줌)")
def refund_api(customer_id: int, payload: RefundRequest,
               db: Session = Depends(get_db), user: User = Depends(require_owner)):
    """[한글 주석] 환불은 매출이 아니라 받아둔 선수금을 돌려주는 것입니다.
    보정(ADJUST)으로 때우면 장부에서 환불인지 실수 정정인지 구분되지 않아
    "환불을 얼마나 해줬나"에 답할 수 없게 됩니다."""
    c = _get_customer(db, customer_id, user.email)
    tx, msg = svc.refund(db, c, payload.amount, payload.memo)
    if not tx:
        raise HTTPException(status_code=400, detail=msg)
    return _balance_result(c, tx, user)


@router.post("/customers/{customer_id}/adjust", response_model=BalanceResult,
             summary="잔액 수동 보정 (사유 필수)")
def adjust_api(customer_id: int, payload: AdjustRequest,
               db: Session = Depends(get_db), user: User = Depends(require_owner)):
    c = _get_customer(db, customer_id, user.email)
    tx, msg = svc.adjust(db, c, payload.amount, payload.memo)
    if not tx:
        raise HTTPException(status_code=400, detail=msg)
    return _balance_result(c, tx, user)


# --- 집계 ---

@router.get("/summary", response_model=PrepaidSummary,
            summary="선수금 현황 (매출과 분리된 부채 집계)")
def summary_api(days: int = Query(30, ge=1, le=365), db: Session = Depends(get_db),
                user: User = Depends(require_owner)):
    """[한글 주석] 충전액은 매출이 아니라 부채다.
    아직 커피를 안 줬으니 언제든 돌려줘야 할 빚이고, 커피가 나갈 때 매출이 된다.
    섞어 보면 충전 많은 날 매출이 뛴 것처럼 착각하게 된다."""
    return PrepaidSummary(**svc.get_prepaid_summary(db, user.email, days))


@router.get("/churn-risk", response_model=List[ChurnRiskCustomer],
            summary="뜸해진 단골 (평소 주기 대비)")
def churn_risk_api(limit: int = Query(20, ge=1, le=100), db: Session = Depends(get_db),
                   user: User = Depends(require_owner)):
    """[한글 주석] '2주 이상'처럼 고정 기준을 쓰지 않는다.
    매일 오던 손님의 2주 공백은 이미 늦었고, 격주 손님의 2주는 정상이다.
    각자의 평소 주기(중앙값) 대비로 판단한다."""
    return [ChurnRiskCustomer(**x) for x in
            svc.find_churn_risk(db, user.email, limit, getattr(user, "store_name", None))]


@router.get("/cost-analysis", summary="선불 고객 실질 원가율")
def cost_analysis_api(days: int = Query(90, ge=7, le=365),
                      db: Session = Depends(get_db),
                      user: User = Depends(require_owner)):
    """[한글 주석] 선불 회원제가 남는 장사인지 판단하는 숫자입니다.

    메뉴판 원가율만 보면 충전 보너스로 깎인 몫이 안 보입니다.
    아메리카노 3,000원/원가 900원이면 원가율 30%지만,
    5만원에 6만원을 적립해 줬다면 손님이 실제로 낸 돈은 2,500원이라
    실질 원가율은 36%입니다. 이 6%p가 통째로 가려집니다.

    일반 판매 원가율과 나란히 보여 차이를 드러냅니다.
    """
    return svc.get_prepaid_cost_analysis(db, user.email, days)


@router.get("/reconcile", summary="잔액 검증 (캐시 vs 거래이력)")
def reconcile_api(db: Session = Depends(get_db), user: User = Depends(require_owner)):
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
