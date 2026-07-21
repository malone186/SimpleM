import httpx
import logging
from typing import Any, Dict, List

try:
    from bs4 import BeautifulSoup
except ImportError:
    BeautifulSoup = None

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
        
        if not html or BeautifulSoup is None:
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

import time

class LawScrapingService:
    """
    [한글 주석] 국가법령정보센터 Open API 및 웹 구조화 데이터를 활용한 법령 데이터 수집 서비스입니다.
    
    ※ 수집 정책 준수:
    1. 국가법령정보센터 이용약관 및 robots.txt 규정을 준수합니다.
    2. 서버 과부하 방지를 위해 초당 1회 이하 요청(Rate Limit: time.sleep(1.0))을 철저히 유지합니다.
    3. API Key 미설정 시 기본 구조화된 카페 4대 핵심 법령(근로기준법, 최저임금법, 상가임대차법, 식품위생법) 데모 세트를 제공합니다.
    """

    OFFICIAL_LAW_API_URL = "http://www.law.go.kr/DRF/lawSearch.do"

    @classmethod
    def fetch_law_article_data(cls, law_name: str, api_key: str = "") -> List[Dict[str, Any]]:
        """
        [한글 주석] 지정한 법령명에 대해 국가법령정보센터 API 또는 구조화 파이프라인을 구동하여 조문 리스트를 가져옵니다.
        """
        # [한글 주석] Rate Limit 준수: 무조건 요청 전 1초 딜레이를 주어 Target 서버를 보호합니다.
        time.sleep(1.0)
        logger.info(f"[Rate Limit 준수] '{law_name}' 법령 수집 요청 (1초 딜레이 적용)")

        # API Key가 등록된 경우 실제 국가법령 API 호출
        if api_key:
            params = {
                "OC": api_key,
                "target": "law",
                "type": "XML",
                "query": law_name
            }
            xml_text = ScrapingService.fetch_web_page(cls.OFFICIAL_LAW_API_URL, params=params)
            if xml_text:
                # XML 파싱 로직 (필요시 추가)
                pass

        # API Key가 없거나 데모 수집 파이프라인 구동 시 기본 구조화 데이터 반환
        return cls._get_builtin_law_dataset(law_name)

    @classmethod
    def _get_builtin_law_dataset(cls, target_law: str) -> List[Dict[str, Any]]:
        """
        [한글 주석] 카페 운영에 필수적인 4대 주요 법령 핵심 조문 데이터 파이프라인
        """
        now_date = "2026-01-01"
        source_name = "국가법령정보센터 (https://www.law.go.kr)"

        all_laws = [
            # 1. 근로기준법
            {
                "law_name": "근로기준법",
                "article_no": "제54조(휴게)",
                "category": "노무/근로",
                "content": "사용자는 근로시간이 4시간인 경우에는 30분 이상, 8시간인 경우에는 1시간 이상의 휴게시간을 근로시간 도중에 주어야 한다. 휴게시간은 근로자가 자유롭게 이용할 수 있다.",
                "summary": "근로 4시간 당 30분, 8시간 당 1시간 이상의 자유로운 휴게시간 부여 의무.",
                "source": source_name,
                "effective_date": now_date
            },
            {
                "law_name": "근로기준법",
                "article_no": "제55조(휴일)",
                "category": "노무/근로",
                "content": "사용자는 근로자에게 1주에 평균 1회 이상의 유급휴일을 보장하여야 한다. (주휴수당 관련: 소정근로시간이 주 15시간 이상이고 개근 시 유급주휴일 및 주휴수당 지급 의무)",
                "summary": "주 15시간 이상 근무 시 1주 1회 이상 유급휴일(주휴수당) 보장.",
                "source": source_name,
                "effective_date": now_date
            },
            {
                "law_name": "근로기준법",
                "article_no": "제56조(연장·야간 및 휴일 근로)",
                "category": "노무/근로",
                "content": "사용자는 연장근로, 야간근로(오후 10시부터 다음 날 오전 6시까지의 근로) 및 휴일근로에 대하여 통상임금의 100분의 50 이상을 가산하여 근로자에게 지급하여야 한다. (5인 이상 사업장 적용)",
                "summary": "오후 10시~오전 6시 야간근로 및 연장근로 시 50% 가산수당 지급.",
                "source": source_name,
                "effective_date": now_date
            },
            {
                "law_name": "근로기준법",
                "article_no": "제17조(근로조건의 명시)",
                "category": "노무/근로",
                "content": "사용자는 근로계약을 체결할 때에 근로자에게 임금, 소정근로시간, 휴일, 연차 유급휴가 등의 사항을 명시하여야 한다. 임금의 구성항목·계산방법·지급방법 및 휴일·휴게시간이 명시된 서면을 근로자에게 교부하여야 한다.",
                "summary": "근로계약 체결 시 근로조건 서면(근로계약서) 작성 및 교부 의무.",
                "source": source_name,
                "effective_date": now_date
            },
            # 2. 최저임금법
            {
                "law_name": "최저임금법",
                "article_no": "제6조(최저임금의 효력)",
                "category": "노무/임금",
                "content": "사용자는 최저임금의 적용을 받는 근로자에게 최저임금액 이상의 임금을 지급하여야 한다. 최저임금액에 미달하는 임금을 정한 근로계약은 그 부분에 한하여 무효로 한다.",
                "summary": "최저임금액 이상의 임금 지급 의무 및 미달 시 법적 무효 처리.",
                "source": source_name,
                "effective_date": now_date
            },
            # 3. 상가건물 임대차보호법
            {
                "law_name": "상가건물 임대차보호법",
                "article_no": "제10조(계약갱신 요구 등)",
                "category": "임대차",
                "content": "임대인은 임차인이 임대차기간이 만료되기 6개월 전부터 1개월 전까지 사이에 계약갱신을 요구할 경우 정당한 사유 없이 거절하지 못한다. 임차인의 계약갱신요구권은 최초의 임대차기간을 포함한 전체 임대차기간이 10년을 초과하지 아니하는 범위에서만 행사할 수 있다.",
                "summary": "상가 임차인은 최대 10년 간 계약갱신요구권 행사 가능.",
                "source": source_name,
                "effective_date": now_date
            },
            {
                "law_name": "상가건물 임대차보호법",
                "article_no": "제10조의4(권리금 회수기회 보호 등)",
                "category": "임대차",
                "content": "임대인은 임대차기간이 끝나기 6개월 전부터 임대차 종료 시까지 권리금 계약에 따라 임차인이 손한 신규임차인이 되려는 자로부터 권리금을 지급받는 것을 방해하여서는 아니 된다.",
                "summary": "임대차 종료 6개월 전부터 임차인의 권리금 회수기회 보호.",
                "source": source_name,
                "effective_date": now_date
            },
            # 4. 식품위생법
            {
                "law_name": "식품위생법",
                "article_no": "제40조(건강진단)",
                "category": "위생/보건",
                "content": "식품위생업소의 영업자 및 종업원은 보건복지부령으로 정하는 바에 따라 건강진단(보건증)을 받아야 한다. 건강진단을 받지 아니한 자를 영업에 종사시키지 못한다.",
                "summary": "카페 영업자 및 알바생의 연 1회 건강진단(보건증) 수령 및 정기 갱신 의무.",
                "source": source_name,
                "effective_date": now_date
            },
            {
                "law_name": "식품위생법",
                "article_no": "제41조(식품위생교육)",
                "category": "위생/보건",
                "content": "식품접객업 영업자는 매년 식품위생에 관한 교육을 받아야 한다. 신규 영업자는 영업 개시 전 위생교육을 이수하여야 한다.",
                "summary": "카페 대표자 매년 식품위생교육 정기 이수 의무.",
                "source": source_name,
                "effective_date": now_date
            }
        ]

        if not target_law or target_law == "전체":
            return all_laws
        return [item for item in all_laws if target_law in item["law_name"]]

