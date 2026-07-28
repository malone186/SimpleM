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
    phone: str | None = Field(None, description="휴대폰 번호 — 아이디/비밀번호 찾기 본인 확인용 (선택)")

    # [유입 경로] 가입 시점 first-touch. 모두 선택값 — 안 보내도 기존과 동일하게 가입 성공한다.
    acquisition_source: str | None = Field(None, description="유입 채널 키(referral/web_search/instagram/app_store/youtube/naver_blog/etc)")
    acquisition_detail: str | None = Field(None, description="추천코드·캠페인명 등 보조값")

    # [매장 고정 위치] 가입 2단계 지도 핀으로 확정한 좌표 — 로그인 기기와 무관하게 지도가 이 위치를 보여준다.
    store_lat: float | None = Field(None, ge=-90, le=90, description="매장 위도 (지도 핀)")
    store_lon: float | None = Field(None, ge=-180, le=180, description="매장 경도 (지도 핀)")
    store_address: str | None = Field(None, max_length=200, description="매장 주소 (지도 핀 역지오코딩 결과)")
    store_biz_type: str | None = Field(None, max_length=30, description="상권 유형 (오피스 상권/대학가 등)")

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
    phone: str | None = None
    created_at: datetime
    acquisition_source: str | None = None

    # 매장 고정 위치 — 앱이 로그인 직후 이 값으로 매장 지도를 그린다 (기기 GPS 사용 안 함)
    store_lat: float | None = None
    store_lon: float | None = None
    store_address: str | None = None
    store_biz_type: str | None = None

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
    phone: str | None = Field(None, description="휴대폰 번호 — 아이디/비밀번호 찾기 본인 확인용")

    # [매장 고정 위치] 가입 후 위치를 옮겼거나, 가입 때 등록하지 않은 계정이 나중에 등록할 때 사용
    store_lat: float | None = Field(None, ge=-90, le=90, description="매장 위도 (지도 핀)")
    store_lon: float | None = Field(None, ge=-180, le=180, description="매장 경도 (지도 핀)")
    store_address: str | None = Field(None, max_length=200, description="매장 주소")
    store_biz_type: str | None = Field(None, max_length=30, description="상권 유형")


# 7. [아이디(이메일) 찾기] 요청/응답 규격 — 상호명+휴대폰으로 조회해 마스킹된 이메일만 돌려준다.
class FindEmailRequest(BaseModel):
    store_name: str = Field(..., min_length=1, description="가입 시 등록한 상호/매장 이름")
    # 동일 상호 중복 구분용 — phone이 등록된 계정은 일치해야 하고, 미등록(기존) 계정은 상호명만으로 조회
    phone: str | None = Field(None, description="가입 시 등록한 휴대폰 번호 (또는 사업자번호)")


class FindEmailItem(BaseModel):
    masked_email: str = Field(..., description="마스킹된 가입 이메일 (예: ow***@cafe.com)")
    created_at: datetime = Field(..., description="가입일 — 동일 상호가 여럿일 때 구분용")


class FindEmailResponse(BaseModel):
    accounts: list[FindEmailItem] = Field(..., description="상호명이 일치한 계정 목록")


# 8. [비밀번호 재설정] 요청 규격 — 메일 인프라가 없어 본인확인(휴대폰 또는 상호명) 후 즉시 재설정한다.
class ResetPasswordRequest(BaseModel):
    email: EmailStr = Field(..., description="가입 이메일")
    # 본인 확인값 — 휴대폰 번호(등록 계정) 또는 상호명(휴대폰 미등록 기존 계정) 중 하나가 일치하면 통과.
    # store_name은 구버전 앱(상호명 방식) 하위호환용으로 유지한다.
    verify: str | None = Field(None, description="가입 시 등록한 휴대폰 번호 또는 상호명 (본인 확인용)")
    store_name: str | None = Field(None, description="(구버전 호환) 가입 시 등록한 상호/매장 이름")
    new_password: str = Field(..., min_length=4, description="새 비밀번호 (최소 4자 이상)")

