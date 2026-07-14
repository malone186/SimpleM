"""v1 라우터 취합 (공동 소유) — 알파벳순 삽입"""
from fastapi import APIRouter
from app.api.v1.auth import router as auth_router

api_router = APIRouter()

# A (auth)
api_router.include_router(auth_router)

