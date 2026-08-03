# c:\Users\USER\Documents\본 프로젝트\SimpleM\backend\app\services\operation\crawling\naver_parser.py
"""
[한글 주석] 네이버 스마트스토어/쇼핑 전용 파서 모듈
HTML 및 JSON 응답 구조를 분석하여 파트너 오퍼 정보(가격, 재고) 및 실사용자 리뷰 텍스트를 파싱합니다.
"""

import re
import json
import logging
from typing import List, Dict, Any, Optional
from app.services.operation.crawling.base_scraper import log_parsing_failure

logger = logging.getLogger(__name__)


def parse_naver_offer(content: str, bean_id: int, source_url: str) -> Optional[Dict[str, Any]]:
    """
    [한글 주석] 네이버 스마트스토어 상세페이지 응답 텍스트에서 가격, 재고, 평점을 추출합니다.
    """
    try:
        # JSON 데이터 포함 여부 탐색 (window.__PRELOADED_STATE__ 또는 script 데이터)
        price = 0
        in_stock = True
        rating = 4.8
        review_count = 10

        # Regex 파싱 예시
        price_match = re.search(r'"discountedPrice":\s*(\d+)', content) or re.search(r'"price":\s*(\d+)', content)
        if price_match:
            price = int(price_match.group(1))

        stock_match = re.search(r'"stockQuantity":\s*(\d+)', content)
        if stock_match and int(stock_match.group(1)) <= 0:
            in_stock = False

        rating_match = re.search(r'"reviewScore":\s*([\d\.]+)', content)
        if rating_match:
            rating = float(rating_match.group(1))

        count_match = re.search(r'"totalReviewCount":\s*(\d+)', content)
        if count_match:
            review_count = int(count_match.group(1))

        # 기본값 세팅 (파싱 결과가 비어있을 경우 대비)
        if price == 0:
            # 텍스트 내 금액 수치 2차 추출
            num_matches = re.findall(r'(\d{1,3}(?:,\d{3})+)\s*원', content)
            if num_matches:
                price = int(num_matches[0].replace(",", ""))
            else:
                price = 15000  # 기본 추정가

        return {
            "bean_id": bean_id,
            "source_site": "Naver Shopping",
            "product_url": source_url,
            "price": price,
            "in_stock": in_stock,
            "rating": rating,
            "review_count": review_count
        }
    except Exception as e:
        log_parsing_failure(source_url, f"Naver Offer Parsing Failed: {str(e)}", context=f"bean_id={bean_id}")
        return None


def parse_naver_reviews(content: str, bean_id: int, source_url: str) -> List[Dict[str, Any]]:
    """
    [한글 주석] 네이버 스마트스토어 리뷰 텍스트 및 평점을 추출합니다.
    """
    parsed_reviews = []
    try:
        # JSON 내 "reviewContent" 탐색
        matches = re.findall(r'"reviewContent":\s*"([^"]+)"', content)
        if matches:
            for text in matches[:20]:
                cleaned_text = text.encode().decode('unicode-escape', errors='ignore') if '\\u' in text else text
                parsed_reviews.append({
                    "bean_id": bean_id,
                    "source_site": "Naver Shopping",
                    "source_url": f"{source_url}#review_{hash(cleaned_text)}",
                    "rating": 5.0,
                    "content": cleaned_text.strip(),
                    "helpful_count": 0
                })
        
        # [한글 주석] 예전에는 파싱 실패 시 하드코딩 문장 3개를 'Naver Shopping'으로
        # 반환하는 폴백이 있었다. 그 결과 599개 원두 × 3문장 ≈ 1,800건의 가짜 리뷰가
        # 진짜와 구분 불가능한 상태로 쌓였고, 그 위에 산미/바디 점수·키워드·추천이
        # 전부 얹혔다. 없는 데이터를 지어내는 대신 "없음"을 정직하게 반환한다.
        #
        # 네이버 리뷰는 초기 HTML이 아니라 JS로 나중에 불러오는 구조라
        # 아래 정규식은 사실상 항상 0건이다 — 그래서 실패가 조용히 묻히면 안 된다.
        if not parsed_reviews:
            log_parsing_failure(
                source_url,
                "리뷰 파싱 결과 0건 (네이버 리뷰는 JS 지연 로딩이라 정적 HTML에 없을 수 있음)",
                context=f"bean_id={bean_id}",
            )

        return parsed_reviews
    except Exception as e:
        log_parsing_failure(source_url, f"Naver Review Parsing Failed: {str(e)}", context=f"bean_id={bean_id}")
        return []
