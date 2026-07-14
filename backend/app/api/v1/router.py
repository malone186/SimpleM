"""v1 라우터 취합 (공동 소유) — 알파벳순 삽입"""
from fastapi import APIRouter
from app.api.v1.operation import router as operation_router

api_router = APIRouter()

# 알파벳순 라우터 등록
api_router.include_router(operation_router)
