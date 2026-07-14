# c:\STUDY\SimpleM\backend\app\schemas\inventory.py
from pydantic import BaseModel, Field
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

    class Config:
        from_attributes = True


# --- [재고(Stock) 및 변동 장부 관련 규격] ---

# 3. 재고 입고 및 수동 조정 신청서
class StockAdjust(BaseModel):
    ingredient_id: int = Field(..., description="변동시킬 재료의 고유 ID")
    quantity_change: float = Field(..., description="변동 수량 (입고는 양수 '+5.0', 차감/폐기는 음수 '-2.0')")
    description: str | None = Field(None, description="변동 사유 (예: '우유 5팩 입고', '우유 1팩 폐기')")

# 4. 실시간 재고 정보 응답 양식
class StockResponse(BaseModel):
    id: int
    ingredient_id: int
    current_quantity: float
    safety_quantity: float
    updated_at: datetime

    class Config:
        from_attributes = True


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

    class Config:
        from_attributes = True

# 8. 메뉴 상세 조회 시 반환할 레시피 한 줄의 세부 정보 규격
class RecipeDetail(BaseModel):
    ingredient_id: int
    ingredient_name: str
    quantity: float
    unit: str

# 9. 메뉴판 조회 시 레시피 재료 정보를 포함해서 보내주는 최종 상세 응답 규격
class MenuDetailResponse(MenuResponse):
    recipes: list[RecipeDetail] = Field(..., description="이 메뉴의 상세 조립 레시피 목록")
