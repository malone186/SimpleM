# c:\STUDY\SimpleM\backend\app\schemas\inventory.py
from pydantic import BaseModel, Field, ConfigDict
from datetime import datetime

# --- [재재료(Ingredient) 관련 규격] ---

# 1. 재료 등록 신청서 (프론트엔드 -> 백엔드)
class IngredientCreate(BaseModel):
    name: str = Field(..., min_length=1, description="재료명 (예: 서울우유 1L)")
    unit: str = Field(..., min_length=1, description="측정 단위 (예: ml, g, 개)")
    current_price: int = Field(0, ge=0, description="현재 구매 가격(단가, 0원 이상)")

# 2. 재료 정보 응답 양식 (백엔드 -> 프론트엔드)
class IngredientResponse(BaseModel):
    id: int
    name: str
    unit: str
    current_price: int
    store_id: str
    created_at: datetime
    updated_at: datetime | None

    model_config = ConfigDict(from_attributes=True)


# 2-2. 재료 단가 변동 이력 응답 양식 (백엔드 -> 프론트엔드)
class IngredientPriceHistoryResponse(BaseModel):
    id: int
    ingredient_id: int
    price: int
    changed_at: datetime

    model_config = ConfigDict(from_attributes=True)



# 1-3. 재료 단가 수정 신청서
class IngredientPriceUpdate(BaseModel):
    price: int = Field(..., ge=0, description="새로운 단가 (KRW, 0원 이상)")


# --- [재고(Stock) 및 변동 장부 관련 규격] ---

# 3. 재고 입고 및 수동 조정 신청서
class StockAdjust(BaseModel):

    ingredient_id: int = Field(..., description="변동시킬 재료의 고유 ID")
    quantity_change: float = Field(..., description="변동 수량 (입고는 양수 '+5.0', 차감/폐기는 음수 '-2.0')")
    description: str | None = Field(None, description="변동 사유 (예: '우유 5팩 입고', '우유 1팩 폐기')")

# 3-1. [백엔드 B 추가] 재고 현황 목록 응답 — 재료 정보와 실시간 수량을 합친 형태
class StockDetailResponse(BaseModel):
    ingredient_id: int
    name: str
    unit: str
    current_price: int
    current_quantity: float
    safety_quantity: float
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


# 4. 실시간 재고 정보 응답 양식
class StockResponse(BaseModel):
    id: int
    ingredient_id: int
    current_quantity: float
    safety_quantity: float
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


# --- [레시피(Recipe) 및 메뉴(Menu) 관련 규격] ---

# 5. 메뉴 등록 시 동봉할 레시피 세부 품목 규격
class RecipeCreate(BaseModel):
    ingredient_id: int = Field(..., description="들어가는 재료 고유 ID")
    quantity: float = Field(..., gt=0.0, description="들어가는 용량/수량 (0보다 커야 함, 예: 20.0)")

# 6. 메뉴 및 레시피 일괄 등록 신청서
class MenuCreate(BaseModel):
    name: str = Field(..., min_length=1, description="메뉴명 (예: 아이스 아메리카노)")
    selling_price: int = Field(..., ge=0, description="판매가 (KRW)")
    recipes: list[RecipeCreate] = Field(..., description="이 메뉴를 만들 때 들어가는 레시피 재료 목록")

# 7. 메뉴 기본 응답 양식
class MenuResponse(BaseModel):
    id: int
    name: str
    selling_price: int
    store_id: str
    is_active: bool
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)

# 8. 메뉴 상세 조회 시 반환할 레시피 한 줄의 세부 정보 규격
class RecipeDetail(BaseModel):
    ingredient_id: int
    ingredient_name: str
    quantity: float
    unit: str

# 9. 메뉴판 조회 시 레시피 재료 정보를 포함해서 보내주는 최종 상세 응답 규격
class MenuDetailResponse(MenuResponse):
    recipes: list[RecipeDetail] = Field(..., description="이 메뉴의 상세 조립 레시피 목록")
    cost_price: int = Field(0, description="메뉴를 제조하는 데 드는 총 원재료비 (KRW)")
    cost_ratio: float = Field(0.0, description="메뉴의 최종 원가율 (%)")



# --- [발주(Order) 관련 규격] ---

# 10. 발주 상세 품목 응답 규격 (가게 사장님 화면에 보여줄 세부 정보)
class OrderItemResponse(BaseModel):
    id: int
    ingredient_id: int
    ingredient_name: str                                               # 재료명 (예: 에티오피아 예가체프)
    quantity: float                                                    # 발주 신청 수량
    price_at_order: int                                                # 발주 신청 당시의 단가

    model_config = ConfigDict(from_attributes=True)


# 11. 발주서 전체 정보 응답 규격 (공급처 카드 UI 대응을 위한 가상 필드 포함)
class OrderResponse(BaseModel):
    id: int
    store_id: str
    status: str                                                        # 발주 상태 (DRAFT, CONFIRMED, REJECTED)
    total_amount: int                                                  # 총 주문 예상 금액
    created_at: datetime
    updated_at: datetime | None = None
    
    # [가상 필드] 데이터베이스 구조를 바꾸지 않고도 프론트엔드 UI를 풍성하게 채워주는 꿀정보들입니다.
    vendor: str = Field(..., description="공급처명 (예: 커피리브레 (로스터리), 서울F&B)")
    reason: str = Field(..., description="추천/발주 사유 (예: 예가체프 안전재고 미달)")
    source: str = Field("AI 예측 추천", description="발주 생성 출처")
    items: list[OrderItemResponse] = Field(..., description="발주서에 묶여 있는 상세 품목 리스트")

    model_config = ConfigDict(from_attributes=True)


# 12. 발주 상태 업데이트 신청서 (프론트엔드 -> 백엔드, 승인/반려용)
class OrderStatusUpdate(BaseModel):
    status: str = Field(..., description="변경할 상태값 (CONFIRMED: 승인완료, REJECTED: 반려)")


# --- [외부 로스터리 및 원두 탐색 관련 규격 B] ---

# 13. 로스터리 브랜드 정보 응답 규격
class RoasteryResponse(BaseModel):
    id: int
    name: str
    thumbnail_url: str | None = None
    roastery_info: str | None = None
    file_path: str | None = None

    model_config = ConfigDict(from_attributes=True)


# 14. 로스터리 원두 상품 정보 응답 규격 (로스터리 정보 조인 포함)
class RoasteryBeanResponse(BaseModel):
    id: int
    name: str
    price: int
    roastery_id: int
    thumbnail_url: str | None = None
    product_url: str | None = None
    date_added: str | None = None
    best: bool
    new: bool
    sold_out: bool
    description: str | None = None
    country: str | None = None
    process: str | None = None
    blend: bool
    decaf: bool
    gesha: bool
    price_per_gram: float | None = None
    naver_product_id: str | None = None
    roastery: RoasteryResponse | None = None

    model_config = ConfigDict(from_attributes=True)


