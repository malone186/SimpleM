"""v1 라우터 취합 (공동 소유) — 알파벳순 삽입"""

from fastapi import APIRouter

from app.api.v1 import chatbot
from app.api.v1.admin import router as admin_router
from app.api.v1.auth import router as auth_router
from app.api.v1.inventory import router as inventory_router
from app.api.v1.operation import router as operation_router

api_router = APIRouter()

# [한글 주석: 알파벳순 라우터 등록 원칙을 고수합니다]
# A (admin, assistant, auth)
from app.api.v1.assistant import router as assistant_router
api_router.include_router(assistant_router)
api_router.include_router(admin_router)
api_router.include_router(auth_router)

# C (chatbot)
api_router.include_router(chatbot.router)

# I (inquiry, inventory)
from app.api.v1.inquiry import router as inquiry_router
api_router.include_router(inquiry_router)
api_router.include_router(inventory_router)

# M (membership) — 단골 회원 · 선불 충전
from app.api.v1.membership import router as membership_router
api_router.include_router(membership_router)

# O (operation)
api_router.include_router(operation_router)

# P (pos)
from app.api.v1.pos import router as pos_router
api_router.include_router(pos_router)

# S (sensor, settlement, staff)
from app.api.v1.sensor import router as sensor_router
api_router.include_router(sensor_router)

from app.api.v1.settlement import router as settlement_router
api_router.include_router(settlement_router)

from app.api.v1.staff_account import router as staff_account_router
api_router.include_router(staff_account_router)

from app.api.v1.staff import router as staff_router
api_router.include_router(staff_router)

from app.api.v1.store import router as store_router
api_router.include_router(store_router)

# R (rewards, roastery_search)
from app.api.v1.rewards import router as rewards_router
api_router.include_router(rewards_router)

from app.api.v1.roastery_search import router as roastery_search_router
api_router.include_router(roastery_search_router)
