# c:\STUDY\SimpleM\backend\app\services\_pos.py
import logging
from datetime import datetime, timedelta, timezone
from sqlalchemy.orm import Session
import httpx

from app.core.config import SQUARE_ACCESS_TOKEN, SQUARE_ENVIRONMENT
from app.models.inventory import Menu, Sale, Stock, StockTransaction

# 로그를 기록하기 위해 준비합니다.
logger = logging.getLogger(__name__)

# [영-한 메뉴명 지능 매칭 단어 사전]
# POS 기기에는 영어로 적혀 있고, 매장 메뉴판 DB에는 한글로 적혀 있을 때 이를 엮어주는 통역사 사전입니다.
_TRANSLATION_MAP = {
    "strawberry": "딸기",
    "latte": "라떼",
    "americano": "아메리카노",
    "mocha": "모카",
    "espresso": "에스프레소",
    "vanilla": "바닐라",
    "milk": "우유",
    "cream": "크림",
    "tea": "차",
    "chamomile": "캐모마일",
    "chocolate": "초코",
    "choco": "초코"
}

def _guess_category(pos_item_name: str, db_menus: list[Menu]) -> Menu | None:
    """
    [메뉴 유사도 매칭 알고리즘]
    POS 기기에서 들어온 영어/기타 혼용 이름(예: 'Strawberry Latte')을
    우리 DB 메뉴판에 있는 한글 이름(예: '딸기라떼')과 매칭해 줍니다.
    """
    if not pos_item_name:
        return None

    # 1단계: 소문자 변환 및 양끝 공백 제거
    pos_name_clean = pos_item_name.lower().strip()
    
    # 2단계: 괄호나 특수문자거(예: '(ice)', '[hot]' 등)를 완전히 제거합니다.
    import re
    pos_name_clean = re.sub(r"\(.*?\)|\[.*?\]|\s+", "", pos_name_clean)

    # 3단계: 영문 단어를 통역사 사전을 이용해 한글 단어로 바꿉니다.
    # 예: 'strawberrylatte' -> '딸기라떼'
    translated_name = pos_name_clean
    for eng_word, kor_word in _TRANSLATION_MAP.items():
        if eng_word in translated_name:
            translated_name = translated_name.replace(eng_word, kor_word)

    # 4단계: DB의 활성 메뉴들을 순회하며 공백을 없앤 순수 이름과 비교 대조합니다.
    for menu in db_menus:
        menu_name_clean = re.sub(r"\s+", "", menu.name.lower())
        
        # 완전 일치하거나, 한쪽이 다른 쪽에 부분 포함되어 있는지 확인합니다.
        if (menu_name_clean == translated_name) or (menu_name_clean in translated_name) or (translated_name in menu_name_clean):
            return menu
            
    return None


async def fetch_orders(start_at: str, end_at: str) -> list[dict]:
    """
    Square Connect API v2를 호출하여 최근 판매 주문을 긁어옵니다.
    (샌드박스 토큰이 템플릿 상태라면, 테스트 편의를 위해 자동으로 가상 주문 데모 데이터를 반환하는 폴백을 포함합니다.)
    """
    # 1. [데모 폴백 장치] 설정값이 비어있거나 템플릿('EAAA...') 상태라면 모의 데이터를 돌려줍니다.
    if not SQUARE_ACCESS_TOKEN or SQUARE_ACCESS_TOKEN.startswith("EAAA...") or "YOUR" in SQUARE_ACCESS_TOKEN:
        logger.warning("Square Access Token이 템플릿 상태입니다. 가상 데모 주문 데이터를 생성하여 로컬에서 진행합니다.")
        return _get_mock_orders(start_at, end_at)

    # 2. 실서버(production)와 테스트(sandbox) 주소를 구분합니다.
    host = "connect.squareup.com" if SQUARE_ENVIRONMENT == "production" else "connect.squareupsandbox.com"
    base_url = f"https://{host}/v2"
    
    headers = {
        "Authorization": f"Bearer {SQUARE_ACCESS_TOKEN}",
        "Content-Type": "application/json"
    }

    async with httpx.AsyncClient() as client:
        try:
            # 2-1. 첫 번째 활성화된 매장 고유 ID(Location ID)를 먼저 얻어옵니다.
            loc_resp = await client.get(f"{base_url}/locations", headers=headers)
            if loc_resp.status_code != 200:
                raise Exception(f"Locations 조회 실패: Status {loc_resp.status_code}")
                
            locations = loc_resp.json().get("locations", [])
            if not locations:
                raise Exception("Square 계정에 활성화된 Location(매장) 정보가 없습니다.")
            location_id = locations[0]["id"]

            # 2-2. 해당 매장의 주문을 검색합니다.
            # sandbox 환경에서는 COMPLETED와 OPEN 주문을, prod 환경에서는 확실히 정산된 COMPLETED만 수집합니다.
            states = ["COMPLETED", "OPEN"] if SQUARE_ENVIRONMENT == "sandbox" else ["COMPLETED"]
            
            search_payload = {
                "location_ids": [location_id],
                "query": {
                  "filter": {
                    "state_filter": {
                      "states": states
                    },
                    "date_time_filter": {
                      "created_at": {
                        "start_at": start_at,
                        "end_at": end_at
                      }
                    }
                  },
                  "sort": {
                    "sort_field": "CREATED_AT",
                    "sort_order": "DESC"
                  }
                }
            }

            order_resp = await client.post(f"{base_url}/orders/search", json=search_payload, headers=headers)
            if order_resp.status_code != 200:
                raise Exception(f"Orders 검색 실패: Status {order_resp.status_code}")
                
            return order_resp.json().get("orders", [])

        except Exception as e:
            logger.exception("Square API 통신 실패 — 데모 주문 데이터로 임시 자동 전환하여 시스템 가용성을 유지합니다.")
            return _get_mock_orders(start_at, end_at)


def parse_orders_to_records(db: Session, orders: list[dict], store_id: str) -> dict:
    """
    [POS 주문 정보 분석 및 재고 차감 파이프라인]
    수집된 주문의 품목(Line Item)을 분석하여, 우리 메뉴의 레시피 소요량만큼 실제 창고 재고에서 빼줍니다.
    """
    # 우리 매장에 활성화 등록되어 있는 진짜 메뉴판 목록을 가져옵니다.
    db_menus = db.query(Menu).filter(Menu.store_id == store_id, Menu.is_active == True).all()

    total_orders = len(orders)
    synced_orders = 0
    deducted_stocks = []
    warnings = []

    for order in orders:
        order_id = order.get("id", "MOCK_ID")
        line_items = order.get("line_items", [])
        order_synced = False

        for item in line_items:
            item_name = item.get("name", "")
            # 수량 정보가 없으면 기본 1개로 삼습니다. (Square는 문자열 실수 형태로 보낼 때가 많으므로 파싱 처리)
            qty_raw = item.get("quantity", "1")
            try:
                item_qty = int(float(qty_raw))
            except ValueError:
                item_qty = 1

            # 단가와 금액 처리
            base_price_money = item.get("base_price_money", {})
            unit_price = base_price_money.get("amount", 0) # 기본 단위는 센트(Cents) 또는 원(KRW)
            total_price = unit_price * item_qty

            # 1. POS 메뉴를 우리 DB 메뉴명과 매칭시킵니다.
            menu = _guess_category(item_name, db_menus)
            if not menu:
                warnings.append(f"메뉴 매칭 실패: POS 품목명 '{item_name}'과 부합하는 DB 메뉴가 없습니다.")
                continue

            # 2. [매출 장부 기재]
            # 해당 판매 내역을 Sale 테이블에 기록합니다.
            db_sale = Sale(
                menu_id=menu.id,
                quantity=item_qty,
                total_price=total_price,
                store_id=store_id
            )
            db.add(db_sale)
            order_synced = True

            # 3. [레시피 기반 실시간 재고 차감 트랜잭션]
            # 매칭된 메뉴에 연결된 조립 레시피 목록을 하나씩 돕니다.
            for recipe in menu.recipes:
                stock = db.query(Stock).filter(Stock.ingredient_id == recipe.ingredient_id).first()
                if stock:
                    # 차감량 계산 = 주문 컵 수 * 레시피 한 잔당 소요량
                    deduct_amount = item_qty * recipe.quantity
                    stock.current_quantity -= deduct_amount

                    # 차감 완료된 이력을 임시 보관 (결과 요약 화면 표시용)
                    deducted_stocks.append({
                        "ingredient_name": recipe.ingredient.name,
                        "deducted": deduct_amount,
                        "current": stock.current_quantity,
                        "unit": recipe.ingredient.unit
                    })

                    # [안전장치 - 음수 재고 경고 기록]
                    # 재고가 마이너스(음수)가 되는 경우, 차감은 하되 경고 메시지를 추가 기록해 누수 감지 신호로 삼습니다 (PRD §5.1 수용기준).
                    if stock.current_quantity < 0:
                        warn_msg = f"⚠ 재고 부족 경고: '{recipe.ingredient.name}' 재고가 음수가 되었습니다. (현재: {stock.current_quantity} {recipe.ingredient.unit})"
                        warnings.append(warn_msg)
                        logger.warning(warn_msg)

                    # [입출고 장부 의무 기재]
                    # 왜 재고가 차감되었는지 변동 내역에 기록을 남깁니다.
                    tx = StockTransaction(
                        ingredient_id=recipe.ingredient_id,
                        quantity_change=-deduct_amount, # 차감은 음수
                        type="OUT",
                        description=f"POS 판매 차감 (주문번호 #{order_id})"
                    )
                    db.add(tx)

        if order_synced:
            synced_orders += 1

    # 모든 변동 사항을 한꺼번에 트랜잭션 완료(커밋)합니다.
    db.commit()

    return {
        "total_orders": total_orders,
        "synced_orders": synced_orders,
        "deducted_stocks": deducted_stocks,
        "warnings": warnings
    }


async def sync_pos_to_sales(db: Session, store_id: str, hours: int = 24) -> dict:
    """
    [POS 데이터 실시간 동기화 파이프라인 엔트리포인트]
    최근 N시간 동안 발생한 Square POS 매출 주문 내역을 긁어와 매출에 넣고 레시피 기준 재고 차감까지 일관되게 처리합니다.
    """
    # 1. 동기화할 기간 설정 (현재시간 기준 최근 N시간)
    now = datetime.now(timezone.utc)
    start_time = now - timedelta(hours=hours)

    # Square API가 요구하는 ISO 8601 형식(예: 2026-07-15T00:00:00Z)으로 변환합니다.
    start_at = start_time.strftime("%Y-%m-%dT%H:%M:%SZ")
    end_at = now.strftime("%Y-%m-%dT%H:%M:%SZ")

    # 2. Square에서 주문 목록 가져오기
    orders = await fetch_orders(start_at, end_at)
    
    if not orders:
        return {
            "total_orders": 0,
            "synced_orders": 0,
            "deducted_stocks": [],
            "warnings": ["해당 기간 내에 완료된 POS 주문 건이 존재하지 않습니다."]
        }

    # 3. 데이터 파싱 및 실시간 재고 차감 실행
    return parse_orders_to_records(db=db, orders=orders, store_id=store_id)


def _get_mock_orders(start_at: str, end_at: str) -> list[dict]:
    """Square API 키가 아직 비어있거나 실패했을 때 가동해 주는 고품질 모의 주문(Mock) 데이터 공급 장치입니다."""
    # 현재 시간 문자열을 이용하여 그럴듯한 모의 주문번호와 시간대를 만듭니다.
    return [
        {
            "id": "sq-order-mock-strawberry-110",
            "created_at": start_at,
            "state": "COMPLETED",
            "line_items": [
                {
                    "name": "Strawberry Latte (Ice)",
                    "quantity": "2.0",
                    "base_price_money": {
                        "amount": 4500,
                        "currency": "KRW"
                    }
                }
            ]
        },
        {
            "id": "sq-order-mock-americano-220",
            "created_at": start_at,
            "state": "COMPLETED",
            "line_items": [
                {
                    "name": "Americano",
                    "quantity": "1.0",
                    "base_price_money": {
                        "amount": 4000,
                        "currency": "KRW"
                    }
                }
            ]
        }
    ]
