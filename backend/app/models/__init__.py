"""모델 등록 (공동 소유) — 알파벳순 유지"""

# A (ai.py)
from app.models.ai import ComplianceItem, GeneratedDocument, OcrDocument, OcrItem

# I (inventory.py)
from app.models.inventory import Ingredient, IngredientPriceHistory, Menu, Recipe, Stock, StockTransaction, Sale, Order, OrderItem

# L (law.py)
from app.models.law import LawArticle

# O (operation.py)
from app.models.operation import Employee, EstimatedPayroll, EstimatedSettlement, Expense, Schedule  # 정산/급여 및 지출 모델 불러오기

# R (roastery.py)
from app.models.roastery import Roastery, RoasteryBean

# U (user.py)
from app.models.user import User
