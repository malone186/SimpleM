# c:\STUDY\SimpleM\backend\app\core\auth.py
import os
from datetime import datetime, timedelta, timezone
import os
from datetime import datetime, timedelta, timezone
import jwt
import bcrypt  # passlib 대신 직접 이 암호화 패키지를 가져옵니다.
from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.models.user import User
from app.schemas.user import TokenData

# 2. JWT 토큰 발급에 필요한 비밀 설정값들입니다.
# SECRET_KEY는 출입증에 도장을 찍을 때 쓰는 '국가 기밀 도장' 같은 것입니다. 절대로 유출되면 안 됩니다!
SECRET_KEY = os.getenv("SECRET_KEY", "simplem-secret-key-super-secure-key-1234567890")
ALGORITHM = "HS256"  # 토큰을 서명할 때 쓸 수학 알고리즘 (기본 대칭키 암호화 방식)
ACCESS_TOKEN_EXPIRE_MINUTES = 60 * 24  # 하루(1440분) 동안 유효한 출입증을 발급합니다.

# 3. FastAPI에 내장된 토큰 자동 검사기입니다. 
# 프론트엔드가 보낸 요청 헤더(Authorization: Bearer <토큰>)에서 토큰 문자열만 쏙 뽑아옵니다.
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="api/v1/auth/login")


# --- [비밀번호 암호화 관련 함수] ---

def get_password_hash(password: str) -> str:
    """
    비밀번호를 안전하게 암호화(해싱)합니다.
    텍스트 형식의 패스워드를 컴퓨터 바이트 데이터로 바꾼 뒤 bcrypt로 암호화합니다.
    """
    pwd_bytes = password.encode('utf-8')
    salt = bcrypt.gensalt()  # 무작위 소금 조각(임의 문자열)을 뿌려 암호의 임의성을 높입니다.
    hashed = bcrypt.hashpw(pwd_bytes, salt)
    return hashed.decode('utf-8')  # 다시 문자열로 바꿔 저장합니다.


def verify_password(plain_password: str, hashed_password: str) -> bool:
    """
    사용자가 로그인 시 입력한 비밀번호(평문)가 DB에 저장된 암호문(해시)과 일치하는지 대조합니다.
    """
    plain_bytes = plain_password.encode('utf-8')
    hashed_bytes = hashed_password.encode('utf-8')
    return bcrypt.checkpw(plain_bytes, hashed_bytes)



# --- [JWT 토큰 발급 및 검증 관련 함수] ---

def create_access_token(data: dict, expires_delta: timedelta | None = None) -> str:
    """
    로그인에 성공한 사용자에게 줄 암호화된 '출입증(JWT)'을 발급합니다.
    """
    to_encode = data.copy()
    
    # 출입증이 언제 만료되는지 시간을 설정합니다. (기본 1일)
    if expires_delta:
        expire = datetime.now(timezone.utc) + expires_delta
    else:
        expire = datetime.now(timezone.utc) + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    
    # 토큰 만료 시간 정보를 담습니다.
    to_encode.update({"exp": expire})
    
    # 도장(SECRET_KEY)을 쾅 찍어서 위조가 불가능한 출입증(JWT 문자열)을 만들어 냅니다.
    encoded_jwt = jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)
    return encoded_jwt


def get_current_user(token: str = Depends(oauth2_scheme), db: Session = Depends(get_db)) -> User:
    """
    자물쇠 역할: 다른 기능(재고 조회 등)에서 이 토큰을 들이밀었을 때, 
    올바른 출입증인지 검사해서 "아, 이메일이 owner@cafe.com인 사장님이 맞구나!" 하고
    데이터베이스에서 회원 정보를 찾아 넘겨주는 핵심 보초 함수입니다.
    """
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="올바르지 않거나 만료된 로그인 토큰(출입증)입니다.",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        # 출입증(토큰)을 기밀 도장(SECRET_KEY)으로 해독해서 열어봅니다.
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        email: str = payload.get("sub")
        if email is None:
            raise credentials_exception
        token_data = TokenData(email=email)
    except jwt.PyJWTError:
        # 위조되었거나 시간이 지난 토큰이면 예외를 던집니다.
        raise credentials_exception

    # 출입증에 적혀있던 이메일 주소로 DB에서 실제 가입자를 찾아냅니다.
    user = db.query(User).filter(User.email == token_data.email).first()
    if user is None:
        raise credentials_exception
    
    # 현재 로그인한 사람의 DB 모델 객체를 반환합니다.
    return user
