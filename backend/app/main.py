"""FastAPI 엔트리포인트 (공동 소유) — 라우터 추가는 알파벳순"""

import logging

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.api.v1.router import api_router
from app.core.database import Base, engine, get_db, SessionLocal

# [설계도 수집] 데이터베이스 테이블을 만들기 전에, models 폴더 안의 설계도들을 수집하여 등록합니다.
import app.models  # noqa: F401

logger = logging.getLogger(__name__)

# [안전장치] 서버가 처음 기동할 때, 우리가 설계한 DB 테이블(User 등)이 실제 DB에 없으면 자동으로 생성해 줍니다.
# DB가 꺼져 있어도 서버 자체는 뜨도록 한다 — DB와 무관한 기능(OCR 등)은 독립 동작해야 함 (PRD §7)
try:
    Base.metadata.create_all(bind=engine)
    
    # [한글 주석] 로그인 데모를 즉시 하실 수 있게 테스트용 사장님 계정을 자동으로 생성(시딩)해 둡니다.
    db_session = SessionLocal()
    try:
        from app.core.auth import get_password_hash
        from app.models.user import User
        owner_exists = db_session.query(User).filter(User.email == "owner@cafe.com").first()
        if not owner_exists:
            hashed_pwd = get_password_hash("owner123")
            test_user = User(
                email="owner@cafe.com",
                hashed_password=hashed_pwd,
                name="포슬이",
                store_name="포슬카페"
            )
            db_session.add(test_user)
            db_session.commit()
            logger.info("🎉 테스트용 사장님 계정이 자동으로 생성되었습니다: owner@cafe.com / owner123")
    except Exception as seed_err:
        logger.error(f"테스트 계정 자동 생성 중 오류 발생: {seed_err}")
    finally:
        db_session.close()
except Exception:
    logger.exception("DB 테이블 자동 생성 실패 — DB 연결을 확인하세요. DB 없이 서버를 계속 띄웁니다.")

app = FastAPI(
    title="SimpleM 카페 통합 플랫폼 API",
    description="재고·발주·운영·AI(챗봇/OCR/리포트) 기능을 제공하는 SimpleM 백엔드 API",
    version="1.0.0",
)

# [CORS 설정] 프론트엔드 앱이 실행되는 브라우저 주소(8081번 포트)를 허용 목록으로 적어둡니다.
origins = [
    "http://localhost:8081",
    "http://127.0.0.1:8081",
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,      # 8081번 포트에서 오는 신호는 다 받아줍니다.
    allow_credentials=True,     # 로그인 쿠키나 토큰 정보를 전달받는 것을 허용합니다.
    allow_methods=["*"],        # GET, POST, PUT, DELETE 등 모든 행동(메소드)을 허용합니다.
    allow_headers=["*"],        # 어떤 요청 헤더 정보가 와도 다 수용합니다.
)

app.include_router(api_router, prefix="/api/v1")


# 1. 서버 작동 테스트용 첫 API (기본 주소로 들어왔을 때 환영 인사)
@app.get("/")
def read_root():
    return {
        "message": "SimpleM 카페 통합 플랫폼 백엔드 서버에 오신 것을 환영합니다!",
        "status": "online",
    }


# 2. 데이터베이스 접속이 실제로 잘 되는지 테스트해보는 맛보기 API
@app.get("/db-test")
def test_database_connection(db: Session = Depends(get_db)):
    try:
        # 데이터베이스에 "혹시 살아 있니?" 하고 가벼운 질문(SQL)을 던져봅니다.
        db.execute(text("SELECT 1"))
        return {
            "database": "success",
            "message": "PostgreSQL 데이터베이스(simpleM)와 연결이 아주 건강하게 성공했습니다!",
        }
    except Exception as e:
        return {
            "database": "fail",
            "error_detail": str(e),
            "message": "앗! 데이터베이스 연결에 문제가 발생했습니다. .env 파일의 주소나 패스워드를 점검해 주세요.",
        }


@app.get("/health")
async def health() -> dict:
    return {"status": "ok"}
