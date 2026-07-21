"""v1 라우터 취합 (공동 소유) — 알파벳순 삽입"""

from fastapi import APIRouter

from app.api.v1 import chatbot
from app.api.v1.admin import router as admin_router
from app.api.v1.auth import router as auth_router
from app.api.v1.inventory import router as inventory_router
from app.api.v1.operation import router as operation_router

api_router = APIRouter()

# [한글 주석: 알파벳순 라우터 등록 원칙을 고수합니다]
# A (admin, auth)
api_router.include_router(admin_router)
api_router.include_router(auth_router)

# C (chatbot)
api_router.include_router(chatbot.router)

# I (inquiry, inventory)
from app.api.v1.inquiry import router as inquiry_router
api_router.include_router(inquiry_router)
api_router.include_router(inventory_router)

# L (law)
from app.api.v1.law import router as law_router
api_router.include_router(law_router)

# O (operation)
api_router.include_router(operation_router)

# R (roastery_search)
from app.api.v1.roastery_search import router as roastery_search_router
api_router.include_router(roastery_search_router)
