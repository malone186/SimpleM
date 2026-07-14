# c:\STUDY\SimpleM\backend\app\api\v1\auth.py
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.auth import get_password_hash, verify_password, create_access_token
from app.models.user import User
from app.schemas.user import UserCreate, UserLogin, UserResponse, Token

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

    # [DB 저장] 새로운 User 객체를 조립해서 데이터베이스에 밀어 넣습니다.
    new_user = User(
        email=user_in.email,
        hashed_password=hashed_pwd,
        name=user_in.name,
        store_name=user_in.store_name
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

    # [토큰 생성] 로그인에 성공했으므로 이메일 정보를 박아 넣은 일일 출입증을 만들어 줍니다.
    access_token = create_access_token(data={"sub": user.email})

    # 프론트엔드로 이름, 이메일을 동봉하여 출입증을 넘겨줍니다.
    return {
        "access_token": access_token, 
        "token_type": "bearer",
        "email": user.email,
        "name": user.name
    }

