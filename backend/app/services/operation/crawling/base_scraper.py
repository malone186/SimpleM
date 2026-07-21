# c:\Users\USER\Documents\본 프로젝트\SimpleM\backend\app\services\operation\crawling\base_scraper.py
"""
[한글 주석] 크롤링 공통 베이스 스크레이퍼 모듈
User-Agent 명시, Rate Limit(요청 지연), Exponential Backoff 재시도 및 파싱 실패 이력 로깅 포함
"""

import os
import time
import logging
import urllib.request
import urllib.error
from typing import Optional, Dict, Any

logger = logging.getLogger(__name__)

# [한글 주석] 파싱/수집 실패 로그 전용 파일 경로
LOG_DIR = os.path.join(os.getcwd(), "data")
os.makedirs(LOG_DIR, exist_ok=True)
PARSING_ERROR_LOG_PATH = os.path.join(LOG_DIR, "parsing_error.log")


def log_parsing_failure(source_url: str, error_msg: str, context: Optional[str] = None):
    """[한글 주석] 수집/파싱 실패 발생 시 실패 전용 이력 파일에 기록합니다."""
    timestamp = time.strftime("%Y-%m-%d %H:%M:%S")
    log_line = f"[{timestamp}] URL: {source_url} | ERROR: {error_msg} | CONTEXT: {context or ''}\n"
    try:
        with open(PARSING_ERROR_LOG_PATH, "a", encoding="utf-8") as f:
            f.write(log_line)
    except Exception as e:
        logger.error("실패 로그 작성 중 추가 에러 발생: %s", str(e))


class BaseScraper:
    """[한글 주석] 외부 웹 수집용 기본 스크레이퍼 클래스"""

    def __init__(self, rate_limit_sec: float = 1.0, max_retries: int = 3, user_agent: Optional[str] = None):
        self.rate_limit_sec = rate_limit_sec
        self.max_retries = max_retries
        self.user_agent = user_agent or "SimpleM-CoffeeBot/1.0 (+http://simplem.app; cafe-management-bot)"
        self.last_request_time = 0.0

    def _wait_for_rate_limit(self):
        """[한글 주석] 서버 과부하 방지를 위한 요청 간격 지연(Rate limit) 처리"""
        elapsed = time.time() - self.last_request_time
        if elapsed < self.rate_limit_sec:
            time.sleep(self.rate_limit_sec - elapsed)
        self.last_request_time = time.time()

    def fetch_url(self, url: str) -> Optional[str]:
        """
        [한글 주석]
        지정한 URL로부터 HTML/JSON 데이터를 지수 백오프(Exponential Backoff) 재시도 로직으로 안전하게 가져옵니다.
        """
        self._wait_for_rate_limit()

        headers = {
            "User-Agent": self.user_agent,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,json;q=0.8,*/*;q=0.8",
            "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7"
        }

        req = urllib.request.Request(url, headers=headers)

        for attempt in range(1, self.max_retries + 1):
            try:
                with urllib.request.urlopen(req, timeout=10) as response:
                    if response.status == 200:
                        charset = response.headers.get_content_charset() or "utf-8"
                        return response.read().decode(charset, errors="replace")
                    else:
                        log_parsing_failure(url, f"HTTP Status {response.status}", f"Attempt {attempt}")
            except urllib.error.HTTPError as e:
                log_parsing_failure(url, f"HTTPError: {e.code} {e.reason}", f"Attempt {attempt}")
                if e.code in (403, 404, 410):
                    # 4xx 재시도 불필요 오류 시 즉시 중단
                    break
            except urllib.error.URLError as e:
                log_parsing_failure(url, f"URLError: {e.reason}", f"Attempt {attempt}")
            except Exception as e:
                log_parsing_failure(url, f"General Error: {str(e)}", f"Attempt {attempt}")

            # 재시도 전 지수 백오프 지연 (1s, 2s, 4s...)
            if attempt < self.max_retries:
                backoff_time = (2 ** (attempt - 1)) * 1.0
                time.sleep(backoff_time)

        return None
