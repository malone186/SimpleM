# c:\STUDY\SimpleM\backend\app\services\operation\scraping_service.py
import httpx
from bs4 import BeautifulSoup
import logging
from typing import Any, Dict, List

# 로깅을 기록하기 위해 설정합니다.
logger = logging.getLogger(__name__)

class ScrapingService:
    """원두 시세 및 매장 운영 법령 크롤링을 처리하기 위한 기본 서비스 엔진입니다."""

    @staticmethod
    def fetch_web_page(url: str, params: Dict[str, Any] = None) -> str | None:
        """
        [공통 HTTP 요청 핸들러]
        지정한 대상 웹사이트의 HTML 콘텐츠를 안전하게 긁어옵니다.
        네트워크 에러 발생 시 예외 처리를 통해 시스템이 멈추지 않도록 보완합니다.
        """
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
        }
        try:
            # 8초 내에 응답이 없으면 끊어내어 백엔드가 정지하는 것을 막습니다.
            with httpx.Client(timeout=8.0, headers=headers) as client:
                response = client.get(url, params=params)
                response.raise_for_status()
                return response.text
        except httpx.HTTPStatusError as e:
            logger.error(f"서버 응답 오류 (HTTP {e.response.status_code}): {url}")
            return None
        except httpx.RequestError as e:
            logger.error(f"네트워크 연결 요청 실패: {str(e)}")
            return None

    @classmethod
    def scrape_roastery_bean_prices(cls, search_query: str) -> List[Dict[str, Any]]:
        """
        [원두 시세 크롤러 골격]
        지정한 원두 이름을 쇼핑 정보 사이트에서 검색해 최저가와 쇼핑 페이지 정보를 추출합니다.
        """
        # 다나와 등의 쇼핑 검색 포털을 타겟으로 파라미터를 넘겨 검색합니다.
        url = "https://search.danawa.com/dsearch.php"
        html = cls.fetch_web_page(url, params={"query": f"{search_query} 원두"})
        
        if not html:
            return []
            
        results = []
        try:
            soup = BeautifulSoup(html, "lxml")
            # 상위 5개의 상품 아이템 리스트를 긁어와 요약합니다.
            for item in soup.select("li.prod_item")[:5]:
                name_el = item.select_one("p.prod_name a")
                price_el = item.select_one("p.price_sect strong")
                if name_el and price_el:
                    name = name_el.get_text(strip=True)
                    price_val = price_el.get_text(strip=True).replace(",", "")
                    try:
                        price = int(price_val)
                    except ValueError:
                        price = 0
                    results.append({
                        "name": name,
                        "price": price,
                        "url": name_el.get("href", "")
                    })
        except Exception as e:
            logger.exception(f"원두 스크래핑 파싱 에러: {str(e)}")
            
        return results
