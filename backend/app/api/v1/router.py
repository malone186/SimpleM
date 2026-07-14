"""v1 라우터 취합 (공동 소유) — 알파벳순 삽입"""

from fastapi import APIRouter

from app.api.v1 import chatbot
from app.api.v1.auth import router as auth_router
from app.api.v1.operation import router as operation_router

api_router = APIRouter()
<<<<<<< HEAD
api_router.include_router(auth_router)     # 백엔드 A (auth)
api_router.include_router(chatbot.router)  # 백엔드 B
# api_router.include_router(inventory.router)  # 백엔드 A
# api_router.include_router(operation.router)  # 백엔드 C
=======

# 알파벳순 라우터 등록
# A (auth)
api_router.include_router(auth_router)

# O (operation)
api_router.include_router(operation_router)

>>>>>>> f90bc2613fc7e42a76314ac238a7a8b9f4321b51
