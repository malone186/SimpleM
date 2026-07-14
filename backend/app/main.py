# c:\STUDY\SimpleM\backend\app\main.py
from fastapi import FastAPI, Depends
from sqlalchemy.orm import Session
from sqlalchemy import text
from app.core.database import get_db

# FastAPI 가게(애플리케이션)를 개설합니다.
app = FastAPI(
    title="SimpleM 카페 통합 플랫폼 API",
    description="백엔드 A가 구현한 재고, 발주, 인증 기능이 포함된 서버 API 문서입니다.",
    version="1.0.0"
)

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
