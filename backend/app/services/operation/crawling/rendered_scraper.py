"""브라우저 렌더링 스크래퍼 — JS로 상품을 그리는 사이트용 (Playwright)

[한글 주석] 왜 필요한가:
  언스페셜티의 상품 목록(all_beans.html)과 코케비즈는 정적 HTML에 상품이 없다.
  서버는 껍데기만 내려주고 JavaScript가 나중에 상품을 그린다.
  그래서 urllib/requests로 받으면 상품 0건이 나온다(실측 확인).

  Playwright는 실제 크로미움을 띄워 JS 실행까지 마친 HTML을 준다.
  언스페셜티 기준 정적 0건 → 렌더링 151건으로 늘었다.

비용을 분명히 알고 쓸 것:
  · 크로미움 브라우저(~150MB)가 설치돼 있어야 한다 (playwright install chromium)
  · 페이지당 3~10초로 정적 크롤링보다 5~10배 느리다
  → 사용자가 버튼 누르고 기다리는 용도가 아니라, 하루 1회 배치로 돌릴 것

Playwright가 없으면 ImportError 대신 None을 반환한다 —
설치 안 된 환경에서 서버가 뜨지 못하는 일을 막기 위함이다.
"""
import logging
from typing import List, Optional

logger = logging.getLogger(__name__)

# 정체를 숨기지 않는다.
USER_AGENT = "SimpleM-BrewNote/1.0 (bean price research; contact: admin@simplem.com)"

# 분석·채팅 스크립트가 계속 통신해서 networkidle은 영영 오지 않는다.
# domcontentloaded로 받고, 상품 선택자를 따로 기다린다.
_WAIT_UNTIL = "domcontentloaded"


def is_available() -> bool:
    """이 환경에서 렌더링 수집이 가능한지."""
    try:
        import playwright  # noqa: F401
        return True
    except ImportError:
        return False


def fetch_rendered(
    url: str,
    wait_selector: Optional[str] = "a[href*='product_no=']",
    scroll_rounds: int = 10,
    timeout_ms: int = 45000,
) -> Optional[str]:
    """JS 실행이 끝난 HTML을 돌려준다. 실패하면 None.

    scroll_rounds: 무한 스크롤 대비. 더 이상 늘지 않으면 일찍 멈춘다.
    """
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        logger.warning("Playwright가 설치되어 있지 않습니다 — 렌더링 수집을 건너뜁니다")
        return None

    import re

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            try:
                page = browser.new_page(user_agent=USER_AGENT)
                page.goto(url, timeout=timeout_ms, wait_until=_WAIT_UNTIL)

                if wait_selector:
                    try:
                        page.wait_for_selector(wait_selector, timeout=10000)
                    except Exception:
                        # 선택자가 없어도 계속 진행한다 — 페이지 구조가 다를 수 있다.
                        logger.info("대기 선택자 미발견(%s) — 그대로 진행: %s", wait_selector, url)

                # 스크롤해야 더 로드되는 목록을 위해, 개수가 안 늘 때까지 내린다.
                prev = -1
                for i in range(max(1, scroll_rounds)):
                    page.mouse.wheel(0, 25000)
                    page.wait_for_timeout(1200)
                    cnt = len(re.findall(r'data-product-id="\d+"', page.content()))
                    if cnt == prev and i >= 1:
                        break
                    prev = cnt

                html = page.content()
                logger.info("렌더링 수집 완료: %s (%d자)", url, len(html))
                return html
            finally:
                browser.close()
    except Exception as e:
        logger.warning("렌더링 수집 실패 %s: %s", url, e)
        return None


def fetch_rendered_many(urls: List[str], **kwargs) -> List[str]:
    """여러 URL을 순차 렌더링한다 (브라우저는 매번 새로 띄운다)."""
    out: List[str] = []
    for u in urls:
        html = fetch_rendered(u, **kwargs)
        if html:
            out.append(html)
    return out
