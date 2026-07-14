"""FastAPI 엔트리포인트 (공동 소유) — 라우터 추가는 알파벳순"""
from fastapi import FastAPI
from app.api.v1.router import api_router

app = FastAPI(
    title="SimpleM Platform API",
    description="카페 사장님들을 위한 통합 플랫폼 SimpleM 1단계 API",
    version="1.0.0"
)

# API v1 라우터 등록
app.include_router(api_router, prefix="/api/v1")

@app.get("/")
def read_root():
    """서버 작동 헬스체크"""
    return {
        "success": True,
        "message": "SimpleM Platform Backend C Service is running."
    }
