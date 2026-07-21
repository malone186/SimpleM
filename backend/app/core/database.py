import os
import logging
from dotenv import load_dotenv
from sqlalchemy import create_engine, MetaData
from sqlalchemy.orm import declarative_base, sessionmaker

load_dotenv()
logger = logging.getLogger(__name__)

RAW_DB_URL = os.getenv(
    "DATABASE_URL",
    "postgresql://postgres:simplem@localhost:5432/simpleM"
)

# [한글 주석] 원격 공유 PostgreSQL 연결 불가 시 로컬 SQLite(sqlite:///./simplem.db)로 자동 안전 전환
def _create_db_engine():
    if RAW_DB_URL.startswith("sqlite"):
        return create_engine(RAW_DB_URL, connect_args={"check_same_thread": False})
    
    try:
        eng = create_engine(
            RAW_DB_URL,
            pool_pre_ping=True,
            pool_size=5,
            max_overflow=10,
            pool_recycle=1800,
            connect_args={"connect_timeout": 3}
        )
        with eng.connect() as conn:
            pass
        logger.info("[DB 연결 성공] 공유 PostgreSQL 데이터베이스에 정상 연결되었습니다.")
        return eng
    except Exception as e:
        logger.warning(f"[DB 폴백] 공유 PostgreSQL DB 연결 실패 ({e}) -> 로컬 SQLite(sqlite:///./simplem.db)로 자동 전환합니다.")
        sqlite_url = "sqlite:///./simplem.db"
        return create_engine(sqlite_url, connect_args={"check_same_thread": False})

engine = _create_db_engine()

# [한글 주석] SQLite 사용 시 기존 DB에 부족한 컬럼(actual_start_time, actual_end_time 등) 자동 생성 보완
def _ensure_sqlite_schema():
    if str(engine.url).startswith("sqlite"):
        from sqlalchemy import text
        with engine.connect() as conn:
            for col in ["actual_start_time", "actual_end_time"]:
                try:
                    conn.execute(text(f"ALTER TABLE schedules ADD COLUMN {col} DATETIME"))
                    conn.commit()
                except Exception:
                    pass

_ensure_sqlite_schema()

# 손님 요청마다 통신할 세션 생성 공장
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

# [한글 주석] 전용 스키마 지정 (SQLite 폴백 시에는 schema 미사용)
DB_SCHEMA = os.getenv("DB_SCHEMA", None)
is_sqlite = str(engine.url).startswith("sqlite")
metadata = MetaData(schema=DB_SCHEMA) if (DB_SCHEMA and not is_sqlite) else MetaData()
Base = declarative_base(metadata=metadata)

# [한글 주석] FastAPI 의존성 게이트웨이 (자동 세션 닫기 보장)
def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

