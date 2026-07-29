"""
1대1 문의 및 요청사항 API 엔드포인트 (한글 주석 적용)
"""
from datetime import datetime
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.core.auth import get_current_user, get_current_user_optional
from app.core.database import get_db
from app.models.inquiry import Inquiry
from app.models.user import User
from app.api.v1.admin import mock_cs_list

router = APIRouter(prefix="/inquiries", tags=["Inquiry"])

class InquiryCreate(BaseModel):
    """앱에서 올라오는 1대1 문의.

    예전엔 user_email·store_name의 기본값이 데모 계정(owner@cafe.com / 포슬카페)이었다.
    앱이 값을 못 보내면 조용히 남의 계정 문의로 저장돼, 정작 보낸 사장님의 '나의 문의
    내역'에는 안 보이고 관리자 화면에는 엉뚱한 매장 이름이 찍혔다.

    지금은 토큰이 있으면 토큰의 주인이 보낸 사람이다. user_email은 토큰이 없을 때만
    쓰는 구버전 앱 호환용 폴백이다 (OTA를 아직 못 받은 앱은 인증 없이 보낸다).
    """

    user_email: Optional[str] = None  # 토큰이 없을 때만 쓰는 폴백 (구버전 앱 호환)
    store_name: Optional[str] = None  # 비면 users 테이블에서 찾아 채운다
    category: str
    title: str
    content: str

class InquiryReply(BaseModel):
    answer: str

# DB 쓰기가 실패했을 때만 채워지는 버퍼 — 평소엔 비어 있는 게 정상이다.
# 예전엔 여기에 가짜 문의가 시드로 들어 있어, 앱의 '나의 문의 내역'에 보낸 적 없는
# 문의가 보였다. 진짜 저장소는 DB(inquiries)다.
GLOBAL_INQUIRIES: list[dict] = []

def _normalize_status(raw: Optional[str]) -> str:
    """[한글 주석] '답변 대기'/'처리 완료' 등 관리자식 표기를 앱이 쓰는 'pending'/'answered'로 통일"""
    return "answered" if raw in ("answered", "처리 완료", "done") else "pending"


def sync_reply_to_memory(inquiry_id: int, answer: str) -> None:
    """[한글 주석] 답변을 메모리 폴백 리스트 양쪽(GLOBAL_INQUIRIES·mock_cs_list)에 동기화

    관리자 웹은 mock_cs_list를, 사장님 앱은 GLOBAL_INQUIRIES를 읽는다.
    DB가 꺼진 상태에서 어느 경로로 답변하든 두 리스트가 같이 갱신돼야
    앱 폴링에서 답변이 유실되지 않는다.
    """
    for m in GLOBAL_INQUIRIES:
        if m["id"] == inquiry_id:
            m["answer"] = answer
            m["status"] = "answered"
    for c in mock_cs_list:
        if c["id"] == inquiry_id:
            c["reply"] = answer
            c["status"] = "처리 완료"


@router.get("")
def get_inquiries(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """[한글 주석] 로그인한 사장님 '본인' 문의 내역만 최신순으로 조회한다.

    예전엔 인증 없이 ?user_email=<남의 이메일>만 붙이면 그 사장님의 문의 전문과 관리자
    답변이 그대로 나왔다. 이메일은 비밀이 아니므로 사실상 누구나 열람할 수 있었다.
    이제 토큰의 주인 것만 돌려준다 — 쿼리 파라미터로 남의 것을 지정할 수 없다.

    (관리자는 이 경로가 아니라 관리자 인증이 걸린 GET /admin/cs를 쓴다.)
    """
    user_email = current_user.email
    res = []
    seen_ids = set()
    try:
        items = (
            db.query(Inquiry)
            .filter(Inquiry.user_email == user_email)
            .order_by(Inquiry.id.desc())
            .all()
        )
        for item in items:
            seen_ids.add(item.id)
            res.append({
                "id": item.id,
                "user_email": item.user_email,
                "store_name": item.store_name,
                "category": item.category,
                "title": item.title,
                "content": item.content,
                "status": _normalize_status(item.status),
                "answer": item.answer,
                "date": item.created_at.strftime("%Y.%m.%d") if item.created_at else ""
            })
    except Exception:
        pass
    # DB에 없는 메모리 항목만 뒤에 붙인다 (서버 재시작·DB 오프라인 대비)
    for m in GLOBAL_INQUIRIES:
        if m["id"] in seen_ids:
            continue
        if m.get("user_email") != user_email:
            continue
        res.append({**m, "status": _normalize_status(m.get("status"))})
    return res


def _resolve_store_name(db: Session, email: str, given: Optional[str]) -> str:
    """매장명을 정한다 — 앱이 보낸 값 우선, 비어 있으면 users 테이블에서 찾는다.

    관리자 화면은 이 값으로 "누가 보낸 문의인지"를 표시한다. 예전처럼 '포슬카페'로
    고정하면 전부 같은 매장이 보낸 것처럼 보인다.
    """
    if given and given.strip():
        return given.strip()
    try:
        user = db.query(User).filter(User.email == email).first()
        if user and user.store_name:
            return user.store_name
    except Exception:
        pass
    return email  # 매장명을 못 찾으면 이메일이라도 그대로 — 지어내지 않는다


@router.post("")
def create_inquiry(
    req: InquiryCreate,
    current_user: Optional[User] = Depends(get_current_user_optional),
    db: Session = Depends(get_db),
):
    """[한글 주석] 사장님 앱에서 1대1 문의 등록 — DB 저장 후 관리자 CS 리스트에 실시간 연동

    보낸 사람은 토큰이 있으면 토큰에서 정한다. 본문의 user_email보다 토큰이 우선이다 —
    본문을 그대로 믿으면 아무나 남의 이름으로 문의를 넣고, 관리자가 엉뚱한 사람에게
    답변하게 된다.

    토큰이 없으면 본문의 user_email을 쓴다. 인증을 필수로 걸었더니 OTA를 아직 못 받은
    앱(문의를 인증 없이 보낸다)에서 접수가 통째로 막혔다 — 조회(GET)와 달리 등록은
    남의 데이터를 읽는 경로가 아니라서, 구버전 호환을 열어 두는 편이 낫다.

    ┌─ [갚아야 할 빚] 이 폴백은 임시다 ─────────────────────────────────────────
    │ 열려 있는 동안은 서버 주소만 알면 남의 이메일로 문의를 넣을 수 있다.
    │ 그 글은 사장님이 "내 문의 답변 왔어?"라고 물을 때 챗봇 컨텍스트로 들어간다.
    │ (그 경로의 방어는 services/ai/untrusted.py — 지시가 아니라 자료로 격리한다)
    │
    │ 닫아도 되는 조건: 2026-07-29 OTA(update group b16a172b) 이전 버전을 쓰는
    │   앱이 사실상 없어졌을 때. Expo 대시보드에서 runtimeVersion 1.0.0의 구버전
    │   활성 사용자를 확인하거나, 스토어 빌드가 versionCode 6 이상으로 올라가
    │   그 이전 설치본을 신경 쓰지 않아도 될 때.
    │ 닫는 법: 아래 Depends를 get_current_user로 되돌리고 email 폴백 분기를 지운다.
    │   (tests/test_inquiry_admin_flow.py의 legacy 테스트 2건도 함께 정리)
    └────────────────────────────────────────────────────────────────────────
    """
    now = datetime.now()
    email = (current_user.email if current_user else (req.user_email or "").strip())
    if not email:
        raise HTTPException(status_code=422, detail="문의를 보낸 사장님 이메일이 필요합니다.")
    store_name = _resolve_store_name(db, email, req.store_name)

    inq_id = None
    try:
        inq = Inquiry(
            user_email=email,
            store_name=store_name,
            category=req.category,
            title=req.title,
            content=req.content,
            status="pending",
        )
        db.add(inq)
        db.commit()
        db.refresh(inq)
        inq_id = inq.id
    except Exception:
        try:
            db.rollback()
        except Exception:
            pass

    # [한글 주석] ID 중복 충돌을 방지하기 위한 안전한 고유 ID 생성
    existing_ids = [m.get("id", 0) for m in GLOBAL_INQUIRIES] + [m.get("id", 0) for m in mock_cs_list]
    max_id = max(existing_ids, default=100) + 1
    final_id = inq_id if (inq_id is not None and inq_id not in existing_ids) else max_id

    item_dict = {
        "id": final_id,
        "user_email": email,
        "store_name": store_name,
        "category": req.category,
        "title": req.title,
        "content": req.content,
        "status": "pending",
        "answer": None,
        "date": now.strftime("%Y.%m.%d"),
    }
    # DB 저장에 성공했으면 메모리에 또 넣지 않는다 — 조회에서 같은 문의가 두 번 보인다.
    # 관리자 화면도 같은 DB를 읽으므로 별도 등록이 필요 없다 (예전엔 mock_cs_list에
    # 따로 넣었는데, 그건 서버 재시작이나 인스턴스 교체로 사라지는 사본이었다).
    if inq_id is None:
        GLOBAL_INQUIRIES.insert(0, item_dict)

    return item_dict


@router.post("/{inquiry_id}/reply")
def reply_inquiry(inquiry_id: int, req: InquiryReply, db: Session = Depends(get_db)):
    """[한글 주석] 관리자 웹사이트에서 사장님 1대1 문의에 답변 작성"""
    try:
        inq = db.query(Inquiry).filter(Inquiry.id == inquiry_id).first()
    except Exception:
        inq = None

    if inq:
        inq.answer = req.answer
        inq.status = "answered"
        inq.answered_at = datetime.utcnow()
        db.commit()
        db.refresh(inq)
        sync_reply_to_memory(inquiry_id, req.answer)  # 메모리 사본도 함께 갱신 (표시 불일치 방지)
        return {
            "id": inq.id,
            "user_email": inq.user_email,
            "store_name": inq.store_name,
            "category": inq.category,
            "title": inq.title,
            "content": inq.content,
            "status": inq.status,
            "answer": inq.answer,
            "date": inq.created_at.strftime("%Y.%m.%d") if inq.created_at else ""
        }

    # DB에 없으면 메모리 리스트에서 답변 처리 (DB 오프라인 대비)
    for m in GLOBAL_INQUIRIES:
        if m["id"] == inquiry_id:
            sync_reply_to_memory(inquiry_id, req.answer)
            return m
    raise HTTPException(status_code=404, detail="해당 문의글을 찾을 수 없습니다.")
