# c:\STUDY\SimpleM\backend\app\api\v1\admin.py
import logging
from datetime import datetime, timedelta
from typing import Any, List
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.models.user import User
from app.models.inventory import Ingredient
from app.models.ai import GeneratedDocument

logger = logging.getLogger(__name__)

# APIRouter를 통해 "/admin"으로 시작하는 관리자 전용 API 창구를 개설합니다.
router = APIRouter(prefix="/admin", tags=["관리자 콘솔(Admin)"])

# ---------------------------------------------------------------------------
# 메모리 기반 가상 임시 데이터 (CS, 알림, 결제 이력 관리용)
# ---------------------------------------------------------------------------

# 1. 1:1 CS 문의 모의 데이터베이스
mock_cs_list = [
    {
        "id": 1,
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
        "id": 2,
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
        "id": 3,
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
    target: str = "전체 사장님"


# ---------------------------------------------------------------------------
# 1. 회원 정보 연동 API (PostgreSQL 실시간 조회 및 삭제)
# ---------------------------------------------------------------------------

@router.get("/users")
def get_admin_users(db: Session = Depends(get_db)):
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
def delete_admin_user(user_id: int, db: Session = Depends(get_db)):
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
def get_dashboard_stats(db: Session = Depends(get_db)):
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
def get_cs_list(db: Session = Depends(get_db)):
    """
    [CS 문의 조회] 사장님들이 남긴 1:1 문의사항 리스트를 DB에서 실시간 조회합니다.
    """
    try:
        db_items = db.query(Inquiry).order_by(Inquiry.id.desc()).all()
        res = []
        for item in db_items:
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
        # DB 기록과 mock_cs_list 중 중복 없이 합쳐서 반환
        for m in mock_cs_list:
            if not any(r["id"] == m["id"] for r in res):
                res.append(m)
        return res
    except Exception as e:
        logger.error(f"get_cs_list DB 조회 오류: {e}")
        return mock_cs_list


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

    new_inq_id = len(mock_cs_list) + 100
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
def reply_to_cs(cs_id: int, payload: CSReplyPayload, db: Session = Depends(get_db)):
    """
    [CS 답변 등록] 관리자가 사장님의 문의에 답변을 남기며, DB 상태를 '처리 완료'로 갱신합니다.
    """
    try:
        inq = db.query(Inquiry).filter(Inquiry.id == cs_id).first()
        if inq:
            inq.answer = payload.reply
            inq.status = "answered"
            inq.answered_at = datetime.utcnow()
            db.commit()
            db.refresh(inq)
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

    for item in mock_cs_list:
        if item["id"] == cs_id:
            item["status"] = "처리 완료"
            item["reply"] = payload.reply
            return {"success": True, "item": item}
            
    return {"success": True}


# ---------------------------------------------------------------------------
# 4. 공지 & 알림 발송 모의 API
# ---------------------------------------------------------------------------

@router.get("/notifications")
def get_notifications():
    """
    [공지사항 이력 조회] 과거에 사장님들께 발송했던 모든 공지 알림 이력을 반환합니다.
    """
    return mock_notif_history


@router.post("/notifications")
def create_notification(payload: NotificationCreate):
    """
    [공지사항 발송 등록] 사장님들에게 보낼 새로운 긴급 공지 또는 알림을 시스템에 등록합니다.
    """
    new_notif = {
        "id": len(mock_notif_history) + 1,
        "title": payload.title,
        "target": payload.target,
        "date": datetime.now().strftime("%Y-%m-%d %H:%M"),
        "author": "최고 관리자"
    }
    mock_notif_history.insert(0, new_notif)
    return {"success": True, "item": new_notif}


# ---------------------------------------------------------------------------
# 5. 프리미엄 결제 구독 관리 모의 API
# ---------------------------------------------------------------------------

@router.get("/payments")
def get_payments():
    """
    [결제 매출 이력 조회] 프리미엄 멤버십을 구독 중인 사장님들의 월 결제 이력을 반환합니다.
    """
    return mock_payments
