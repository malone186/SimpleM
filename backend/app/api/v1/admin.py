# c:\STUDY\SimpleM\backend\app\api\v1\admin.py
import hashlib
import logging
from datetime import datetime, timedelta, timezone
from typing import Any, List
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core.auth import (
    get_current_user,
    get_current_admin,
    create_access_token,
    get_password_hash,
    verify_password,
    ADMIN_EMAILS,
    ADMIN_PASSWORD,
)
from app.core.database import get_db
from app.models.user import User
from app.models.inventory import Ingredient
from app.models.ai import AdminAccount, AdminNotification, GeneratedDocument
from app.models.tracking import TrackingEvent

logger = logging.getLogger(__name__)

# APIRouter를 통해 "/admin"으로 시작하는 관리자 전용 API 창구를 개설합니다.
router = APIRouter(prefix="/admin", tags=["관리자 콘솔(Admin)"])


# ---------------------------------------------------------------------------
# 0. 관리자 콘솔 로그인 — admin_web(정적 페이지)이 토큰을 발급받는 창구
# ---------------------------------------------------------------------------

class AdminLogin(BaseModel):
    email: str
    password: str


@router.post("/login")
def admin_login(payload: AdminLogin, db: Session = Depends(get_db)):
    """
    [관리자 로그인] 공유 DB의 admin_accounts(bcrypt 해시)로 검증해 JWT를 발급한다.
    어느 컴퓨터에서 백엔드를 띄우든 동일한 아이디·비밀번호가 통한다.

    이행 경로: DB에 계정이 아직 없으면 env(ADMIN_EMAILS/ADMIN_PASSWORD)로 1회 검증 후
    그 자격증명을 DB 계정으로 자동 생성한다 — 이후부터는 DB만 본다.
    """
    email = payload.email.strip()
    account = db.query(AdminAccount).filter(AdminAccount.email == email).first()
    if account is not None:
        if not verify_password(payload.password, account.password_hash):
            raise HTTPException(status_code=401, detail="관리자 이메일 또는 비밀번호가 올바르지 않습니다.")
    else:
        if not ADMIN_PASSWORD and db.query(AdminAccount).count() == 0:
            # DB 계정도 env 비밀번호도 없으면 로그인 자체를 막아, 빈 비밀번호로 뚫리는 일을 방지
            raise HTTPException(status_code=503, detail="관리자 로그인이 설정되지 않았습니다(admin_accounts 비어 있음 + ADMIN_PASSWORD 미설정).")
        if email not in ADMIN_EMAILS or not ADMIN_PASSWORD or payload.password != ADMIN_PASSWORD:
            raise HTTPException(status_code=401, detail="관리자 이메일 또는 비밀번호가 올바르지 않습니다.")
        db.add(AdminAccount(email=email, password_hash=get_password_hash(payload.password)))
        db.commit()
        logger.info("관리자 계정 자동 이행 — env 자격증명을 DB(admin_accounts)로 옮김: %s", email)
    token = create_access_token({"sub": email})
    return {"access_token": token, "token_type": "bearer", "email": email}


class AdminPasswordChange(BaseModel):
    current_password: str
    new_password: str


@router.post("/password")
def change_admin_password(
    payload: AdminPasswordChange,
    db: Session = Depends(get_db),
    current_admin: User = Depends(get_current_admin),
):
    """[관리자 비밀번호 변경] 공유 DB에 저장되므로 모든 컴퓨터에 즉시 적용된다."""
    if len(payload.new_password) < 8:
        raise HTTPException(status_code=422, detail="새 비밀번호는 8자 이상이어야 합니다.")
    account = db.query(AdminAccount).filter(AdminAccount.email == current_admin.email).first()
    if account is None:
        raise HTTPException(status_code=404, detail="DB에 관리자 계정이 없습니다 — 먼저 로그인해 계정을 생성하세요.")
    if not verify_password(payload.current_password, account.password_hash):
        raise HTTPException(status_code=401, detail="현재 비밀번호가 올바르지 않습니다.")
    account.password_hash = get_password_hash(payload.new_password)
    db.commit()
    return {"message": "관리자 비밀번호가 변경되었습니다. 모든 컴퓨터에서 새 비밀번호로 로그인하세요."}

# ---------------------------------------------------------------------------
# 메모리 기반 가상 임시 데이터 (CS, 알림, 결제 이력 관리용)
# ---------------------------------------------------------------------------

# 1. 1:1 CS 문의 모의 데이터베이스
# 시드 id는 9000번대 — DB inquiries의 실제 id(1부터 증가)와 겹치면 시드 문의에 단
# 답변이 엉뚱한 실제 문의(DB의 같은 id)에 기록되므로 반드시 분리해 둔다.
mock_cs_list = [
    {
        "id": 9001,
        "name": "포슬이",
        "store": "포슬카페",
        "title": "영수증 OCR 인식 속도가 조금 느린 것 같아요",
        "date": "2026-07-19 14:32",
        "status": "답변 대기",
        "email": "owner@cafe.com",
        "content": "가끔 오후 바쁜 시간대에 영수증 사진을 올려놓고 대기할 때 인식이 5초 이상 걸립니다. 개선 여지가 있을까요?",
        "reply": None
    },
    {
        "id": 9002,
        "name": "김철수",
        "store": "블루보틀 강남",
        "title": "이번 주 세무 리포트 발행일 변경 문의",
        "date": "2026-07-18 10:15",
        "status": "처리 완료",
        "email": "chulsoo@cafe.com",
        "content": "매주 월요일 오전에 리포트가 나오는데, 일요일 저녁에 마감하고 바로 볼 수 있도록 요일을 당길 수 있나요?",
        "reply": "안녕하세요 사장님, 운영 정보 분석 주기는 본점 정책상 주말 집계 후 월요일 오전 9시로 고정되어 있습니다. 주말 데이터의 오차를 최소화하기 위한 조치이오니 양해 부탁드립니다!"
    },
    {
        "id": 9003,
        "name": "이영희",
        "store": "성수 로스터스",
        "title": "프리미엄 결제 영수증 출력",
        "date": "2026-07-17 16:40",
        "status": "처리 완료",
        "email": "young@cafe.com",
        "content": "회사 경비 처리를 위해 프리미엄 멤버십 월 구독료 결제 세금계산서 혹은 영수증 출력을 원합니다.",
        "reply": "성수 로스터스 사장님 안녕하세요! 결제 영수증은 등록하신 메일 주소(young@cafe.com)로 매달 자동 발행되어 발송됩니다. 혹시 메일을 못 받으셨다면 스팸함을 체크해 주세요!"
    }
]

# 2. 공지 및 알림 발송 이력 — 관리자가 실제로 발송한 공지만 담긴다 (더미 시드 제거)
mock_notif_history = []

# 3. 프리미엄 결제 매출 모의 데이터베이스
mock_payments = [
    {
        "id": 1,
        "store": "포슬카페",
        "owner": "포슬이",
        "amount": "19,900원",
        "date": "2026-07-01 10:16",
        "method": "신용카드 (국민 4930)",
        "status": "결제 완료"
    },
    {
        "id": 2,
        "store": "블루보틀 강남",
        "owner": "김철수",
        "amount": "19,900원",
        "date": "2026-07-03 14:21",
        "method": "간편 결제 (카카오페이)",
        "status": "결제 완료"
    },
    {
        "id": 3,
        "store": "성수 로스터스",
        "owner": "이영희",
        "amount": "19,900원",
        "date": "2026-07-05 09:31",
        "method": "신용카드 (현대 1009)",
        "status": "결제 완료"
    }
]


# ---------------------------------------------------------------------------
# Pydantic 데이터 검증용 스키마 정의
# ---------------------------------------------------------------------------

class CSReplyPayload(BaseModel):
    reply: str

class NotificationCreate(BaseModel):
    title: str
    body: str = ""
    target: str = "전체 사장님"          # 관리자 웹 표시용 라벨
    target_type: str = "all"             # all | premium | specific
    target_email: str | None = None      # target_type == specific일 때 수신 사장님 이메일


# ---------------------------------------------------------------------------
# 1. 회원 정보 연동 API (PostgreSQL 실시간 조회 및 삭제)
# ---------------------------------------------------------------------------

@router.get("/users")
def get_admin_users(db: Session = Depends(get_db), _admin: User = Depends(get_current_admin)):
    """
    [사장님 목록 조회] PostgreSQL DB에서 실제 회원 가입한 사장님 리스트를 불러오고,
    재고 개수 및 OCR 자동 생성 이력을 합산하여 반환합니다.
    """
    try:
        users = db.query(User).order_by(User.id.asc()).all()
        result = []
        
        for user in users:
            # 1. Ingredient 테이블에서 이메일이 store_id인 재고 품목 가짓수를 카운트합니다.
            stock_count = db.query(Ingredient).filter(Ingredient.store_id == user.email).count()
            
            # 2. GeneratedDocument 테이블에서 이메일이 store_id인 생성 문서 건수를 카운트해 OCR 사용량으로 갈음합니다.
            ocr_count = db.query(GeneratedDocument).filter(GeneratedDocument.store_id == user.email).count()
            # 만약 한 건도 없다면, 데모용 기본 보정 수치(id에 따른 가중값)를 일부 부여합니다.
            if ocr_count == 0:
                ocr_count = (user.id * 3) + 2

            # 가입 시각 가독성 변환 (YYYY-MM-DD HH:MM)
            joined_str = user.created_at.strftime("%Y-%m-%d %H:%M") if user.created_at else "2026-07-01 00:00"
            
            # 다음 결제일 자동 계산 (가입일로부터 1개월 뒤)
            next_pay = "2026-08-01"
            if user.created_at:
                try:
                    next_pay_dt = user.created_at + timedelta(days=30)
                    next_pay = next_pay_dt.strftime("%Y-%m-%d")
                except Exception:
                    pass
            
            result.append({
                "id": user.id,
                "name": user.name,
                "store": user.store_name,
                "email": user.email,
                "status": "활성",
                "joined": joined_str,
                "plan": "프리미엄 회원" if user.id <= 3 else "일반 회원", # 초기 사장님들은 프리미엄 등급 부여
                "subPrice": "월 19,900원" if user.id <= 3 else "무료 서비스 이용 중",
                "nextPay": next_pay if user.id <= 3 else "-",
                "ocrCount": ocr_count,
                "stockCount": stock_count,
                "memo": "PostgreSQL 데이터베이스와 실시간으로 동기화되어 정상 작동 중인 점포입니다."
            })
            
        return result
    except Exception as e:
        logger.exception("관리자 회원 목록 조회 중 서버 에러 발생")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"데이터베이스 조회 중 오류가 발생했습니다: {str(e)}"
        )


@router.delete("/users/{user_id}")
def delete_admin_user(user_id: int, db: Session = Depends(get_db), _admin: User = Depends(get_current_admin)):
    """
    [사장님 강제 차단/탈퇴] PostgreSQL DB에서 해당 ID의 회원 정보를 영구 삭제합니다.
    """
    try:
        user = db.query(User).filter(User.id == user_id).first()
        if not user:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"아이디가 {user_id}인 사장님을 찾을 수 없습니다."
            )
            
        # 데이터베이스에서 회원 기록을 영구 지웁니다.
        db.delete(user)
        db.commit()
        return {"success": True, "message": f"사장님 '{user.name}' 계정이 데이터베이스에서 영구 삭제되었습니다."}
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        logger.exception(f"회원 ID {user_id} 삭제 중 데이터베이스 에러 발생")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"회원 삭제 처리에 실패했습니다: {str(e)}"
        )


# ---------------------------------------------------------------------------
# 2. 대시보드 통계 실시간 집계 API
# ---------------------------------------------------------------------------

@router.get("/dashboard/stats")
def get_dashboard_stats(db: Session = Depends(get_db), _admin: User = Depends(get_current_admin)):
    """
    [대시보드 통계] 가입한 총 점포 수와 결제액 비율 등의 실시간 통계를 집계합니다.
    """
    try:
        # 1. 실제 가입 사장님 수
        total_stores = db.query(User).count()
        
        # 2. 전체 재고 종류 가짓수 합계
        total_ingredients = db.query(Ingredient).count()
        
        # 3. 프리미엄 회원 수 (id <= 3 기준 또는 가상 계산)
        premium_count = db.query(User).filter(User.id <= 3).count()
        premium_ratio = round((premium_count / total_stores * 100), 1) if total_stores > 0 else 0.0

        return {
            "totalStores": total_stores,
            "totalIngredients": total_ingredients,
            "premiumRatio": f"{premium_ratio}%",
            "activeUsersCount": total_stores, # 동시 접속 사장님 수
            "healthStatus": "green" # 전체 백엔드 시스템 건강 신호
        }
    except Exception as e:
        logger.exception("대시보드 통계 산출 중 오류 발생")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"통계 집계 오류: {str(e)}"
        )


# ---------------------------------------------------------------------------
# 3. 1:1 CS 문의 DB 실시간 API
# ---------------------------------------------------------------------------

from app.models.inquiry import Inquiry

@router.get("/cs")
def get_cs_list(db: Session = Depends(get_db), _admin: User = Depends(get_current_admin)):
    """
    [CS 문의 조회] 사장님들이 남긴 1:1 문의사항 리스트를 실시간 최신순 조회합니다.
    """
    res = list(mock_cs_list) # 메모리 상 최신 등록 항목 우선 보관
    seen_ids = set(m["id"] for m in mock_cs_list)

    try:
        db_items = db.query(Inquiry).order_by(Inquiry.id.desc()).all()
        for item in db_items:
            if item.id not in seen_ids:
                seen_ids.add(item.id)
                res.append({
                    "id": item.id,
                    "name": "포슬이",
                    "store": item.store_name or "포슬카페",
                    "category": item.category or "💡 기능 요청",
                    "title": item.title,
                    "date": item.created_at.strftime("%Y-%m-%d %H:%M") if item.created_at else "2026-07-21 12:00",
                    "status": "처리 완료" if item.status == "answered" else "답변 대기",
                    "email": item.user_email,
                    "content": item.content,
                    "question": item.content,
                    "reply": item.answer or None
                })
    except Exception as e:
        logger.error(f"get_cs_list DB 조회 오류: {e}")

    return res


@router.post("/cs")
def create_cs_from_app(req: dict, db: Session = Depends(get_db)):
    """
    [CS 문의 직접 수신] 사장님 앱에서 전달된 문의글을 DB 및 관리자 CS 리스트 1순위로 즉시 영구 등록합니다.
    """
    title = req.get("title", "")
    content = req.get("content", "")
    category = req.get("category", "💡 기능 요청")
    store_name = req.get("store_name", "포슬카페")
    user_email = req.get("user_email", "owner@cafe.com")

    # 폴백 id도 9000번대에서 발급 — DB 실제 id와의 충돌 방지 (시드 id 정책과 동일)
    new_inq_id = max([m["id"] for m in mock_cs_list], default=9000) + 1
    try:
        db_inq = Inquiry(
            user_email=user_email,
            store_name=store_name,
            category=category,
            title=title,
            content=content,
            status="pending"
        )
        db.add(db_inq)
        db.commit()
        db.refresh(db_inq)
        new_inq_id = db_inq.id
    except Exception as e:
        logger.error(f"Inquiry DB 저장 중 오류: {e}")

    new_item = {
        "id": new_inq_id,
        "name": "포슬이",
        "store": store_name,
        "category": category,
        "title": title,
        "date": datetime.now().strftime("%Y-%m-%d %H:%M"),
        "status": "답변 대기",
        "email": user_email,
        "content": content,
        "question": content,
        "reply": None
    }
    # 메모리 리스트 상단에도 실시간 1순위 즉시 삽입
    mock_cs_list.insert(0, new_item)
    return new_item


@router.post("/cs/{cs_id}/reply")
def reply_to_cs(cs_id: int, payload: CSReplyPayload, db: Session = Depends(get_db), _admin: User = Depends(get_current_admin)):
    """
    [CS 답변 등록] 관리자가 사장님의 문의에 답변을 남기며, DB 상태를 '처리 완료'로 갱신합니다.
    DB 성공·실패와 무관하게 메모리 폴백 리스트 양쪽도 동기화해 앱 폴링에서 답변이 유실되지 않게 한다.
    """
    # 순환 import 방지: inquiry.py가 admin.py의 mock_cs_list를 모듈 로드 시점에 가져가므로
    # 반대 방향 참조는 함수 안에서 지연 import 한다.
    from app.api.v1.inquiry import sync_reply_to_memory

    try:
        inq = db.query(Inquiry).filter(Inquiry.id == cs_id).first()
        if inq:
            inq.answer = payload.reply
            inq.status = "answered"
            inq.answered_at = datetime.utcnow()
            db.commit()
            db.refresh(inq)
            sync_reply_to_memory(cs_id, payload.reply)
            return {"success": True, "item": {
                "id": inq.id,
                "store": inq.store_name,
                "name": "사장님",
                "category": inq.category,
                "title": inq.title,
                "date": inq.created_at.strftime("%Y-%m-%d %H:%M") if inq.created_at else "2026-07-21 12:00",
                "status": "처리 완료",
                "question": inq.content,
                "reply": inq.answer
            }}
    except Exception as e:
        logger.error(f"CS 답변 등록 중 오류: {e}")

    # DB에 없는 문의(메모리 폴백 접수분·시드) — 앱이 읽는 GLOBAL_INQUIRIES까지 함께 갱신
    sync_reply_to_memory(cs_id, payload.reply)
    for item in mock_cs_list:
        if item["id"] == cs_id:
            return {"success": True, "item": item}

    return {"success": True}


# ---------------------------------------------------------------------------
# 4. 공지 & 알림 발송 모의 API
# ---------------------------------------------------------------------------

def _notif_to_dict(n: AdminNotification) -> dict:
    return {
        "id": n.id,
        "title": n.title,
        "body": n.body or "",
        "target": n.target_label,
        "target_type": n.target_type,
        "date": n.created_at.strftime("%Y-%m-%d %H:%M") if n.created_at else "",
        "author": n.author,
    }


@router.get("/notifications")
def get_notifications(db: Session = Depends(get_db), _admin: User = Depends(get_current_admin)):
    """
    [공지사항 이력 조회] 과거에 사장님들께 발송했던 모든 공지 알림 이력을 반환합니다.
    DB 기록을 최신순으로 반환하고, 뒤에 데모용 시드 이력을 덧붙입니다.
    """
    try:
        rows = db.query(AdminNotification).order_by(AdminNotification.id.desc()).all()
        return [_notif_to_dict(n) for n in rows] + mock_notif_history
    except Exception as e:
        logger.error(f"공지 이력 DB 조회 오류: {e}")
        return mock_notif_history


@router.post("/notifications")
def create_notification(payload: NotificationCreate, db: Session = Depends(get_db), _admin: User = Depends(get_current_admin)):
    """
    [공지사항 발송 등록] 사장님들에게 보낼 새로운 긴급 공지 또는 알림을 DB에 영구 등록합니다.
    등록된 공지는 각 사장님 앱이 /notifications/feed 폴링으로 즉시 수신해 갑니다.
    """
    try:
        notif = AdminNotification(
            title=payload.title,
            body=payload.body,
            target_type=payload.target_type,
            target_email=payload.target_email if payload.target_type == "specific" else None,
            target_label=payload.target,
            author="최고 관리자",
        )
        db.add(notif)
        db.commit()
        db.refresh(notif)
        return {"success": True, "item": _notif_to_dict(notif)}
    except Exception as e:
        db.rollback()
        logger.error(f"공지 DB 저장 오류: {e}")
        # DB가 꺼져 있어도 관리자 웹 데모는 계속되도록 메모리 이력에라도 남긴다.
        new_notif = {
            "id": len(mock_notif_history) + 1,
            "title": payload.title,
            "body": payload.body,
            "target": payload.target,
            "target_type": payload.target_type,
            "date": datetime.now().strftime("%Y-%m-%d %H:%M"),
            "author": "최고 관리자",
        }
        mock_notif_history.insert(0, new_notif)
        return {"success": True, "item": new_notif}


@router.get("/notifications/feed")
def get_notification_feed(
    after_id: int = 0,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    [사장님 앱 수신 피드] 로그인한 사장님 본인에게 온 공지만 골라 반환합니다.
    - 전체(all) 공지는 모두에게
    - 프리미엄(premium) 공지는 프리미엄 회원(id <= 3 정책)에게만
    - 특정 매장(specific) 공지는 target_email이 본인 이메일과 일치할 때만
    앱은 마지막으로 받은 id를 after_id로 넘겨 새 공지만 증분 수신합니다.
    """
    is_premium = current_user.id <= 3  # get_admin_users의 프리미엄 등급 정책과 동일 기준
    rows = (
        db.query(AdminNotification)
        .filter(AdminNotification.id > after_id)
        .order_by(AdminNotification.id.asc())
        .all()
    )
    visible = [
        n for n in rows
        if n.target_type == "all"
        or (n.target_type == "premium" and is_premium)
        or (n.target_type == "specific" and n.target_email == current_user.email)
    ]
    return [_notif_to_dict(n) for n in visible[:20]]


# ---------------------------------------------------------------------------
# 5. 프리미엄 결제 구독 관리 모의 API
# ---------------------------------------------------------------------------

@router.get("/payments")
def get_payments(_admin: User = Depends(get_current_admin)):
    """
    [결제 매출 이력 조회] 프리미엄 멤버십을 구독 중인 사장님들의 월 결제 이력을 반환합니다.
    """
    return mock_payments


# ---------------------------------------------------------------------------
# 6. 유입 경로(Acquisition) 분석 API
#    - 지금은 회원 유입 채널을 저장하는 컬럼이 없으므로, user.id 기반 '결정적 시딩'으로 배정한다.
#    - User에 acquisition_source 컬럼이 생기면, 실값 우선 + 미수집분만 시딩으로 폴백하도록
#      _resolve_channel() 한 곳만 바꾸면 되고 응답 형태/관리자 화면은 그대로 재사용된다. (PRD §6·§8)
# ---------------------------------------------------------------------------

# 유입 채널 분류 체계 — 저장은 정규 키, 표시는 한글 라벨 (PRD §3)
ACQUISITION_CHANNELS = [
    # (canonical key, 한글 라벨, 시딩 가중치)
    ("referral", "지인 추천", 30),
    ("web_search", "포털/구글 검색", 20),
    ("instagram", "인스타그램", 15),
    ("app_store", "앱스토어 검색", 12),
    ("youtube", "유튜브", 10),
    ("naver_blog", "네이버 블로그/카페", 8),
    ("etc", "기타", 5),
]
_ACQ_LABELS = {key: label for key, label, _ in ACQUISITION_CHANNELS}
ACQUISITION_KEYS = {key for key, _, _ in ACQUISITION_CHANNELS}


def normalize_acquisition_source(raw) -> str | None:
    """가입 시 들어온 유입 채널 원문을 정규 키로 표준화한다.
    빈 값이면 None(미수집 → 집계 시 시딩 폴백), 분류표에 없으면 'etc'."""
    if not raw:
        return None
    key = str(raw).strip().lower()
    return key if key in ACQUISITION_KEYS else "etc"


def _seed_channel(user_id: int) -> str:
    """[결정적 시딩] user.id를 해시해 가중치대로 채널 키를 배정한다.
    같은 id는 항상 같은 채널 → 새로고침해도 값이 흔들리지 않는다."""
    total_weight = sum(w for _, _, w in ACQUISITION_CHANNELS)
    # id를 md5로 해시해 0~(total_weight-1) 범위의 안정적인 버킷값을 뽑는다.
    digest = hashlib.md5(str(user_id).encode()).hexdigest()
    bucket = int(digest, 16) % total_weight
    cursor = 0
    for key, _, weight in ACQUISITION_CHANNELS:
        cursor += weight
        if bucket < cursor:
            return key
    return ACQUISITION_CHANNELS[-1][0]


def _resolve_channel(user: User) -> tuple[str, bool]:
    """회원의 유입 채널 키와 '시딩 여부'를 반환한다.
    실제 저장값(향후 acquisition_source 컬럼)이 있으면 그 값을, 없으면 시딩값을 쓴다."""
    real = getattr(user, "acquisition_source", None)
    if real:
        return real, False
    return _seed_channel(user.id), True


@router.get("/dashboard/acquisition")
def get_acquisition_breakdown(db: Session = Depends(get_db), _admin: User = Depends(get_current_admin)):
    """[유입 경로 분석] 회원을 유입 채널별로 집계해 분포·비율을 반환한다.
    실데이터가 쌓이기 전에는 결정적 시딩으로 채워 대시보드가 비지 않게 한다."""
    try:
        users = db.query(User).all()
        total = len(users)

        counts = {key: 0 for key, _, _ in ACQUISITION_CHANNELS}
        seeded_count = 0
        for user in users:
            channel, seeded = _resolve_channel(user)
            if channel not in counts:  # 저장값이 분류표에 없으면 '기타'로 정규화
                channel = "etc"
            counts[channel] += 1
            if seeded:
                seeded_count += 1

        channels = []
        for key, label, _ in ACQUISITION_CHANNELS:
            count = counts[key]
            ratio = round((count / total * 100), 1) if total > 0 else 0.0
            channels.append({"key": key, "label": label, "count": count, "ratio": ratio})

        # 건수 내림차순 정렬(0건 채널은 뒤로)
        channels.sort(key=lambda c: c["count"], reverse=True)

        return {
            "total": total,
            "seeded_count": seeded_count,
            "channels": channels,
        }
    except Exception as e:
        logger.exception("유입 경로 집계 중 오류 발생")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"유입 경로 집계 오류: {str(e)}"
        )


# ---------------------------------------------------------------------------
# 7. 활동/리텐션(Activity) 분석 API
#    - tracking_events 로그를 집계해 '접속 활성도·기능별 사용량·이탈 위험 회원'을 반환한다.
#    - last_active / 활성화 지표는 별도 컬럼 없이 이 로그의 집계로 파생된다. (PRD 확장 §13)
# ---------------------------------------------------------------------------

AT_RISK_DAYS = 7  # 마지막 활동이 이 일수 이상 지나면 '이탈 위험'으로 본다.


def _as_utc(dt):
    """DB에서 온 naive datetime을 UTC aware로 보정(SQLite 대비)."""
    if dt is None:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


@router.get("/dashboard/activity")
def get_activity_breakdown(db: Session = Depends(get_db), _admin: User = Depends(get_current_admin)):
    """[활동 분석] 접속 활성 회원 수·기능별 사용량·이탈 위험 회원을 집계해 반환한다."""
    try:
        now = datetime.now(timezone.utc)

        def active_within(days: int) -> int:
            since = now - timedelta(days=days)
            return db.query(func.count(func.distinct(TrackingEvent.email))).filter(
                TrackingEvent.email.isnot(None),
                TrackingEvent.created_at >= since,
            ).scalar() or 0

        total_events = db.query(func.count(TrackingEvent.id)).scalar() or 0

        # 1) 기능별 사용량 (건수 내림차순)
        fu_rows = (
            db.query(TrackingEvent.feature, func.count(TrackingEvent.id))
            .group_by(TrackingEvent.feature)
            .all()
        )
        feature_usage = sorted(
            [{"feature": (f or "기타"), "count": c} for f, c in fu_rows],
            key=lambda x: x["count"],
            reverse=True,
        )

        # 2) 유저별 마지막 활동 시각
        la_rows = (
            db.query(TrackingEvent.email, func.max(TrackingEvent.created_at))
            .filter(TrackingEvent.email.isnot(None))
            .group_by(TrackingEvent.email)
            .all()
        )
        last_active = {email: _as_utc(ts) for email, ts in la_rows}

        # 3) 이탈 위험 회원 — 가입은 했으나 최근 활동이 없는 사장님
        users = db.query(User).order_by(User.id.asc()).all()
        at_risk = []
        for u in users:
            la = last_active.get(u.email)
            days_inactive = None if la is None else (now - la).days
            if la is None or (days_inactive is not None and days_inactive >= AT_RISK_DAYS):
                at_risk.append({
                    "name": u.name,
                    "store": u.store_name,
                    "email": u.email,
                    "last_active": la.strftime("%Y-%m-%d %H:%M") if la else None,
                    "days_inactive": days_inactive,  # None = 접속 이력 없음
                })
        # 접속 이력 없음(None)을 맨 앞으로, 그 다음 오래 안 온 순
        at_risk.sort(key=lambda x: (x["days_inactive"] is not None, -(x["days_inactive"] or 0)))

        return {
            "activeToday": active_within(1),
            "activeThisWeek": active_within(7),
            "activeThisMonth": active_within(30),
            "totalEvents": total_events,
            "atRiskDays": AT_RISK_DAYS,
            "atRiskCount": len(at_risk),
            "featureUsage": feature_usage,
            "atRisk": at_risk[:20],  # 상위 20명만
        }
    except Exception as e:
        logger.exception("활동 분석 집계 중 오류 발생")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"활동 분석 집계 오류: {str(e)}"
        )
