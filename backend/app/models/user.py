# c:\STUDY\SimpleM\backend\app\models\user.py
from sqlalchemy import Column, Integer, String, DateTime
from sqlalchemy.sql import func
from app.core.database import Base

# 데이터베이스에 저장될 'users' 테이블의 구조 설계도입니다.
class User(Base):
    __tablename__ = "users"  # 데이터베이스 내의 실제 테이블 이름입니다.

    # 1. 고유 식별 번호 (1, 2, 3... 자동으로 하나씩 증가하며 부여됩니다.)
    id = Column(Integer, primary_key=True, index=True)

    # 2. 로그인용 이메일 주소 (아이디 역할, 중복 가입을 막기 위해 unique 옵션을 줍니다.)
    email = Column(String(100), unique=True, index=True, nullable=False)

    # 3. 암호화된 비밀번호 (보안을 위해 글자 그대로 저장하지 않고, 암호화된 외계어 상태로 보관합니다.)
    hashed_password = Column(String(255), nullable=False)

    # 4. 점주(사용자)의 이름 (예: "홍길동")
    name = Column(String(50), nullable=False)

    # 5. 매장(카페) 이름 (예: "포자카페 강남점")
    store_name = Column(String(100), nullable=False)

    # 6. 계정이 생성된 날짜와 시간 (회원가입이 완료되는 시점의 현재 시각이 자동으로 입력됩니다.)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
