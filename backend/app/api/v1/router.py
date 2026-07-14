"""v1 라우터 취합 (공동 소유) — 알파벳순 삽입"""

from fastapi import APIRouter

from app.api.v1 import chatbot

api_router = APIRouter()
api_router.include_router(chatbot.router)  # 백엔드 B
# api_router.include_router(inventory.router)  # 백엔드 A
# api_router.include_router(operation.router)  # 백엔드 C
