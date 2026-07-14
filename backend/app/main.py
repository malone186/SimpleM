# c:\STUDY\SimpleM\backend\app\main.py
from fastapi import FastAPI, Depends
from fastapi.middleware.cors import CORSMiddleware  # 브라우저 보안 경고(CORS)를 해결해 줄 자물쇠 해제 열쇠입니다.
from sqlalchemy.orm import Session
from sqlalchemy import text
from app.core.database import get_db, Base, engine
from app.api.v1.router import api_router

# [설계도 수집] 데이터베이스 테이블을 만들기 전에, models 폴더 안의 설계도들을 수집하여 등록합니다.
import app.models

# [안전장치] 서버가 처음 기동할 때, 우리가 설계한 DB 테이블(User 등)이 실제 DB에 없으면 자동으로 생성해 줍니다.
Base.metadata.create_all(bind=engine)


# FastAPI 가게(애플리케이션)를 개설합니다.
app = FastAPI(
    title="SimpleM 카페 통합 플랫폼 API",
    description="백엔드 C의 세무/예측/RAG 도구를 포함하고, 백엔드 A가 구현한 재고, 발주, 인증 기능이 포함된 서버 API 문서입니다.",
    version="1.0.0"
)

# [CORS 자물쇠 해제 설정]
# 프론트엔드 앱이 실행되는 브라우저 주소(8081번 포트)를 허용 목록으로 적어둡니다.
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

# 우리가 취합한 메인 API 라우터들을 서버 등록 데스크에 정식 등록합니다.
app.include_router(api_router, prefix="/api/v1")



# 1. 서버 작동 테스트용 첫 API (기본 주소로 들어왔을 때 환영 인사)
@app.get("/")
def read_root():
    return {
        "message": "SimpleM 카페 통합 플랫폼 백엔드 서버에 오신 것을 환영합니다!",
        "status": "online"
    }

# 2. 데이터베이스 접속이 실제로 잘 되는지 테스트해보는 맛보기 API
@app.get("/db-test")
def test_database_connection(db: Session = Depends(get_db)):
    try:
        # 데이터베이스에 "혹시 살아 있니?" 하고 가벼운 질문(SQL)을 던져봅니다.
        db.execute(text("SELECT 1"))
        return {
            "database": "success",
            "message": "PostgreSQL 데이터베이스(simpleM)와 연결이 아주 건강하게 성공했습니다!"
        }
    except Exception as e:
        return {
            "database": "fail",
            "error_detail": str(e),
            "message": "앗! 데이터베이스 연결에 문제가 발생했습니다. .env 파일의 주소나 패스워드를 점검해 주세요."
        }
