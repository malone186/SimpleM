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
from app.models.ai import (
    AdminAccount,
    AdminNotification,
    AdminUserNote,
    GeneratedDocument,
    OcrDocument,
)
from app.models.tracking import TrackingEvent
# 관리자 화면에 찍히는 일시는 전부 KST로 통일한다 — DB에는 UTC로 쌓인다.
from app.utils.datetime_kst import fmt_kst, now_kst, utc_now

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

# 1. CS 문의 — 진짜 저장소는 DB(inquiries 테이블)다.
#
# 예전엔 여기에 가짜 문의 3건(포슬이·김철수·이영희)이 시드로 박혀 있었고, 조회 시
# 이 리스트를 먼저 내보낸 뒤 DB 문의를 뒤에 붙였다. 그래서 사장님이 실제로 보낸 문의가
# 가짜 문의 아래로 밀려 "문의가 안 온다"로 보였다. 게다가 메모리라 Cloud Run에서는
# 인스턴스가 바뀌거나 재배포되면 그날 접수분이 통째로 사라졌다.
#
# 지금은 DB가 단일 출처이고, 이 리스트는 DB 쓰기가 실패했을 때만 잠깐 담아 두는
# 버퍼다 (그래서 비어 있는 게 정상).
mock_cs_list: list[dict] = []

# 2. 공지 및 알림 발송 이력 — 관리자가 실제로 발송한 공지만 담긴다 (더미 시드 제거)
mock_notif_history = []

# 3. (삭제됨) 프리미엄 결제 매출 — 유료 플랜 폐지로 결제·구독 개념이 사라졌다.
#    GET /admin/payments 엔드포인트도 함께 제거했다 (항상 빈 배열이라 읽는 곳이 없었다).


# ---------------------------------------------------------------------------
# Pydantic 데이터 검증용 스키마 정의
# ---------------------------------------------------------------------------

class CSReplyPayload(BaseModel):
    reply: str

class NotificationCreate(BaseModel):
    title: str
    body: str = ""
    target: str = "전체 사장님"          # 관리자 웹 표시용 라벨
    target_type: str = "all"             # all | specific (premium은 유료 플랜 폐지로 제거)
    target_email: str | None = None      # target_type == specific일 때 수신 사장님 이메일


class AdminUserStatusUpdate(BaseModel):
    status: str  # 활성 | 대기 | 정지


class AdminUserMemoUpdate(BaseModel):
    memo: str


# 계정 상태로 허용되는 값 — 관리자 웹 드롭다운과 같은 목록이다
USER_STATUSES = ("활성", "대기", "정지")


def _get_or_create_note(db: Session, email: str) -> AdminUserNote:
    """회원의 관리자 노트 행을 가져오거나 없으면 기본값으로 만든다."""
    note = db.query(AdminUserNote).filter(AdminUserNote.user_email == email).first()
    if note is None:
        note = AdminUserNote(user_email=email, status="활성", memo="")
        db.add(note)
    return note


# ---------------------------------------------------------------------------
# 1. 회원 정보 연동 API (PostgreSQL 실시간 조회 및 삭제)
# ---------------------------------------------------------------------------

@router.get("/users")
def get_admin_users(db: Session = Depends(get_db), _admin: User = Depends(get_current_admin)):
    """
    [사장님 목록 조회] 가입한 사장님과 그 매장의 실사용 지표를 DB에서 그대로 읽어 반환한다.

    예전엔 상당수가 지어낸 값이었다 — OCR 건수는 0건이면 `(id*3)+2`로 부풀렸고,
    등급/이용료/다음 결제일은 'id <= 3이면 프리미엄'이라는 근거 없는 규칙, 계정 상태는
    전원 '활성' 고정, 메모는 모든 회원에게 똑같은 안내 문구가 박혀 있었다.
    지금은 세는 건 실제로 세고, 관리자가 정한 값(상태·메모)은 admin_user_notes에서 읽는다.
    """
    try:
        users = db.query(User).order_by(User.id.asc()).all()

        # 매장별 집계를 한 번에 뽑아 회원 수만큼 쿼리가 늘어나지 않게 한다 (Neon RTT 절약)
        stock_counts = dict(
            db.query(Ingredient.store_id, func.count(Ingredient.id))
            .group_by(Ingredient.store_id)
            .all()
        )
        ocr_counts = dict(
            db.query(OcrDocument.store_id, func.count(OcrDocument.id))
            .group_by(OcrDocument.store_id)
            .all()
        )
        doc_counts = dict(
            db.query(GeneratedDocument.store_id, func.count(GeneratedDocument.id))
            .group_by(GeneratedDocument.store_id)
            .all()
        )
        notes = {n.user_email: n for n in db.query(AdminUserNote).all()}

        result = []
        for user in users:
            note = notes.get(user.email)
            result.append({
                "id": user.id,
                "name": user.name,
                "store": user.store_name,
                "email": user.email,
                # 관리자가 손댄 적 없으면 '활성' (admin_user_notes에 행이 없는 상태)
                "status": note.status if note else "활성",
                "joined": fmt_kst(user.created_at, default="-"),
                "ocrCount": int(ocr_counts.get(user.email, 0)),
                "docCount": int(doc_counts.get(user.email, 0)),
                "stockCount": int(stock_counts.get(user.email, 0)),
                "memo": note.memo if note else "",
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
            
        # 관리자 노트도 함께 지운다 — 계정이 사라졌는데 상태·메모만 남으면 유령 데이터가 된다
        db.query(AdminUserNote).filter(AdminUserNote.user_email == user.email).delete()
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


@router.patch("/users/{user_id}/status")
def update_admin_user_status(
    user_id: int,
    payload: AdminUserStatusUpdate,
    db: Session = Depends(get_db),
    _admin: User = Depends(get_current_admin),
):
    """[계정 상태 변경] 활성/대기/정지를 DB에 저장한다.

    예전엔 관리자 웹에서 드롭다운만 바꾸고 "가상 업데이트되었습니다"라는 알림을 띄운 뒤
    새로고침하면 원래대로 돌아왔다 — 아무 데도 저장하지 않았기 때문이다.
    """
    if payload.status not in USER_STATUSES:
        raise HTTPException(status_code=422, detail=f"계정 상태는 {', '.join(USER_STATUSES)} 중 하나여야 합니다.")

    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail=f"아이디가 {user_id}인 사장님을 찾을 수 없습니다.")

    note = _get_or_create_note(db, user.email)
    note.status = payload.status
    db.commit()
    return {"success": True, "id": user.id, "email": user.email, "status": payload.status}


@router.put("/users/{user_id}/memo")
def update_admin_user_memo(
    user_id: int,
    payload: AdminUserMemoUpdate,
    db: Session = Depends(get_db),
    _admin: User = Depends(get_current_admin),
):
    """[관리자 메모 저장] CS 응대 이력을 DB에 남긴다 — 예전엔 브라우저 메모리에만 있었다."""
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail=f"아이디가 {user_id}인 사장님을 찾을 수 없습니다.")

    note = _get_or_create_note(db, user.email)
    note.memo = payload.memo
    db.commit()
    return {"success": True, "id": user.id, "email": user.email, "memo": payload.memo}


# ---------------------------------------------------------------------------
# 2. 대시보드 통계 실시간 집계 API
# ---------------------------------------------------------------------------

@router.get("/dashboard/stats")
def get_dashboard_stats(db: Session = Depends(get_db), _admin: User = Depends(get_current_admin)):
    """
    [대시보드 통계] 관리자 웹(admin_web)이 읽는 실시간 집계.

    프리미엄 비율은 뺐다 — 유료 플랜이 폐지됐고, 애초에 'id <= 3이면 프리미엄'이라는
    근거 없는 계산이었다. 그 자리는 실제로 조치가 필요한 '미답변 문의 수'로 바꿨다.
    """
    try:
        total_stores = db.query(User).count()
        total_ingredients = db.query(Ingredient).count()
        pending_inquiries = db.query(Inquiry).filter(Inquiry.status != "answered").count()
        ocr_count = db.query(OcrDocument).count()

        return {
            "totalStores": total_stores,
            "totalIngredients": total_ingredients,
            "pendingInquiries": pending_inquiries,
            "totalInquiries": db.query(Inquiry).count(),
            # OCR 처리 건수 — 예전엔 회원 수를 그대로 넣어 두어 화면 라벨과 값이 어긋났다
            "ocrCount": ocr_count,
            # healthStatus는 뺐다 — 늘 "green"을 돌려주던 상수였고, 실제 상태는 GET /health가 준다
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

@router.get("/stats")
def get_admin_stats(db: Session = Depends(get_db), _admin: User = Depends(get_current_admin)):
    """[관리자 지표] 대시보드 숫자를 전부 DB에서 센다.

    예전엔 회원 수만 실제 값이고 나머지(유료 구독 4, 누적 재료 12, OCR 처리 0)는
    화면에 박아 둔 상수였다. 관리자 화면의 숫자가 사실이 아니면 볼 이유가 없다.
    """
    from app.models.inventory import Ingredient, Menu
    from app.models.operation import Employee

    def _count(model, *filters) -> int:
        try:
            q = db.query(func.count(model.id))
            for f in filters:
                q = q.filter(f)
            return int(q.scalar() or 0)
        except Exception as e:  # 테이블이 아직 없거나 DB가 흔들려도 화면은 떠야 한다
            logger.warning("관리자 지표 집계 실패(%s): %s", getattr(model, "__name__", model), e)
            return 0

    total_users = _count(User)
    ocr_total = _count(OcrDocument)
    ocr_confirmed = _count(OcrDocument, OcrDocument.status == "confirmed")
    inquiries_total = _count(Inquiry)
    inquiries_pending = _count(Inquiry, Inquiry.status != "answered")

    # 실제로 앱을 쓰고 있는 매장 수 — 재료를 하나라도 등록한 store_id 기준.
    # 가입만 하고 안 쓰는 계정과 구분되는 유일한 신호다.
    try:
        active_stores = int(
            db.query(func.count(func.distinct(Ingredient.store_id))).scalar() or 0
        )
    except Exception:
        active_stores = 0

    return {
        "users": total_users,
        "active_stores": active_stores,
        "ingredients": _count(Ingredient),
        "menus": _count(Menu),
        "employees": _count(Employee),
        "ocr_total": ocr_total,
        "ocr_confirmed": ocr_confirmed,
        "inquiries_total": inquiries_total,
        "inquiries_pending": inquiries_pending,
    }


@router.get("/cs")
def get_cs_list(db: Session = Depends(get_db), _admin: User = Depends(get_current_admin)):
    """
    [CS 문의 조회] 사장님들이 남긴 1:1 문의사항 리스트를 접수 최신순으로 조회합니다.

    DB(inquiries)가 단일 출처다. 예전엔 메모리 리스트를 먼저 내보내고 DB를 뒤에 붙여서,
    가짜 시드 문의가 목록 맨 위를 차지하고 실제 문의는 아래로 밀렸다. 메모리는 이제
    DB 쓰기가 실패했을 때만 채워지는 버퍼이므로 뒤에서 보충만 한다.
    """
    res: list[dict] = []
    seen_ids: set[int] = set()

    # 문의를 보낸 사장님 이름 — inquiries에는 매장명만 있어서, 이름은 users에서 가져온다.
    # 이게 없으면 관리자 화면에 "포슬카페 (포슬카페)"처럼 매장명이 두 번 찍힌다.
    try:
        owner_names = {email: name for email, name in db.query(User.email, User.name).all()}
    except Exception:
        owner_names = {}

    try:
        db_items = db.query(Inquiry).order_by(Inquiry.id.desc()).all()
        for item in db_items:
            seen_ids.add(item.id)
            res.append({
                "id": item.id,
                # 문의를 보낸 사람은 계정마다 다르다 — '포슬이'로 고정하면 누가 보냈는지 알 수 없다
                "name": owner_names.get(item.user_email) or item.user_email or "-",
                "store": item.store_name or "-",
                "category": item.category or "문의",
                "title": item.title,
                # 접수 일시는 사장님이 실제로 보낸 한국 시각으로 — created_at은 UTC다
                "date": fmt_kst(item.created_at),
                "status": "처리 완료" if item.status == "answered" else "답변 대기",
                "email": item.user_email,
                "content": item.content,
                "question": item.content,
                "reply": item.answer or None
            })
    except Exception as e:
        logger.error(f"get_cs_list DB 조회 오류: {e}")

    # DB에 못 들어간 접수분만 뒤에 보충 (평소엔 비어 있다)
    for m in mock_cs_list:
        if m.get("id") not in seen_ids:
            res.append(m)

    return res


@router.post("/cs")
def create_cs_from_app(req: dict, db: Session = Depends(get_db)):
    """
    [CS 문의 직접 수신] 사장님 앱에서 전달된 문의글을 DB에 영구 등록합니다.

    앱의 정식 접수 경로는 POST /api/v1/inquiries다. 이 엔드포인트는 예전 앱 버전과의
    호환을 위해 남겨 두며, 같은 DB 테이블에 쓴다. (예전엔 앱이 두 경로에 동시에 쏴서
    문의 1건당 DB 행이 2개씩 생겼다 — 지금은 앱이 한 곳에만 보낸다.)
    """
    title = req.get("title", "")
    content = req.get("content", "")
    category = req.get("category", "문의")
    store_name = req.get("store_name") or "-"
    user_email = req.get("user_email", "")

    new_inq_id = None
    created_at = None
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
        created_at = db_inq.created_at  # 목록 조회와 같은 값을 돌려주기 위해 DB 값을 쓴다
    except Exception as e:
        logger.error(f"Inquiry DB 저장 중 오류: {e}")
        try:
            db.rollback()
        except Exception:
            pass

    new_item = {
        "id": new_inq_id if new_inq_id is not None else max(
            [m.get("id", 9000) for m in mock_cs_list], default=9000) + 1,
        "name": store_name or user_email,
        "store": store_name,
        "category": category,
        "title": title,
        "date": fmt_kst(created_at) if created_at else now_kst().strftime("%Y-%m-%d %H:%M"),
        "status": "답변 대기",
        "email": user_email,
        "content": content,
        "question": content,
        "reply": None
    }
    # DB에 못 들어간 경우에만 메모리에 담아 둔다 — 성공했는데도 넣으면 조회에서 중복된다
    if new_inq_id is None:
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
            inq.answered_at = utc_now()
            db.commit()
            db.refresh(inq)
            sync_reply_to_memory(cs_id, payload.reply)
            return {"success": True, "item": {
                "id": inq.id,
                "store": inq.store_name,
                "name": "사장님",
                "category": inq.category,
                "title": inq.title,
                "date": fmt_kst(inq.created_at),
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
        "date": fmt_kst(n.created_at),
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


def _push_notice(db: Session, notif: AdminNotification) -> dict:
    """등록된 공지를 대상 사장님 기기로 실제 발송한다.

    푸시가 실패해도 공지 등록 자체는 성공이다 — 앱이 폴링으로도 받으므로, 발송 실패를
    이유로 등록을 되돌리면 오히려 아무 데도 안 남는다. 대신 결과를 그대로 돌려줘서
    관리자 화면이 '몇 대에 갔는지'와 '왜 0대인지'를 말할 수 있게 한다.
    """
    from app.services.ai import push_service

    if not push_service.is_configured():
        return {"pushed": 0, "targets": 0, "detail": "FCM 미설정 — 앱을 켰을 때만 표시됩니다"}

    from app.models.ai import DeviceToken

    try:
        if notif.target_type == "specific" and notif.target_email:
            emails = [notif.target_email]
        else:
            emails = [row.email for row in db.query(User.email).all()]

        # 기기를 등록한 매장만 골라낸다 (한 번의 쿼리).
        # 전체 공지에서 회원마다 send_to_store를 부르면 그 안의 list_tokens가 매번 조회를
        # 날려 회원 수만큼 왕복이 생긴다 — Neon에서는 그대로 응답 지연이 된다.
        target_set = set(emails)
        with_devices = {
            sid for (sid,) in db.query(DeviceToken.store_id).distinct().all()
            if sid in target_set
        }

        sent = 0
        for email in with_devices:
            sent += push_service.send_to_store(
                db, email, notif.title, notif.body or "",
                # 탭하면 앱이 알림함으로 이동한다 (pushRegistration이 screen/params를 읽는다)
                data={"screen": "Notice", "noticeId": notif.id},
            )
        detail = "" if sent else "푸시 등록된 기기가 없습니다 (앱에서 알림 권한을 켜야 등록됩니다)"
        return {"pushed": sent, "targets": len(emails), "devices": len(with_devices), "detail": detail}
    except Exception as e:
        logger.exception("공지 푸시 발송 실패")
        return {"pushed": 0, "targets": 0, "detail": f"푸시 발송 실패: {str(e)[:80]}"}


@router.post("/notifications")
def create_notification(payload: NotificationCreate, db: Session = Depends(get_db), _admin: User = Depends(get_current_admin)):
    """
    [공지 등록 + 푸시 발송] 공지를 DB에 남기고, 대상 사장님 기기로 FCM 푸시를 보낸다.

    예전엔 DB에 행만 넣고 끝이라, 앱을 켜 두고 홈 화면을 보고 있는 사장님만 폴링으로
    봤다. 관리자 화면 버튼에는 '즉시 발송'이라고 쓰여 있었는데 실제로 나가는 건 없었다.
    지금은 실제로 보내고, 몇 대에 갔는지 응답에 담아 관리자에게 알려 준다.
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
        delivery = _push_notice(db, notif)
        return {"success": True, "item": _notif_to_dict(notif), "delivery": delivery}
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
            "date": now_kst().strftime("%Y-%m-%d %H:%M"),
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
    - 특정 매장(specific) 공지는 target_email이 본인 이메일과 일치할 때만
    앱은 마지막으로 받은 id를 after_id로 넘겨 새 공지만 증분 수신합니다.

    유료 등급이 폐지돼 premium 대상은 없앴다. 예전에 발송된 premium 공지가 DB에 남아
    있다면 전체 공지로 취급한다 — 아무에게도 안 보이면 발송 이력만 뜨고 수신은 안 되는
    유령이 된다.
    """
    rows = (
        db.query(AdminNotification)
        .filter(AdminNotification.id > after_id)
        .order_by(AdminNotification.id.asc())
        .all()
    )
    visible = [
        n for n in rows
        if n.target_type != "specific" or n.target_email == current_user.email
    ]
    return [_notif_to_dict(n) for n in visible[:20]]


# ---------------------------------------------------------------------------
# 5. (삭제됨) 프리미엄 결제·구독 관리 API — 유료 플랜 폐지
# ---------------------------------------------------------------------------


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
                    # 경과일 계산은 UTC끼리(위 days_inactive), 화면 표시만 KST
                    "last_active": fmt_kst(la) if la else None,
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
