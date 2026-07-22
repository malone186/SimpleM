# c:\STUDY\SimpleM\backend\app\core\auth.py
import logging
import os
import json
import time
import urllib.request
from datetime import datetime, timedelta, timezone
import jwt
import bcrypt
from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.models.user import User
from app.schemas.user import TokenData

logger = logging.getLogger(__name__)

# 1. 환경변수 및 인증 설정
_INSECURE_DEFAULT_SECRET = "simplem-secret-key-super-secure-key-1234567890"
SECRET_KEY = os.getenv("SECRET_KEY", _INSECURE_DEFAULT_SECRET)
if SECRET_KEY == _INSECURE_DEFAULT_SECRET:
    # 소스에 공개된 기본 키로는 누구나 토큰을 위조할 수 있다 — .env에 SECRET_KEY를 반드시 설정할 것.
    logger.error(
        "[보안 경고] SECRET_KEY 환경변수가 없어 공개된 기본 키로 폴백했습니다. "
        ".env에 SECRET_KEY를 설정하세요 (python -c \"import secrets; print(secrets.token_urlsafe(48))\")."
    )
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 60 * 24  # 하루 유효한 로컬 토큰
FIREBASE_PROJECT_ID = os.getenv("FIREBASE_PROJECT_ID", "simplem-app")

# 관리자 이메일 허용목록 — 프론트 RootNavigator의 ADMIN_EMAILS와 동일하게 맞춘다.
# 콤마로 여러 명 지정 가능: ADMIN_EMAILS=a@x.com,b@y.com
ADMIN_EMAILS = [e.strip() for e in os.getenv("ADMIN_EMAILS", "admin@simplem.com").split(",") if e.strip()]
# 관리자 웹 콘솔 로그인용 비밀번호 (env 필수). 없으면 관리자 로그인이 비활성화된다.
ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD", "")

# 구글 공개 키 캐싱을 위한 전역 변수들
_GOOGLE_PUBLIC_KEYS = {}
_KEYS_EXPIRE_AT = 0.0

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="api/v1/auth/login")


# --- [비밀번호 암호화 관련 함수 (로컬 DB 레거시 유지용)] ---

def get_password_hash(password: str) -> str:
    """비밀번호를 안전하게 해싱합니다."""
    pwd_bytes = password.encode('utf-8')
    salt = bcrypt.gensalt()
    hashed = bcrypt.hashpw(pwd_bytes, salt)
    return hashed.decode('utf-8')


def verify_password(plain_password: str, hashed_password: str) -> bool:
    """로그인 비밀번호가 대조문과 맞는지 검사합니다."""
    plain_bytes = plain_password.encode('utf-8')
    hashed_bytes = hashed_password.encode('utf-8')
    return bcrypt.checkpw(plain_bytes, hashed_bytes)


def create_access_token(data: dict, expires_delta: timedelta | None = None) -> str:
    """로컬 로그인용 토큰을 만듭니다."""
    to_encode = data.copy()
    if expires_delta:
        expire = datetime.now(timezone.utc) + expires_delta
    else:
        expire = datetime.now(timezone.utc) + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)


# --- [Firebase 공개 키 수집 및 검증 관련 유틸리티] ---

def _get_google_public_keys() -> dict:
    """구글의 Firebase ID Token 서명용 공개키들을 조회하고 1시간 동안 메모리에 캐싱합니다."""
    global _GOOGLE_PUBLIC_KEYS, _KEYS_EXPIRE_AT
    now = time.time()
    
    # 캐시가 만료되지 않았다면 그대로 캐시된 공개키를 반환합니다.
    if _GOOGLE_PUBLIC_KEYS and now < _KEYS_EXPIRE_AT:
        return _GOOGLE_PUBLIC_KEYS

    try:
        url = "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com"
        with urllib.request.urlopen(url, timeout=5) as response:
            headers = response.info()
            # HTTP Response의 Cache-Control 헤더에서 max-age를 파싱해 만료 시간을 정밀 계산합니다.
            cache_control = headers.get("Cache-Control", "")
            max_age = 3600
            for part in cache_control.split(","):
                if "max-age" in part:
                    try:
                        max_age = int(part.split("=")[1].strip())
                    except Exception:
                        pass
            
            _GOOGLE_PUBLIC_KEYS = json.loads(response.read().decode("utf-8"))
            _KEYS_EXPIRE_AT = now + max_age
            return _GOOGLE_PUBLIC_KEYS
    except Exception:
        # 구글 키 서버 통신 실패 시, 캐시가 있다면 죽지 않고 기존 캐시를 반환합니다.
        if _GOOGLE_PUBLIC_KEYS:
            return _GOOGLE_PUBLIC_KEYS
        return {}


# --- [FastAPI 의존성 주입: 현재 사용자 권한 인증 필터] ---

def get_current_user(token: str = Depends(oauth2_scheme), db: Session = Depends(get_db)) -> User:
    """
    [FastAPI 보안 통문 검사기]
    1. 프론트엔드가 건넨 Firebase ID Token을 RS256 비대칭 공개키 방식으로 온전히 검증합니다.
    2. 검증에 통과했으나 DB에 없는 이메일이라면, 회원 정보를 자동 가입(Lazy Signup)시켜 줍니다.
    3. 로컬 테스트 및 API 통신 검증 편의를 위해, 이전 로컬 JWT 토큰도 감지하여 자동 디버그 통과(Fallback)시켜 줍니다.
    """
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="올바르지 않거나 만료된 로그인 토큰(인증 실패)입니다.",
        headers={"WWW-Authenticate": "Bearer"},
    )

    email = None
    name = None

    # [1단계] Firebase ID Token 검증 시도 (비대칭키 RS256)
    try:
        # 토큰 헤더에서 kid(구글 서명 키 고유번호)를 추출합니다.
        header = jwt.get_unverified_header(token)
        kid = header.get("kid")
        
        if not kid:
            raise jwt.PyJWTError("Token header is missing 'kid'")

        public_keys = _get_google_public_keys()
        cert_str = public_keys.get(kid)
        
        if not cert_str:
            raise jwt.PyJWTError("Corresponding Google public key not found")

        # [한글 주석: 구글 x509 인증서로부터 실제 검증에 사용될 공개키(Public Key) 오브젝트를 추출하여 검증에 활용합니다]
        from cryptography.x509 import load_pem_x509_certificate
        cert_obj = load_pem_x509_certificate(cert_str.encode("utf-8"))
        public_key = cert_obj.public_key()

        # 비대칭 서명, 만료일, 수신자(Project ID) 및 발급처 검증을 일괄 처리합니다.
        payload = jwt.decode(
            token,
            public_key,
            algorithms=["RS256"],
            audience=FIREBASE_PROJECT_ID,
            issuer=f"https://securetoken.google.com/{FIREBASE_PROJECT_ID}"
        )
        email = payload.get("email")
        name = payload.get("name", email.split("@")[0] if email else "사장님")

    except jwt.PyJWTError as e:
        # 로컬 HS256 토큰은 kid가 없어 여기로 오는 게 정상 흐름 — 디버그 레벨로만 남긴다.
        logger.debug(f"Firebase token verification failed: {e}")
        # [2단계: 디버그 폴백 모드] Firebase 검증 실패 시, 로컬 HS256 토큰 해독을 자동 시도합니다.
        try:
            payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
            email = payload.get("sub")
            name = payload.get("name", email.split("@")[0] if email else "사장님")
        except jwt.PyJWTError:
            # 로컬 토큰 검사마저 실패하면 최종 401 에러를 던집니다.
            raise credentials_exception

    if not email:
        raise credentials_exception

    # [3단계: Lazy Signup - 자동 회원 가입]
    # Firebase 인증을 통과한 이메일인데 DB 사용자 테이블에 없다면 즉시 매장 계정을 생성해 줍니다.
    user = db.query(User).filter(User.email == email).first()
    if user is None:
        user = User(
            email=email,
            name=name,
            hashed_password=get_password_hash("firebase_auto_signup_random_pwd_1234"),
            store_name=f"{name} 매장"
        )
        db.add(user)
        db.commit()
        db.refresh(user)

    return user


def get_current_admin(current_user: User = Depends(get_current_user)) -> User:
    """
    [관리자 전용 통문] 로그인 사용자가 관리자 허용목록(ADMIN_EMAILS)에 속하는지 확인한다.
    - 1단계: get_current_user가 토큰(Firebase RS256 또는 로컬 HS256)을 검증
    - 2단계: 그 이메일이 관리자인지 확인 — 아니면 403
    """
    if current_user.email not in ADMIN_EMAILS:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="관리자 권한이 필요합니다.",
        )
    return current_user
