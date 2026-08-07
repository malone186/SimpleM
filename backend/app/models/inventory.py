# c:\STUDY\SimpleM\backend\app\models\inventory.py
from sqlalchemy import Column, Integer, String, DateTime, ForeignKey, Float, Boolean, Numeric, UniqueConstraint
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
    store_id = Column(String(100), nullable=False, index=True)         # 매장 식별 아이디 (Firebase 연동용)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())  # 단가 수정 시간

    # 테이블 간의 파이썬 객체 연결선 (관계 형성)
    stock = relationship("Stock", back_populates="ingredient", uselist=False, cascade="all, delete-orphan")
    transactions = relationship("StockTransaction", back_populates="ingredient", cascade="all, delete-orphan")
    recipes = relationship("Recipe", back_populates="ingredient", cascade="all, delete-orphan")
    price_histories = relationship(
        "IngredientPriceHistory",
        back_populates="ingredient",
        cascade="all, delete-orphan",
        order_by="IngredientPriceHistory.changed_at.desc()"
    )




# 1-2. IngredientPriceHistory (식재료 단가 이력 수납함)
class IngredientPriceHistory(Base):
    """식재료의 단가 변동 이력을 추적 보관하는 테이블 모델"""
    __tablename__ = "ingredient_price_histories"

    id = Column(Integer, primary_key=True, index=True)
    ingredient_id = Column(Integer, ForeignKey("ingredients.id", ondelete="CASCADE"), nullable=False)
    price = Column(Integer, nullable=False)                            # 당시 변경된 매입 단가 (KRW)
    changed_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False) # 가격 변동 일시

    ingredient = relationship("Ingredient", back_populates="price_histories")


# 2. Menu (메뉴판)
class Menu(Base):
    """카페에서 판매하는 메뉴(상품) 정보 테이블 모델"""
    __tablename__ = "menus"
    # 한 매장에 같은 이름의 메뉴는 하나뿐이다.
    # 코드에서 '있는지 확인 → 없으면 넣기'로 막고 있었는데, 그 두 단계 사이에 다른 요청이
    # 끼어들면 둘 다 '없다'고 판단해 같은 메뉴가 두 번 들어간다(메뉴판을 두 기기에서
    # 동시에 올리는 경우). 확인이 아니라 DB가 막아야 틈이 없다.
    __table_args__ = (UniqueConstraint("store_id", "name", name="uq_menu_store_name"),)

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
    store_id = Column(String(100), nullable=False, index=True)        # 매장 식별 아이디
    sold_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False, index=True)

    # [단골 관리 — 백엔드 B 추가] 누가 샀는지. 재방문 주기 계산의 근거가 된다.
    # 비회원 판매는 NULL이므로 기존 매출 집계에는 영향이 없다.
    customer_id = Column(Integer, ForeignKey("customers.id", ondelete="SET NULL"),
                         nullable=True, index=True)
    # CASH / CARD / CREDIT(선불잔액) / UNKNOWN(과거 데이터)
    # CREDIT은 그날 새로 들어온 돈이 아니라 예전 선수금이 매출로 바뀐 것이라
    # 실제 입금액을 볼 때 반드시 분리해야 한다.
    payment_method = Column(String(10), nullable=True)

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
    # [한글 주석] 이 발주 항목에 기재된 식자재(Ingredient) 정보를 즉시 매핑해서 가져올 수 있게 릴레이션십 관계선을 구축합니다.
    ingredient = relationship("Ingredient")


def ensure_menu_unique_constraint(engine) -> None:
    """[자가치유 스키마] menus에 (store_id, name) 유니크 제약을 보강한다.

    없으면 같은 메뉴가 두 번 등록될 수 있다. 코드에서 '있는지 확인 → 없으면 넣기'로
    막고 있었지만, 그 두 단계 사이에 다른 요청이 끼어들면 둘 다 '없다'고 판단한다
    (메뉴판을 두 기기에서 동시에 올리는 경우). 확인이 아니라 DB가 막아야 틈이 없다.

    create_all은 기존 테이블에 제약을 추가하지 않으므로 기동 시 여기서 보강한다.
    이미 중복 데이터가 있으면 제약 추가가 실패하는데, 그때는 경고만 남기고 넘어간다 —
    서버가 못 뜨는 것보다 낫고, 로그를 보고 중복을 정리한 뒤 다시 뜨면 걸린다.

    ※ menus는 백엔드 A 담당 테이블이다. 이 보강은 팀에 공유할 것.
    """
    import logging

    from sqlalchemy import inspect, text

    log = logging.getLogger(__name__)
    try:
        insp = inspect(engine)
        if not insp.has_table("menus"):
            return
        names = {u.get("name") for u in insp.get_unique_constraints("menus")}
        if "uq_menu_store_name" in names:
            return
    except Exception as e:
        log.warning("[메뉴 스키마] menus 점검 실패 — 건너뜁니다: %s", e)
        return

    # SQLite는 기존 테이블에 제약을 붙일 수 없다(테이블 재작성이 필요).
    # 운영 DB는 Postgres이고, 로컬 SQLite는 create_all로 처음부터 제약을 갖고 만들어진다.
    if engine.dialect.name == "sqlite":
        return

    try:
        with engine.begin() as conn:
            conn.execute(text(
                "ALTER TABLE menus ADD CONSTRAINT uq_menu_store_name UNIQUE (store_id, name)"
            ))
        log.info("[메뉴 스키마] menus에 (store_id, name) 유니크 제약을 추가했습니다")
    except Exception as e:
        log.warning(
            "[메뉴 스키마] 유니크 제약 추가 실패 — 같은 매장에 이름이 같은 메뉴가 "
            "이미 있는지 확인하세요: %s", e
        )


# 자주 조회되는 컬럼의 인덱스 목록 — 모델의 index=True와 이름을 맞춘다 (ix_<table>_<column>).
# create_all은 기존 테이블에 인덱스를 추가하지 않으므로 기동 시 ensure로 보강한다.
_PERFORMANCE_INDEXES = [
    ("sales", "ix_sales_store_id", "store_id"),
    ("sales", "ix_sales_sold_at", "sold_at"),
    ("ingredients", "ix_ingredients_store_id", "store_id"),
    ("schedules", "ix_schedules_employee_id", "employee_id"),
    ("schedules", "ix_schedules_date", "date"),
    ("expenses", "ix_expenses_store_id", "store_id"),
]


def ensure_performance_indexes(engine) -> None:
    """[자가치유 스키마] 대시보드·세무·급여가 매번 거르는 컬럼의 인덱스를 멱등하게 보강한다.

    sales(store_id, sold_at)는 거의 모든 조회의 WHERE 절인데 인덱스가 없어
    행이 쌓일수록 풀스캔이 늘었다 (2026-08-06 감사). IF NOT EXISTS라 재기동마다
    카탈로그 확인만 하고 지나간다. 권한이 없으면(공유 DB 소유주 분리) 경고만 남긴다.

    ※ sales·schedules·expenses는 팀원 담당 테이블이다. 이 보강은 팀에 공유할 것.
    """
    import logging

    from sqlalchemy import inspect, text

    log = logging.getLogger(__name__)
    try:
        insp = inspect(engine)
        tables = set(insp.get_table_names())
    except Exception as e:
        log.warning("[인덱스 보강] 테이블 목록 조회 실패 — 건너뜁니다: %s", e)
        return

    for table, index_name, column in _PERFORMANCE_INDEXES:
        if table not in tables:
            continue
        try:
            with engine.begin() as conn:
                conn.execute(text(
                    f'CREATE INDEX IF NOT EXISTS {index_name} ON {table} ("{column}")'
                ))
        except Exception as e:
            log.warning("[인덱스 보강] %s.%s 실패 (권한/락 확인): %s", table, column, e)
