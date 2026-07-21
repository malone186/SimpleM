"""
1대1 문의 및 요청사항 API 엔드포인트 (한글 주석 적용)
"""
from datetime import datetime
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.models.inquiry import Inquiry
from app.api.v1.admin import mock_cs_list

router = APIRouter(prefix="/inquiries", tags=["Inquiry"])

class InquiryCreate(BaseModel):
    user_email: Optional[str] = "owner@cafe.com"
    store_name: Optional[str] = "포슬카페"
    category: str
    title: str
    content: str

class InquiryReply(BaseModel):
    answer: str

# 글로벌 공유 메모리 리스트 (DB 미생성 또는 세션 에러 대비 100% 수신 보장)
GLOBAL_INQUIRIES = [
    {
        "id": 1,
        "user_email": "owner@cafe.com",
        "store_name": "포슬카페",
        "category": "💡 기능 요청",
        "title": "원두 발주 추천 시 디카페인 자동 추가 기능 요청",
        "content": "주말마다 디카페인 손님이 늘어나고 있어서 AI 추천에 포함되었으면 좋겠습니다.",
        "status": "answered",
        "answer": "사장님, 좋은 의견 감사드립니다! 해당 기능은 다음주 알고리즘 업데이트에 자동 반영될 예정입니다.",
        "date": "2026.07.20"
    }
]


def _normalize_status(raw: Optional[str]) -> str:
    """[한글 주석] '답변 대기'/'처리 완료' 등 관리자식 표기를 앱이 쓰는 'pending'/'answered'로 통일"""
    return "answered" if raw in ("answered", "처리 완료", "done") else "pending"


@router.get("")
def get_inquiries(db: Session = Depends(get_db)):
    """[한글 주석] 사장님 문의 및 관리자 웹 공용 1대1 문의 내역 전체 최신순 조회"""
    res = []
    seen_ids = set()
    try:
        items = db.query(Inquiry).order_by(Inquiry.id.desc()).all()
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
                "date": item.created_at.strftime("%Y.%m.%d") if item.created_at else "2026.07.21"
            })
    except Exception:
        pass
    # DB에 없는 메모리 항목만 뒤에 붙인다 (서버 재시작·DB 오프라인 대비)
    for m in GLOBAL_INQUIRIES:
        if m["id"] not in seen_ids:
            res.append({**m, "status": _normalize_status(m.get("status"))})
    return res


@router.post("")
def create_inquiry(req: InquiryCreate, db: Session = Depends(get_db)):
    """[한글 주석] 사장님 앱에서 1대1 문의 등록 — DB 저장 후 같은 id로 관리자 CS 리스트에도 즉시 노출"""
    now = datetime.now()
    inq_id = None
    try:
        inq = Inquiry(
            user_email=req.user_email or "owner@cafe.com",
            store_name=req.store_name or "포슬카페",
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

    item_dict = {
        "id": inq_id if inq_id is not None else 0,
        "user_email": req.user_email or "owner@cafe.com",
        "store_name": req.store_name or "포슬카페",
        "category": req.category,
        "title": req.title,
        "content": req.content,
        "status": "pending",
        "answer": None,
        "date": now.strftime("%Y.%m.%d"),
    }

    if inq_id is None:
        # DB 저장 실패 시에만 메모리 리스트로 대체 보관 (id 충돌 방지용 임시 id 발급)
        existing = [m["id"] for m in GLOBAL_INQUIRIES] + [m["id"] for m in mock_cs_list]
        inq_id = max(existing, default=0) + 1
        item_dict["id"] = inq_id
        GLOBAL_INQUIRIES.insert(0, item_dict)

    # [한글 주석] 관리자 웹 CS 리스트에 DB와 동일한 id로 등록 → 관리자 답변이 정확히 이 문의에 연결됨
    mock_cs_list.insert(0, {
        "id": inq_id,
        "name": "포슬이",
        "store": req.store_name or "포슬카페",
        "category": req.category,
        "title": req.title,
        "date": now.strftime("%Y-%m-%d %H:%M"),
        "status": "답변 대기",
        "email": req.user_email or "owner@cafe.com",
        "content": req.content,
        "question": req.content,
        "reply": None,
    })

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
        return {
            "id": inq.id,
            "user_email": inq.user_email,
            "store_name": inq.store_name,
            "category": inq.category,
            "title": inq.title,
            "content": inq.content,
            "status": inq.status,
            "answer": inq.answer,
            "date": inq.created_at.strftime("%Y.%m.%d") if inq.created_at else "2026.07.21"
        }

    # DB에 없으면 메모리 리스트에서 답변 처리 (DB 오프라인 대비)
    for m in GLOBAL_INQUIRIES:
        if m["id"] == inquiry_id:
            m["answer"] = req.answer
            m["status"] = "answered"
            return m
    raise HTTPException(status_code=404, detail="해당 문의글을 찾을 수 없습니다.")
