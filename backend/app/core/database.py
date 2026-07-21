# c:\Users\USER\Documents\본 프로젝트\SimpleM\backend\app\core\database.py
"""
[한글 주석] 팀 공용 PostgreSQL 데이터베이스 연결 및 simplem 전용 스키마 설정 모듈
"""

import os
from dotenv import load_dotenv
from sqlalchemy import create_engine, MetaData
from sqlalchemy.orm import declarative_base, sessionmaker

# .env 환경 변수를 로드합니다.
load_dotenv()

# [한글 주석] 팀 공용 PostgreSQL DATABASE_URL 환경변수 처리
# 예시: postgresql+psycopg://user:pw@host:5432/dbname (또는 postgresql://)
DATABASE_URL = os.getenv(
    "DATABASE_URL",
    "postgresql://postgres:simplem@localhost:5432/simpleM"
)

# [한글 주석] 공용 DB 커넥션 고갈 방지 및 보수적 풀링 옵션 적용
# - pool_pre_ping=True : 끊어진 DB 커넥션을 자동 감지하고 재연결
# - pool_size=5        : 기본 유지 커넥션 수 제한 (보수적 상한)
# - max_overflow=10    : 급증 시 추가 허용 최대 커넥션 수
# - pool_recycle=1800  : 30분마다 오래된 커넥션 자동 폐기/재생성
if DATABASE_URL.startswith("sqlite"):
    engine = create_engine(
        DATABASE_URL,
        connect_args={"check_same_thread": False}
    )
else:
    engine = create_engine(
        DATABASE_URL,
        pool_pre_ping=True,
        pool_size=5,
        max_overflow=10,
        pool_recycle=1800
    )

# 손님 요청마다 통신할 세션 생성 공장
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

# [한글 주석] 전용 스키마 지정 (DB_SCHEMA 환경변수 지정 시 적용, 미지정 시 기본 public)
DB_SCHEMA = os.getenv("DB_SCHEMA", None)
metadata = MetaData(schema=DB_SCHEMA) if DB_SCHEMA else MetaData()
Base = declarative_base(metadata=metadata)



# [한글 주석] FastAPI 의존성 게이트웨이 (자동 세션 닫기 보장)
def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
