"""Tavily Web Search API 기반 실시간 검색 챗봇 도구 (백엔드 B)

사용자가 실시간 최신 트렌드, 정보, 혹은 일반 웹 지식 검색을 요구할 때 Tavily API를 쏘아 검색을 처리합니다.
"""

import os
import logging
import httpx
from langchain_core.tools import tool

# 오류 사항을 안전하게 모니터링하기 위해 로깅을 활성화합니다.
logger = logging.getLogger(__name__)

@tool
def web_search(query: str) -> str:
    """Tavily Search API를 활용하여 최신 웹 지식, 실시간 뉴스, 트렌드, 카페 운영 꿀팁 등을 웹에서 실시간으로 검색합니다.
    챗봇이 대답하기 어려운 실시간 이슈나, 웹에서 특정 정보를 검색해달라는 명령을 받으면 이 도구를 즉시 호출합니다.

    Args:
        query: 검색하고자 하는 명확한 문장이나 핵심 단어 리스트.
    """
    # 환경변수로부터 사장님의 Tavily 인증용 API 키를 취득합니다.
    api_key = os.getenv("TAVILY_API_KEY", "").strip()
    if not api_key or api_key == "tvly-YourTavilyApiKeyHere":
        return (
            "⚠️ Tavily API Key가 아직 올바르게 설정되지 않았습니다.\n"
            "프로젝트 루트의 .env 파일에 TAVILY_API_KEY=tvly-... 형태로 실제 발급받은 API 키를 넣어주세요."
        )

    url = "https://api.tavily.com/search"
    headers = {"Content-Type": "application/json"}
    payload = {
        "api_key": api_key,
        "query": query,
        "search_depth": "basic",
        "include_answer": True, # 인공지능이 생성한 요약 답변도 함께 달라고 요청합니다.
        "max_results": 5
    }

    try:
        # [한글 주석: 10초 타임아웃을 지정하여 API 응답 지연 시 전체 챗봇이 정지하는 현상을 방지합니다]
        with httpx.Client(timeout=10.0) as client:
            response = client.post(url, json=payload, headers=headers)
            response.raise_for_status()
            data = response.json()

            answer = data.get("answer")
            results = data.get("results", [])

            output = []
            if answer:
                output.append(f"[Tavily AI 검색 요약]\n{answer}\n")

            output.append("[실시간 검색 출처 및 참고 문서]")
            for idx, r in enumerate(results, 1):
                title = r.get("title", "제목 없음")
                link = r.get("url", "링크 없음")
                content = r.get("content", "")
                output.append(f"{idx}. {title}\n  - 주소: {link}\n  - 설명: {content}")

            return "\n".join(output)

    except httpx.HTTPStatusError as e:
        logger.error(f"Tavily API 상태 오류 (HTTP {e.response.status_code}): {e.response.text}")
        return f"Tavily API 연결 중 에러가 발생했습니다. (HTTP {e.response.status_code})"
    except Exception as e:
        logger.exception("Tavily 실시간 검색 중 시스템 예외가 감지되었습니다")
        return f"실시간 검색 처리 중 에러가 발생했습니다: {str(e)}"

# 도구 자동 연동을 위해 TOOLS 리스트에 담아 레지스트리에 내보냅니다.
TOOLS = [web_search]
