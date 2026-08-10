"""모델 등록 (공동 소유) — 알파벳순 유지"""

# A (ai.py)
from app.models.ai import (
    AdminAccount, AdminNotification, AdminUserNote, AiWarmCache, CafeReviewLink, ChatIncident,
    ChatQuota, ChatSession, ComplianceItem, DailySalesEntry, DeviceToken, EmployeeAvailability,
    EmployeeProfile, FixedCostSetting, GeneratedDocument, InsightAck, NearbyCafeWatch,
    NotificationSetting, OcrDocument, OcrItem, OwnedItem, PointLedger, PosConnection,
    PosSyncedOrder, SentNotification, SettlementSetting, StoreProfile, TodoItem,
)

# C (checklist.py) — 근무 체크리스트(매일 반복 루틴)
from app.models.checklist import ChecklistCheck, ChecklistItem

# I (inquiry.py & inventory.py)
from app.models.inquiry import Inquiry
from app.models.inventory import Ingredient, IngredientPriceHistory, Menu, Recipe, Stock, StockTransaction, Sale, Order, OrderItem

# M (membership.py) — 단골 회원 · 선불 충전
from app.models.membership import (
    BalanceTransaction, ChargePlan, CheckIn, Coupon, Customer, StaffAccount, StoreQr,
)

# O (operation.py)
from app.models.operation import Employee, EmployeeUnavailability, EstimatedPayroll, EstimatedSettlement, Expense, Schedule  # 정산/급여 및 지출 모델 불러오기

# R (roastery.py)
from app.models.roastery import BeanPriceHistory, BeanReview, ProductOffer, Roastery, RoasteryBean

# T (tracking.py)
from app.models.tracking import TrackingEvent

# U (user.py)
from app.models.user import User
