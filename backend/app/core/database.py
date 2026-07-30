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

# [한글 주석] PostgreSQL 연결 불가 시 처리 정책.
# 기존에는 조용히 로컬 SQLite로 전환했는데, 이 경우 운영 DB 장애가 감춰지고
# 모든 쓰기가 재배포 때 사라지는 임시 파일로 흘러가는 심각한 사고로 이어진다.
# 그래서 기본값은 "명확한 에러로 중단"이며, 개발 편의상 폴백이 필요하면
# 환경변수 ALLOW_SQLITE_FALLBACK=1 을 명시적으로 설정해야만 SQLite로 전환한다.
def _create_db_engine():
    if RAW_DB_URL.startswith("sqlite"):
        return create_engine(RAW_DB_URL, connect_args={"check_same_thread": False})

    # [Neon 등 서버리스 Postgres 대응]
    # - connect_timeout: 유휴 후 첫 연결(cold start)에 수 초 걸리므로 기본 10초로 넉넉히. env로 조절.
    # - keepalives: 서버리스가 유휴 연결을 끊어도 풀이 죽지 않게 TCP keepalive 유지.
    # - SSL: DATABASE_URL 끝에 ?sslmode=require 를 붙이면 psycopg2가 자동 처리 (Neon 필수).
    #   되도록 Neon의 '-pooler' 엔드포인트를 사용하면 동시 연결 제한에 강하다.
    connect_timeout = int(os.getenv("DB_CONNECT_TIMEOUT", "10"))
    try:
        eng = create_engine(
            RAW_DB_URL,
            pool_pre_ping=True,
            pool_size=int(os.getenv("DB_POOL_SIZE", "5")),
            max_overflow=10,
            pool_recycle=1800,
            connect_args={
                "connect_timeout": connect_timeout,
                "keepalives": 1,
                "keepalives_idle": 30,
                "keepalives_interval": 10,
                "keepalives_count": 5,
            },
        )
        with eng.connect() as conn:
            pass
        logger.info("[DB 연결 성공] PostgreSQL 데이터베이스에 정상 연결되었습니다.")
        return eng
    except Exception as e:
        if os.getenv("ALLOW_SQLITE_FALLBACK") == "1":
            logger.error(
                f"[DB 폴백] PostgreSQL 연결 실패 ({e}) -> ALLOW_SQLITE_FALLBACK=1 이므로 로컬 SQLite로 전환합니다. "
                "이 모드의 쓰기 데이터는 공유 DB에 반영되지 않습니다."
            )
            return create_engine("sqlite:///./simplem.db", connect_args={"check_same_thread": False})
        # 폴백 미허용(기본값): 장애를 감추지 않고 즉시 중단시켜 운영자가 인지하게 한다.
        raise RuntimeError(
            f"PostgreSQL 연결에 실패했습니다: {e}\n"
            "DATABASE_URL과 DB 서버 상태를 확인하세요. "
            "개발 중 로컬 SQLite 폴백이 필요하면 환경변수 ALLOW_SQLITE_FALLBACK=1 을 설정하세요."
        ) from e

engine = _create_db_engine()

# [한글 주석] SQLite 사용 시 기존 DB에 부족한 컬럼(actual_start_time, actual_end_time, roastery_beans 컬럼 등) 자동 생성 보완
def _ensure_sqlite_schema():
    if str(engine.url).startswith("sqlite"):
        from sqlalchemy import text
        with engine.connect() as conn:
            # 1. schedules 테이블 부족 컬럼 보완
            for col in ["actual_start_time", "actual_end_time"]:
                try:
                    conn.execute(text(f"ALTER TABLE schedules ADD COLUMN {col} DATETIME"))
                    conn.commit()
                except Exception:
                    pass

            # 2. roastery_beans 테이블 신규 수집/큐레이션 컬럼 자동 스키마 마이그레이션
            roastery_cols = [
                ("avg_rating", "FLOAT DEFAULT 0.0"),
                ("review_count", "INTEGER DEFAULT 0"),
                ("positive_ratio", "FLOAT DEFAULT 0.0"),
                ("top_keywords", "TEXT"),
                ("curation_snapshot", "TEXT"),
            ]
            for col_name, col_type in roastery_cols:
                try:
                    conn.execute(text(f"ALTER TABLE roastery_beans ADD COLUMN {col_name} {col_type}"))
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

