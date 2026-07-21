"""Tavily Web Search API 기반 실시간 검색 챗봇 도구 (백엔드 B)

사용자가 실시간 최신 트렌드, 정보, 혹은 일반 웹 지식 검색을 요구할 때 Tavily API를 쏘아 검색을 처리합니다.

정확도를 위한 설계:
- search_depth=advanced: 페이지 본문에서 질의와 관련된 청크만 뽑아 와 basic보다 관련도가 높다
- 모델이 time_range(최신성)·topic(뉴스/일반)·country(지역 우선)를 질문 성격에 맞게 조절한다
- 결과가 부족하면 검색 전문가가 질의를 바꿔 재검색하는 것을 전제로, 실패를 명확한 문자열로 돌려준다
"""

import os
import logging
import httpx
from langchain_core.tools import tool

# 오류 사항을 안전하게 모니터링하기 위해 로깅을 활성화합니다.
logger = logging.getLogger(__name__)

_VALID_TIME_RANGES = {"day", "week", "month", "year"}
_VALID_TOPICS = {"general", "news"}


@tool
def web_search(
    query: str,
    time_range: str = "",
    topic: str = "general",
    country: str = "south korea",
) -> str:
    """Tavily Search API로 웹에서 실시간 정보를 검색합니다 — 최신 뉴스, 시세, 트렌드, 일반 지식,
    카페 운영 정보 등 시스템 내부 데이터에 없는 모든 외부 정보가 대상입니다.

    Args:
        query: 검색 질의. 사용자 문장을 그대로 넣지 말고, 찾으려는 정보의 핵심 키워드로
            재구성해서 넣으세요 (예: "요즘 카페에서 유행하는 거 알려줘" → "2026 카페 음료 디저트 트렌드").
        time_range: 최신 정보가 중요할 때만 지정 — "day" | "week" | "month" | "year".
            뉴스·가격·시세·트렌드 질문이면 "week"나 "month"를 권장. 시대 불문 지식이면 빈 값.
        topic: "general"(기본) 또는 "news"(언론 보도 위주 — 사건·발표·속보 질문일 때).
        country: 결과에서 우선할 국가 (기본 "south korea"). 해외 정보를 찾을 때는 빈 값 ""로
            비우고, query도 영어로 쓰면 더 정확합니다. topic이 "news"면 무시됩니다.
    """
    # 환경변수로부터 사장님의 Tavily 인증용 API 키를 취득합니다.
    api_key = os.getenv("TAVILY_API_KEY", "").strip()
    if not api_key or api_key == "tvly-YourTavilyApiKeyHere":
        return (
            "⚠️ Tavily API Key가 아직 올바르게 설정되지 않았습니다.\n"
            "프로젝트 루트의 .env 파일에 TAVILY_API_KEY=tvly-... 형태로 실제 발급받은 API 키를 넣어주세요."
        )

    url = "https://api.tavily.com/search"
    headers = {"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"}
    payload: dict = {
        "query": query,
        "search_depth": "advanced",  # 본문에서 질의 관련 청크만 추출 — basic보다 관련도 높음
        "chunks_per_source": 3,
        "include_answer": True,  # 인공지능이 생성한 요약 답변도 함께 달라고 요청합니다.
        "max_results": 5,
    }
    if topic in _VALID_TOPICS:
        payload["topic"] = topic
    if time_range in _VALID_TIME_RANGES:
        payload["time_range"] = time_range
    # country는 general 검색에서만 유효 — 한국 사장님 기준 국내 결과를 우선한다
    if country.strip() and payload.get("topic", "general") == "general":
        payload["country"] = country.strip().lower()

    try:
        # [한글 주석: advanced 검색은 basic보다 느려 타임아웃을 15초로 지정 — 지연 시 전체 챗봇 정지 방지]
        with httpx.Client(timeout=15.0) as client:
            response = client.post(url, json=payload, headers=headers)
            response.raise_for_status()
            data = response.json()

            answer = data.get("answer")
            results = data.get("results", [])

            if not results and not answer:
                return (
                    f"'{query}' 검색 결과가 없습니다. 질의를 더 일반적인 키워드로 바꾸거나, "
                    "해외 정보라면 country를 비우고 영어로 다시 검색해 보세요."
                )

            output = []
            if answer:
                output.append(f"[Tavily AI 검색 요약]\n{answer}\n")

            output.append("[실시간 검색 출처 및 참고 문서]")
            for idx, r in enumerate(results, 1):
                title = r.get("title", "제목 없음")
                link = r.get("url", "링크 없음")
                content = (r.get("content") or "").strip()
                published = r.get("published_date")
                date_note = f" ({published})" if published else ""
                output.append(f"{idx}. {title}{date_note}\n  - 주소: {link}\n  - 내용: {content}")

            return "\n".join(output)

    except httpx.HTTPStatusError as e:
        logger.error(f"Tavily API 상태 오류 (HTTP {e.response.status_code}): {e.response.text}")
        return f"Tavily API 연결 중 에러가 발생했습니다. (HTTP {e.response.status_code})"
    except Exception as e:
        logger.exception("Tavily 실시간 검색 중 시스템 예외가 감지되었습니다")
        return f"실시간 검색 처리 중 에러가 발생했습니다: {str(e)}"

# 도구 자동 연동을 위해 TOOLS 리스트에 담아 레지스트리에 내보냅니다.
TOOLS = [web_search]
