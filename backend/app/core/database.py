# c:\STUDY\SimpleM\backend\app\core\database.py
import os
from dotenv import load_dotenv
from sqlalchemy import create_engine
from sqlalchemy.orm import declarative_base, sessionmaker

# .env 파일에 적어둔 환경 변수(비밀번호, 디비이름 등)를 메모리로 가져옵니다.
load_dotenv()

# .env 파일에서 DATABASE_URL(데이터베이스 접속 주소)을 꺼내옵니다.
# 만약 적어두지 않았다면, 임시 에러가 발생하지 않도록 기본값으로 우리가 만든 디비 주소를 넣어줍니다.
DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://postgres:simplem@localhost:5432/simpleM")

# 데이터베이스와 통신할 때 사용하는 '전용 엔진(덤프트럭)'을 만듭니다.
# [한글 주석] SQLite 환경에서는 멀티스레드 접속 충돌(check_same_thread)을 막는 보조 인자를 추가해 줍니다.
if DATABASE_URL.startswith("sqlite"):
    engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})
else:
    engine = create_engine(DATABASE_URL)

# 개별 손님 요청이 들어올 때마다 데이터베이스와 소통할 통신망(세션 세트)을 만들어내는 공장입니다.
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

# 나중에 설계할 테이블 모델(Ingredient, Menu 등)들의 공통 부모 뼈대 클래스입니다.
Base = declarative_base()

# 실제 서비스 코드(API)에서 데이터베이스 연결이 필요할 때 호출할 도우미 함수입니다.
# 사용이 다 끝나면 자동으로 통신(세션)을 종료해 주는 안전장치 역할을 합니다.
def get_db():
    db = SessionLocal()
    try:
        yield db  # 데이터베이스 사용권을 API에게 잠시 빌려줍니다.
    finally:
        db.close()  # API 작업이 끝나면 데이터베이스 연결을 안전하게 닫습니다.
