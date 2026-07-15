"""FastAPI 엔트리포인트 (공동 소유) — 라우터 추가는 알파벳순"""

import logging

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.api.v1.router import api_router
from app.core.database import Base, engine, get_db

# [설계도 수집] 데이터베이스 테이블을 만들기 전에, models 폴더 안의 설계도들을 수집하여 등록합니다.
import app.models  # noqa: F401

logger = logging.getLogger(__name__)

# [안전장치] 서버가 처음 기동할 때, 우리가 설계한 DB 테이블(User 등)이 실제 DB에 없으면 자동으로 생성해 줍니다.
# DB가 꺼져 있어도 서버 자체는 뜨도록 한다 — DB와 무관한 기능(OCR 등)은 독립 동작해야 함 (PRD §7)
try:
    Base.metadata.create_all(bind=engine)
except Exception:
    logger.exception("DB 테이블 자동 생성 실패 — DB 연결을 확인하세요. DB 없이 서버를 계속 띄웁니다.")

app = FastAPI(
    title="SimpleM 카페 통합 플랫폼 API",
    description="재고·발주·운영·AI(챗봇/OCR/리포트) 기능을 제공하는 SimpleM 백엔드 API",
    version="1.0.0",
)

# [CORS 설정] 
# 로컬 개발 및 기기 간 IP 접속(Failed to fetch) 시의 브라우저 CORS 차단을 방지하기 위해 
# 모든 http/https 오리진 주소 접속을 허용하되, 인증 토큰 전달(credentials)도 안전하게 성립시킵니다.
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex="https?://.*",  # 192.168.x.x 또는 localhost 등 모든 오리진 주소를 정규식 허용
    allow_credentials=True,             # 인증 정보(토큰/쿠키) 전송을 허용
    allow_methods=["*"],                # 모든 HTTP 메소드 허용
    allow_headers=["*"],                # 모든 커스텀 헤더 허용
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
