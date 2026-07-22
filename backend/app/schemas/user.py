# c:\STUDY\SimpleM\backend\app\schemas\user.py
from pydantic import BaseModel, EmailStr, Field, ConfigDict
from datetime import datetime

# 1. 회원가입 요청 시 프론트엔드가 백엔드로 보내는 '회원가입 신청서' 규격입니다.
class UserCreate(BaseModel):
    # 이메일 형식이 유효한지(예: test@test.com) 자동으로 엄격하게 확인해 줍니다.
    email: EmailStr = Field(..., description="로그인용 이메일 아이디")
    
    # 비밀번호는 너무 짧으면 안 되므로 최소 4자 이상이라는 제한을 걸어줍니다.
    password: str = Field(..., min_length=4, description="비밀번호 (최소 4자 이상)")
    
    name: str = Field(..., description="점주(사용자)의 실명")
    store_name: str = Field(..., description="운영 중인 매장/카페 이름")

# 2. 로그인 요청 시 프론트엔드가 보내는 '로그인 신청서' 규격입니다.
class UserLogin(BaseModel):
    email: EmailStr = Field(..., description="로그인용 이메일 아이디")
    password: str = Field(..., description="비밀번호")

# 3. 회원가입 성공이나 정보 조회 시 백엔드가 프론트엔드로 보내주는 '회원 정보 응답' 규격입니다.
class UserResponse(BaseModel):
    id: int
    email: EmailStr
    name: str
    store_name: str
    created_at: datetime

    # SQLAlchemy 모델 객체(데이터베이스 데이터)를 Pydantic JSON 형식으로 자동으로 변환해 주는 옵션입니다.
    model_config = ConfigDict(from_attributes=True)

# 4. 로그인 성공 시 발급해 주는 '출입증(JWT 토큰)'의 규격입니다.
class Token(BaseModel):
    access_token: str = Field(..., description="암호화된 문자열 상태의 출입증")
    token_type: str = Field("bearer", description="출입증의 종류 (기본값 bearer)")
    email: EmailStr = Field(..., description="로그인한 사용자의 이메일")
    name: str = Field(..., description="로그인한 사용자의 이름(상호)")


# 5. 토큰 내부를 열었을 때 들어있는 가입자의 이메일 정보를 담는 검증용 규격입니다.
class TokenData(BaseModel):
    email: EmailStr | None = None


# 6. 회원 정보 수정(프로필 수정) 요청 시 사용하는 규격입니다. (선택적으로 수정 가능)
class UserUpdate(BaseModel):
    name: str | None = Field(None, description="수정할 점주(사용자) 실명")
    password: str | None = Field(None, min_length=4, description="새로 변경할 비밀번호 (선택사항)")
    store_name: str | None = Field(None, description="수정할 매장/카페 이름")

