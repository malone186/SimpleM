# c:\STUDY\SimpleM\backend\app\models\inventory.py
from sqlalchemy import Column, Integer, String, DateTime, ForeignKey, Float, Boolean, Numeric
from sqlalchemy.sql import func
from sqlalchemy.orm import relationship
from app.core.database import Base

# 1. Ingredient (재료 수납함)
class Ingredient(Base):
    """원재료 정보를 저장하는 테이블 모델"""
    __tablename__ = "ingredients"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(100), nullable=False)                         # 재료명 (예: 서울우유 1L)
    unit = Column(String(20), nullable=False)                          # 측정 단위 (예: ml, g, 개)
    current_price = Column(Integer, nullable=False, default=0)         # 현재 구매 가격(단가)
    store_id = Column(String(100), nullable=False)                     # 매장 식별 아이디 (Firebase 연동용)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())  # 단가 수정 시간

    # 테이블 간의 파이썬 객체 연결선 (관계 형성)
    stock = relationship("Stock", back_populates="ingredient", uselist=False, cascade="all, delete-orphan")
    transactions = relationship("StockTransaction", back_populates="ingredient", cascade="all, delete-orphan")
    recipes = relationship("Recipe", back_populates="ingredient", cascade="all, delete-orphan")


# 2. Menu (메뉴판)
class Menu(Base):
    """카페에서 판매하는 메뉴(상품) 정보 테이블 모델"""
    __tablename__ = "menus"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(100), nullable=False)                        # 메뉴명 (예: 아이스 아메리카노)
    selling_price = Column(Integer, nullable=False, default=0)        # 판매가 (KRW)
    store_id = Column(String(100), nullable=False)                    # 매장 식별 아이디
    is_active = Column(Boolean, default=True, nullable=False)         # 메뉴 숨김 활성화 여부
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)

    recipes = relationship("Recipe", back_populates="menu", cascade="all, delete-orphan")
    sales = relationship("Sale", back_populates="menu")


# 3. Recipe (메뉴와 재료 사이의 조합 비율 연결고리)
class Recipe(Base):
    """메뉴 1개를 조리할 때 소모되는 원재료들의 소요량(레시피) 테이블 모델"""
    __tablename__ = "recipes"

    id = Column(Integer, primary_key=True, index=True)
    
    # 어떤 메뉴의 레시피인가? (메뉴 테이블 연결)
    menu_id = Column(Integer, ForeignKey("menus.id", ondelete="CASCADE"), nullable=False)
    
    # 그 메뉴 조리에 어떤 재료가 들어가는가? (재료 테이블 연결)
    ingredient_id = Column(Integer, ForeignKey("ingredients.id", ondelete="CASCADE"), nullable=False)
    
    # 얼마나 소요되는가? (예: 원두 20.0g)
    quantity = Column(Float, nullable=False)

    menu = relationship("Menu", back_populates="recipes")
    ingredient = relationship("Ingredient", back_populates="recipes")


# 4. Stock (실시간 재고 상태)
class Stock(Base):
    """각 원부자재들의 실시간 창고 보관량 테이블 모델"""
    __tablename__ = "stocks"

    id = Column(Integer, primary_key=True, index=True)
    
    # 어떤 재료의 재고인가? (1대1 매핑 관계를 위해 Unique 제약을 줍니다.)
    ingredient_id = Column(Integer, ForeignKey("ingredients.id", ondelete="CASCADE"), unique=True, nullable=False)
    
    current_quantity = Column(Float, nullable=False, default=0.0)      # 현재 실시간 수량
    safety_quantity = Column(Float, nullable=False, default=0.0)       # 부족 알림을 띄울 안전 수량 (ERP-7용)
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False)

    ingredient = relationship("Ingredient", back_populates="stock")


# 5. StockTransaction (재고의 드나든 입출고 장부)
class StockTransaction(Base):
    """재고의 모든 변동 이력(입고, 차감, 수동 조정)을 기록하는 장부 모델"""
    __tablename__ = "stock_transactions"

    id = Column(Integer, primary_key=True, index=True)
    ingredient_id = Column(Integer, ForeignKey("ingredients.id", ondelete="CASCADE"), nullable=False)
    quantity_change = Column(Float, nullable=False)                    # 변동량 (예: 입고시 +10 서울우유, 판매시 -0.2L 서울우유)
    type = Column(String(20), nullable=False)                          # 변동 타입 (IN: 입고, OUT: 판매차감, ADJUST: 강제수정)
    description = Column(String(255), nullable=True)                   # 비고 사유 (예: "아메리카노 판매 차감", "영수증 OCR 입고")
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)

    ingredient = relationship("Ingredient", back_populates="transactions")


# 6. Sale (판매 영수증)
class Sale(Base):
    """판매 결제가 발생했을 때 들어오는 매출 거래내역 모델"""
    __tablename__ = "sales"

    id = Column(Integer, primary_key=True, index=True)
    menu_id = Column(Integer, ForeignKey("menus.id", ondelete="CASCADE"), nullable=False)
    quantity = Column(Integer, nullable=False, default=1)              # 판매 잔 수 (예: 2잔)
    total_price = Column(Integer, nullable=False)                      # 총 결제액
    store_id = Column(String(100), nullable=False)                    # 매장 식별 아이디
    sold_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)

    menu = relationship("Menu", back_populates="sales")


# 7. Order (발주서 요약)
class Order(Base):
    """재재료 발주 신청서의 전체 요약 정보 모델"""
    __tablename__ = "orders"

    id = Column(Integer, primary_key=True, index=True)
    store_id = Column(String(100), nullable=False)                    # 매장 식별 아이디
    status = Column(String(20), default="DRAFT", nullable=False)       # 발주 상태 (DRAFT: 초안, PENDING: 승인대기, CONFIRMED: 승인/발주완료)
    total_amount = Column(Integer, default=0, nullable=False)          # 총 주문 예상 금액
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())

    items = relationship("OrderItem", back_populates="order", cascade="all, delete-orphan")


# 8. OrderItem (발주서 한 줄 한 줄의 품목 리스트)
class OrderItem(Base):
    """하나의 발주서에 묶여 있는 상세 신청 재료와 수량 모델"""
    __tablename__ = "order_items"

    id = Column(Integer, primary_key=True, index=True)
    order_id = Column(Integer, ForeignKey("orders.id", ondelete="CASCADE"), nullable=False)
    ingredient_id = Column(Integer, ForeignKey("ingredients.id", ondelete="CASCADE"), nullable=False)
    quantity = Column(Float, nullable=False)                           # 발주 신청 수량
    price_at_order = Column(Integer, nullable=False)                   # 발주 신청 시점의 단가 (단가 이력 저장용)

    order = relationship("Order", back_populates="items")
