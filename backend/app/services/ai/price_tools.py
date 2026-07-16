"""가격 비교 챗봇 도구 (백엔드 B)

발주 전 재료의 인터넷 최저가를 비교한다 — 다나와(+네이버쇼핑 API 키 있으면 병용).
"""

import json

from langchain_core.tools import tool

from app.services.ai import price_service


@tool
def compare_product_prices(product_name: str, current_price: int = 0) -> str:
    """재료/상품의 인터넷 가격을 비교한다 — 가격비교 사이트에서 최저가 후보 상위 5개를
    가격 오름차순으로 돌려준다 (상품명·가격·판매처·상품 링크·스펙 포함).
    current_price에 현재 매입 단가를 넣으면 절감률(saving_pct, 양수=더 저렴)도 계산된다.
    발주 관련 질문에서 '더 싸게 살 수 있는지' 물어보면 이 도구를 쓴다."""
    try:
        return json.dumps(
            price_service.compare_prices(product_name, current_price=current_price),
            ensure_ascii=False,
        )
    except price_service.PriceError as e:
        return str(e)


TOOLS = [compare_product_prices]
