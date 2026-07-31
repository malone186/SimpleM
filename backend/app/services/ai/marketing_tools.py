"""홍보/마케팅 챗봇 도구 (백엔드 B)

홍보 문구·홍보 이미지 생성 — 로직은 marketing_service.py, 여기는 @tool 래퍼만.
생성된 홍보 콘텐츠 문서는 main_agent가 수집해 챗봇 화면에 카드로 자동 표시된다.
"""

import json

from langchain_core.tools import tool

from app.services.ai import marketing_service


def _dump(data) -> str:
    return json.dumps(data, ensure_ascii=False, default=str)


@tool
def create_promotion_content(store_id: str, topic: str = "", channel: str = "instagram",
                             tone: str = "", menu: str = "") -> str:
    """카페 홍보 문구 세트를 생성한다 — 눈길 끄는 헤드라인, 인스타그램 캡션, 해시태그,
    이미지에 새길 슬로건, 홍보 이미지용 프롬프트까지 한 번에.
    "홍보 문구 만들어줘", "인스타에 올릴 글 써줘", "신메뉴 홍보하고 싶어" 같은 요청에 쓴다.
    매장의 실제 정보(상호·위치·베스트 메뉴)를 근거로 쓰므로 지어낸 내용이 들어가지 않는다.
    topic: 홍보 주제 (예: "신메뉴 딸기라떼 출시", "여름 시즌"). 비우면 매장 일반 홍보.
    channel: instagram(기본) / blog(블로그·매장 소식) / banner(현수막·포스터) / sms(안내 문자).
    tone: 원하는 말투 (예: "감성적으로", "유쾌하게"). menu: 특별히 강조할 메뉴 이름."""
    try:
        return _dump(marketing_service.generate_promotion_copy(
            store_id, topic=topic, channel=channel, tone=tone, menu=menu))
    except marketing_service.MarketingError as e:
        return str(e)


@tool
def create_promotion_image(store_id: str, doc_id: str = "", request: str = "",
                           style: str = "", aspect_ratio: str = "") -> str:
    """AI로 카페 홍보 이미지를 생성한다. 생성에 수십 초가 걸릴 수 있다.
    doc_id: create_promotion_content로 만든 홍보 콘텐츠 문서 id — 넣으면 그 문구에
    어울리는 이미지가 만들어지고 문서에 함께 기록된다 (권장 흐름: 문구 먼저, 이미지 다음).
    request: 문서 없이 바로 만들거나 원하는 장면을 직접 지정할 때의 이미지 설명 (한국어 가능).
    style: 스타일 지시 (예: "수채화 일러스트", "필름 카메라 감성"). 비우면 실사 사진풍.
    aspect_ratio: 1:1(기본, 피드) / 9:16(스토리) / 4:5(세로 피드) / 16:9(가로 배너).
    결과의 url은 사장님이 바로 볼 수 있는 이미지 주소다 — 답변에 꼭 포함할 것."""
    try:
        result = marketing_service.generate_promotion_image(
            store_id, doc_id=doc_id, request=request, style=style,
            aspect_ratio=aspect_ratio or "1:1")
    except marketing_service.MarketingError as e:
        return str(e)
    doc = result.pop("doc", None)
    if doc:
        # 문서 전문을 돌려주면 갱신된 카드(이미지 포함)가 채팅 화면에 자동 표시된다
        return _dump(doc)
    return _dump(result)


@tool
def list_promotion_contents(store_id: str) -> str:
    """만들어 둔 홍보 콘텐츠 목록을 조회한다 — 각 문서의 id·제목·채널·이미지 개수.
    "지난번 홍보 문구 보여줘", "만든 홍보물 뭐 있어?" 같은 요청에 쓴다."""
    from app.services.ai import document_service

    docs = document_service.list_documents(store_id, kind=marketing_service.DOC_KIND)
    if not docs:
        return "만들어 둔 홍보 콘텐츠가 없습니다. create_promotion_content로 만들 수 있습니다."
    brief = [{"id": d["id"], "title": d["title"],
              "channel": d["content"].get("channel_label") or d["content"].get("channel"),
              "headline": d["content"].get("headline"),
              "image_count": len(d["content"].get("images") or []),
              "created_at": d["created_at"]}
             for d in docs]
    return _dump(brief)


@tool
def get_promotion_content(store_id: str, doc_id: str) -> str:
    """홍보 콘텐츠 문서 하나의 전문(문구 전체·해시태그·생성 이미지 목록)을 조회한다.
    doc_id는 list_promotion_contents로 확인한다."""
    from app.services.ai import document_service

    try:
        return _dump(document_service.get_document(store_id, doc_id))
    except document_service.DocumentError as e:
        return str(e)


TOOLS = [create_promotion_content, create_promotion_image,
         get_promotion_content, list_promotion_contents]
