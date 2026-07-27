# c:\STUDY\SimpleM\backend\app\api\v1\auth.py
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from sqlalchemy import func as sa_func

from app.core.database import get_db
from app.core.auth import get_password_hash, verify_password, create_access_token, get_current_user, get_current_admin
from app.models.user import User
from app.schemas.user import (
    FindEmailItem,
    FindEmailRequest,
    FindEmailResponse,
    ResetPasswordRequest,
    Token,
    UserCreate,
    UserLogin,
    UserResponse,
    UserUpdate,
)


def _mask_email(email: str) -> str:
    """이메일 앞 2자만 남기고 마스킹한다 (ow***@cafe.com). 로컬파트가 짧으면 1자만 남긴다."""
    local, _, domain = email.partition("@")
    keep = 2 if len(local) > 2 else 1
    return f"{local[:keep]}***@{domain}"

# APIRouter를 통해 "/auth" 주소 영역을 담당하는 세부 창구를 지정합니다.
router = APIRouter(prefix="/auth", tags=["인증(Authentication)"])


# 1. [회원가입 API 창구]
# 회원가입이 완료되면 비밀번호가 빠진 회원 정보 응답(UserResponse) 형식으로 반환합니다.
@router.post("/signup", response_model=UserResponse, status_code=status.HTTP_201_CREATED)
def signup(user_in: UserCreate, db: Session = Depends(get_db)):
    """
    새로운 매장 점주님의 회원가입 신청을 처리합니다.
    """
    # [검사 1] 이미 동일한 이메일로 가입한 사람이 있는지 DB에서 검색해 봅니다.
    existing_user = db.query(User).filter(User.email == user_in.email).first()
    if existing_user:
        # 이미 있다면 "이메일 중복" 에러(HTTP 400 Bad Request)를 던져 중단합니다.
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="이미 등록된 이메일 주소입니다. 다른 이메일을 사용해 주세요."
        )

    # [보안 처리] 사용자가 적어 보낸 날 비밀번호를 암호화된 외계어 해시값으로 변환합니다.
    hashed_pwd = get_password_hash(user_in.password)

    # [유입 경로] 가입 시점 first-touch 채널을 정규화해 저장합니다. 값이 없으면 NULL(집계 시 추정 폴백).
    from datetime import datetime, timezone
    from app.api.v1.admin import normalize_acquisition_source
    acq_source = normalize_acquisition_source(getattr(user_in, "acquisition_source", None))
    acq_detail = (getattr(user_in, "acquisition_detail", None) or None)
    acq_at = datetime.now(timezone.utc) if acq_source else None

    # [DB 저장] 새로운 User 객체를 조립해서 데이터베이스에 밀어 넣습니다.
    new_user = User(
        email=user_in.email,
        hashed_password=hashed_pwd,
        name=user_in.name,
        store_name=user_in.store_name,
        phone=(user_in.phone or "").strip() or None,  # 아이디/비번 찾기 본인 확인용 (선택)
        acquisition_source=acq_source,
        acquisition_detail=acq_detail,
        acquisition_at=acq_at,
    )
    db.add(new_user)
    db.commit()  # 데이터베이스에 최종 변경 내용을 확정(커밋)합니다.
    db.refresh(new_user)  # 방금 저장하며 부여된 id 번호 등을 DB에서 다시 읽어와 채웁니다.

    # 비밀번호가 가려진 채로 안전하게 가입 정보를 프론트엔드로 돌려줍니다.
    return new_user


# 2. [로그인 API 창구]
# 로그인이 성공하면 암호화된 출입증 토큰(Token)을 발급하여 돌려줍니다.
@router.post("/login", response_model=Token)
def login(user_in: UserLogin, db: Session = Depends(get_db)):
    """
    이메일과 비밀번호를 검증하여 로그인 처리를 수행하고 JWT 토큰을 발행합니다.
    """
    # [검사 1] 입력한 이메일의 가입자가 존재하는지 조회합니다.
    user = db.query(User).filter(User.email == user_in.email).first()
    
    # 가입자가 아예 없거나, 혹은 가입자는 있는데 비밀번호 암호가 틀린 경우
    if not user or not verify_password(user_in.password, user.hashed_password):
        # 보안을 위해 이메일이 틀렸는지 비밀번호가 틀렸는지 꼬집어 말하지 않고 둘러대서 공격자를 골탕 먹입니다.
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="이메일 또는 비밀번호가 일치하지 않습니다.",
            headers={"WWW-Authenticate": "Bearer"},
        )

    # [한글 주석] 로그인에 성공했으므로 이메일 정보를 박아 넣은 일일 출입증을 만들어 줍니다.
    access_token = create_access_token(data={"sub": user.email})

    # 비밀번호가 가려진 채로 안전하게 가입 정보를 프론트엔드로 돌려줍니다.
    return {
        "access_token": access_token, 
        "token_type": "bearer",
        "email": user.email,
        "name": user.name
    }


def _digits(value: str | None) -> str:
    """휴대폰/사업자번호 비교용 — 하이픈·공백을 걷어내고 숫자만 남긴다."""
    return "".join(ch for ch in (value or "") if ch.isdigit())


# 2-1. [아이디(이메일) 찾기 API 창구]
# 상호명 + 휴대폰 번호로 계정을 조회해 마스킹된 이메일만 알려준다 — 원본 이메일은 절대 노출하지 않는다.
# 가입 화면이 상호/이름을 한 필드로 받아 두 컬럼에 같이 저장하므로 store_name과 name 둘 다 대조한다.
# 휴대폰이 등록된 계정은 번호까지 일치해야 하고, 미등록(기존) 계정은 상호명만으로 조회된다.
@router.post("/find-email", response_model=FindEmailResponse)
def find_email(req: FindEmailRequest, db: Session = Depends(get_db)):
    """상호명(+휴대폰 번호)이 일치하는 계정들의 마스킹된 이메일 목록을 반환합니다."""
    q = req.store_name.strip().lower()
    if not q:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="상호명을 입력해 주세요.")
    users = (
        db.query(User)
        .filter(
            (sa_func.lower(sa_func.trim(User.store_name)) == q)
            | (sa_func.lower(sa_func.trim(User.name)) == q)
        )
        .order_by(User.created_at.asc())
        .limit(20)
        .all()
    )
    req_phone = _digits(req.phone)
    if req_phone:
        # 휴대폰 등록 계정은 번호 일치 필수, 미등록 계정은 상호명만으로 통과 (기존 회원 배려)
        users = [u for u in users if not _digits(u.phone) or _digits(u.phone) == req_phone]
    if not users:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="입력하신 상호명과 휴대폰 번호에 일치하는 계정을 찾을 수 없습니다. 가입 시 등록한 정보를 정확히 입력해 주세요.",
        )
    return FindEmailResponse(
        accounts=[FindEmailItem(masked_email=_mask_email(u.email), created_at=u.created_at) for u in users[:5]]
    )


# 2-2. [비밀번호 재설정 API 창구]
# 메일 발송 인프라가 없어 링크 방식 대신 본인확인(휴대폰 번호 또는 상호명) 후 즉시 재설정한다.
# 이메일 존재 여부가 새어나가지 않도록 실패 사유는 한 문장으로 뭉뚱그려 응답한다.
@router.post("/reset-password", status_code=status.HTTP_204_NO_CONTENT)
def reset_password(req: ResetPasswordRequest, db: Session = Depends(get_db)):
    """이메일 + 본인확인값(휴대폰 번호 또는 상호명)이 일치하면 비밀번호를 새 값으로 교체합니다."""
    user = db.query(User).filter(sa_func.lower(User.email) == req.email.strip().lower()).first()
    # verify(신형: 휴대폰 또는 상호명 한 필드) / store_name(구버전 앱 호환) 중 온 값으로 확인
    raw = (req.verify or req.store_name or "").strip()
    q = raw.lower()
    matched = user is not None and bool(raw) and (
        (bool(_digits(raw)) and _digits(user.phone) == _digits(raw))
        or (user.store_name or "").strip().lower() == q
        or (user.name or "").strip().lower() == q
    )
    if not matched:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="이메일과 본인 확인 정보(휴대폰 번호 또는 상호명)가 일치하는 계정을 찾을 수 없습니다. 입력 정보를 다시 확인해 주세요.",
        )
    user.hashed_password = get_password_hash(req.new_password)
    db.commit()


# [관리자 전용] 3. [전체 회원 목록 조회 API 창구]
@router.get("/users", response_model=list[UserResponse])
def get_all_users(db: Session = Depends(get_db), _admin: User = Depends(get_current_admin)):
    """
    [관리자용] 현재 DB에 가입된 모든 사장님(회원)의 정보를 조회합니다.
    """
    return db.query(User).order_by(User.id.desc()).all()


# [관리자 전용] 4. [특정 회원 강제 탈퇴 처리 API 창구]
@router.delete("/users/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_user(user_id: int, db: Session = Depends(get_db), _admin: User = Depends(get_current_admin)):
    """
    [관리자용] 특정 ID의 회원을 강제 탈퇴 처리하고 관련 정보를 데이터베이스에서 삭제합니다.
    """
    # [검사 1] 지우고자 하는 회원 정보가 진짜 DB에 있는지 확인합니다.
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="존재하지 않는 회원 정보입니다."
        )
    # [DB 삭제 및 저장]
    db.delete(user)
    db.commit()


# 5. [회원 정보(프로필) 수정 API 창구]
# 로그인된 상태에서 자신의 이름, 비밀번호, 상호명을 선택적으로 수정합니다.
@router.patch("/profile", response_model=UserResponse)
def update_profile(
    user_update: UserUpdate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    현재 로그인한 점주님의 이름, 상호명 또는 비밀번호를 부분적으로 수정합니다.
    """
    # 1. 이름 변경 요청이 들어온 경우 반영합니다.
    if user_update.name is not None:
        current_user.name = user_update.name.strip()

    # 2. 매장 상호명 변경 요청이 들어온 경우 반영합니다.
    if user_update.store_name is not None:
        current_user.store_name = user_update.store_name.strip()

    # 3. 새로운 비밀번호 변경 요청이 들어온 경우 암호화해서 저장합니다.
    if user_update.password is not None:
        current_user.hashed_password = get_password_hash(user_update.password)

    # 3-1. 휴대폰 번호 등록/변경 (아이디·비밀번호 찾기 본인 확인용)
    if user_update.phone is not None:
        current_user.phone = user_update.phone.strip() or None

    # 4. 변경사항을 데이터베이스에 확정(커밋)합니다.
    db.commit()
    db.refresh(current_user)

    return current_user



