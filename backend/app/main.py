"""FastAPI 엔트리포인트 (공동 소유) — 라우터 추가는 알파벳순"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.v1.router import api_router

app = FastAPI(title="SimpleM API")

# 개발용 CORS — 배포 전 허용 origin 확정 필요 (팀 공지 후 수정)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(api_router, prefix="/api/v1")


@app.get("/health")
async def health() -> dict:
    return {"status": "ok"}
