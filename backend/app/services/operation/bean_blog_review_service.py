"""원두 후기 수집 — 네이버 공식 검색 API(블로그·카페) 기반

[한글 주석] 왜 쇼핑 리뷰가 아니라 블로그/카페인가:

  네이버 쇼핑 리뷰는 공식 API가 없다. 상품 페이지를 긁으려면
   ① 이용약관 위반 소지가 있고
   ② 리뷰가 JS로 지연 로딩돼 정적 HTML에는 아예 없다 (그래서 기존 정규식 파서가 항상 0건이었다)
  반면 블로그·카페 검색은 네이버가 공개한 정식 오픈 API다. 같은 키로 호출하며
  약관상 허용된 방법이고, 실제 한국 사용자가 쓴 후기 텍스트를 대량으로 얻을 수 있다.

  대신 쇼핑 리뷰와 성격이 다르다는 점을 분명히 해야 한다:
   - 별점이 없다 → 감성 분석으로 대체하고, rating은 추정치임을 라벨로 남긴다
   - 협찬/광고 글이 많다 → 걸러내지 않으면 "긍정 100%"라는 거짓 신호가 만들어진다
   - 본문이 아니라 요약(description) 스니펫만 받는다 → 저작권 부담이 적다
"""
import logging
import os
import re
import time
from typing import Any, Dict, List

import requests
from sqlalchemy.orm import Session

from app.models.roastery import BeanReview, RoasteryBean

logger = logging.getLogger(__name__)

_TIMEOUT = 5

# 이 출처로 저장한다 — 쇼핑 리뷰(Naver Shopping)나 샘플(Sample)과 구분되어야 한다.
BLOG_SOURCE_SITE = "Naver Blog"
CAFE_SOURCE_SITE = "Naver Cafe"

# [한글 주석] 협찬·광고 글 필터.
# 이걸 안 걸면 "긍정 비율 98%" 같은 숫자가 나오는데, 그건 원두가 좋아서가 아니라
# 협찬 글만 모였기 때문이다. 가짜 리뷰 문제를 형태만 바꿔 반복하는 셈이 된다.
_AD_PATTERNS = [
    "협찬", "제공받", "원고료", "체험단", "무상으로", "소정의", "대가를 받",
    "광고", "제휴", "서포터즈", "앰버서더", "쿠팡파트너스", "수수료를 제공",
]

# 원두와 무관한 글을 걸러내기 위한 최소 조건
_MIN_CONTENT_LEN = 25


def _strip_tags(text: str) -> str:
    """네이버 검색 결과의 <b> 하이라이트 태그와 HTML 엔티티를 제거한다."""
    if not text:
        return ""
    text = re.sub(r"<[^>]+>", "", text)
    text = (
        text.replace("&quot;", '"').replace("&amp;", "&")
        .replace("&lt;", "<").replace("&gt;", ">")
        .replace("&nbsp;", " ").replace("&#39;", "'")
    )
    return re.sub(r"\s+", " ", text).strip()


def _looks_like_ad(text: str) -> bool:
    """협찬/광고 문구가 포함됐는지 판정한다."""
    return any(p in text for p in _AD_PATTERNS)


def _search_naver(endpoint: str, query: str, display: int = 30, sort: str = "sim") -> List[Dict[str, Any]]:
    """네이버 공식 검색 API 호출 (blog / cafearticle).

    [한글 주석] 429(요청 제한)는 실측상 1회 재시도로 부족해 3회까지 백오프한다.
    전부 실패하면 조용히 넘어가지 않고 경고를 남긴다 — 실패가 묻히면
    "수집했는데 0건"인지 "호출 자체가 실패"인지 구분할 수 없기 때문이다.
    """
    client_id = os.getenv("NAVER_CLIENT_ID")
    client_secret = os.getenv("NAVER_CLIENT_SECRET")
    if not client_id or not client_secret:
        logger.warning("네이버 검색 API 키가 없습니다 (NAVER_CLIENT_ID/SECRET)")
        return []

    headers = {"X-Naver-Client-Id": client_id, "X-Naver-Client-Secret": client_secret}
    backoff = (0.5, 1.5)
    for attempt in (1, 2, 3):
        try:
            r = requests.get(
                f"https://openapi.naver.com/v1/search/{endpoint}.json",
                params={"query": query, "display": min(display, 100), "sort": sort},
                headers=headers,
                timeout=_TIMEOUT,
            )
            if r.status_code in (401, 403):
                # NCP(지도) 키로는 검색 API가 호출되지 않는다 — developers.naver.com 키가 필요하다.
                logger.warning(
                    "네이버 %s 검색 인증 실패(%s) — developers.naver.com의 '검색 API' 키인지 확인하세요",
                    endpoint, r.status_code,
                )
                return []
            if r.status_code == 429 and attempt < 3:
                time.sleep(backoff[attempt - 1])
                continue
            r.raise_for_status()
            return r.json().get("items", [])
        except Exception as e:
            if attempt < 3:
                time.sleep(backoff[attempt - 1])
                continue
            logger.warning("네이버 %s 검색 실패: %s", endpoint, e)
    return []


# [한글 주석] 원두 후기라면 반드시 등장할 법한 맥락 단어.
# 하나도 없으면 원두 이야기가 아닐 가능성이 높다.
_BEAN_CONTEXT = [
    "원두", "로스팅", "배전", "산미", "바디", "드립", "핸드드립", "에스프레소",
    "블렌드", "블랜드", "싱글", "생두", "분쇄", "향미", "테이스팅", "커피콩",
    "추출", "그램", "볶", "고소", "쓴맛", "단맛", "플레이버",
]

# 장비(머신·그라인더) 후기는 원두 후기가 아니다.
# 실제로 'BG블랜드'가 커피머신 모델명 'ECOV311.BG'와 매칭되는 사고가 있었다.
_EQUIPMENT_NOISE = [
    "커피머신", "전자동", "반자동", "캡슐", "그라인더", "머신", "정수기",
    "드롱기", "브레빌", "필립스", "네스프레소", "일리머신", "제품 스펙",
]


def extract_core_tokens(bean_name: str) -> List[str]:
    """상품명에서 원두를 식별하는 핵심 토큰(원산지·농장·블렌드명)만 뽑는다.

    [한글 주석] 관련성 판정의 기준이 된다.
    네이버는 유사 검색을 하므로 'BG블랜드'로 검색해도 'ECOV311.BG'가 딸려온다.
    수집한 글의 본문에 이 토큰이 통째로 들어있는지 확인해 걸러낸다.
    """
    name = bean_name or ""
    name = re.sub(r"\([^)]*\)", " ", name)
    # [한글 주석] '100/200g' 같은 표기를 먼저 통째로 지운다.
    # 순서가 중요하다 — 용량(200g)을 먼저 지우면 '100/'만 남아 숫자 '100'이 토큰으로 살아남고,
    # '100'은 아무 글에나 등장하므로 관련성 검사가 무력화된다(실제로 그런 사고가 있었다).
    name = re.sub(r"\d+\s*/\s*\d+\s*(g|kg|ml)?\b", " ", name, flags=re.I)
    name = re.sub(r"\d+\s*(g|kg|ml|개|팩)\b", " ", name, flags=re.I)
    name = re.sub(r"[^\w가-힣\s]", " ", name)
    _NOISE = {
        "약배전", "중배전", "강배전", "중강배전", "약중배전", "다크", "미디엄", "라이트",
        "홀빈", "분쇄", "원두", "커피", "스페셜티", "싱글오리진", "블렌드", "생두",
        "당일로스팅", "당일", "로스팅", "프리미엄", "선물", "세트", "무료배송",
    }
    # 순수 숫자 토큰은 식별력이 없으므로 제외한다.
    return [
        t for t in name.split()
        if len(t) > 1 and t not in _NOISE and not t.isdigit()
    ]


# [한글 주석] 같은 원두를 다르게 표기하는 경우를 흡수한다.
# 상품명은 '에디오피아'인데 실제 후기 글은 대부분 '에티오피아'로 쓴다
# (실측: 30건 중 에디오피아 1건 / 에티오피아 30건).
# 이걸 맞춰주지 않으면 정작 관련 있는 글이 전부 걸러진다.
_SPELLING_VARIANTS: Dict[str, List[str]] = {
    "에디오피아": ["에티오피아"],
    "에티오피아": ["에디오피아"],
    "콜롬비아": ["콜럼비아"],
    "콜럼비아": ["콜롬비아"],
    "과테말라": ["구아테말라"],
    "블랜드": ["블렌드"],
    "블렌드": ["블랜드"],
    "내츄럴": ["내추럴"],
    "내추럴": ["내츄럴"],
}


def _token_in(token: str, content: str) -> bool:
    """토큰이 본문에 있는지 — 흔한 표기 차이까지 함께 확인한다."""
    if token in content:
        return True
    return any(v in content for v in _SPELLING_VARIANTS.get(token, []))


# [한글 주석] 커피 글이라면 흔히 등장하는 일반 단어들.
# '에티오피아'만 맞아도 통과시키면 그 원두와 무관한 커피 블로그 글이 딸려온다
# (실측: '드립백 16종 후기', '카페 향미사 후기' 같은 글이 특정 원두에 붙었다).
# 진짜 그 원두를 다룬 글이라면 농장·지역명 같은 고유 단어가 나온다.
_GENERIC_TOKENS = {
    "에티오피아", "에디오피아", "콜롬비아", "콜럼비아", "브라질", "과테말라", "케냐",
    "코스타리카", "페루", "파나마", "인도네시아", "온두라스", "볼리비아", "르완다",
    "예멘", "자메이카", "탄자니아", "엘살바도르", "니카라과", "멕시코", "베트남",
    "디카페인", "워시드", "내추럴", "내츄럴", "허니", "블렌드", "블랜드", "무산소",
}


def _specific_tokens(core_tokens: List[str]) -> List[str]:
    """원두를 특정할 수 있는 고유 토큰만 남긴다 (농장·지역·로트명)."""
    return [t for t in core_tokens if t not in _GENERIC_TOKENS]


def is_relevant(content: str, core_tokens: List[str]) -> bool:
    """수집한 글이 이 원두에 대한 후기가 맞는지 판정한다.

    세 관문을 모두 통과해야 한다:
      1. 장비(머신·그라인더) 후기가 아닐 것
      2. 원두 맥락 단어가 하나 이상 있을 것
      3. 원두를 식별하는 토큰이 본문에 실제로 등장할 것  ← 오매칭을 잡는 핵심
    """
    if not content:
        return False

    # 1) 장비 후기 배제
    if any(w in content for w in _EQUIPMENT_NOISE):
        return False

    # 2) 원두 맥락 확인
    if not any(w in content for w in _BEAN_CONTEXT):
        return False

    # 3) 식별 토큰이 본문에 실제로 있는지 (부분 문자열이 아니라 토큰 전체)
    if not core_tokens:
        return True

    # [한글 주석] 고유 토큰(농장·지역명)이 있으면 그것으로만 판정한다.
    # '에티오피아' 같은 흔한 단어는 아무 커피 글에나 나와서, 그걸 허용하면
    # 다른 원두를 다룬 글이 이 원두의 후기로 둔갑한다 — 평점·키워드가 오염된다.
    specific = _specific_tokens(core_tokens)
    if specific:
        return any(_token_in(t, content) for t in specific)

    # 고유 토큰이 없는 원두(예: '콜롬비아 디카페인')는 일반 토큰으로 판정할 수밖에 없다.
    return any(_token_in(t, content) for t in core_tokens)


def build_query(bean_name: str, roastery_name: str = "") -> str:
    """상품명을 검색어로 다듬는다.

    [한글 주석] 원두 상품명은 '약배전(딱복이) 에디오피아 구지 우라가 시코 N 100/200g 타셋커피로스터스'
    처럼 길고 잡음이 많다. 그대로 검색하면 결과가 0건이 나오므로
    용량·괄호·로스팅표기 등을 걷어내고 핵심 단어만 남긴다.
    """
    name = bean_name or ""
    name = re.sub(r"\([^)]*\)", " ", name)          # 괄호 내용 제거
    name = re.sub(r"\d+\s*(g|kg|ml|개|팩)\b", " ", name, flags=re.I)  # 용량 제거
    name = re.sub(r"\d+\s*/\s*\d+", " ", name)       # 100/200 같은 표기 제거
    name = re.sub(r"[^\w가-힣\s]", " ", name)         # 특수문자 제거

    # [한글 주석] 로스팅 정도·마케팅 수식어는 검색을 좁히기만 한다.
    # 후기를 찾는 열쇠는 '원산지 + 농장/지역명'이므로 그 외 단어는 뺀다.
    # (같은 원두의 200g/400g 상품이 동일한 검색어가 되는 효과도 있어 API 호출이 준다)
    _NOISE = {
        "약배전", "중배전", "강배전", "중강배전", "약중배전", "다크", "미디엄", "라이트",
        "홀빈", "분쇄", "원두", "커피", "스페셜티", "싱글오리진", "블렌드", "생두",
        "당일로스팅", "당일", "로스팅", "프리미엄", "선물", "세트", "무료배송",
    }
    tokens = [t for t in name.split() if len(t) > 1 and t not in _NOISE]

    # 너무 길면 검색 결과가 0건이 되므로 앞쪽 핵심 토큰만 사용
    core = " ".join(tokens[:4])
    if not core:
        core = (bean_name or "").strip()[:20]

    # [한글 주석] 'BG블랜드'처럼 짧고 일반적인 이름은 그것만으로 원두가 특정되지 않는다.
    # (실제로 커피머신 모델명 'ECOV311.BG'와 매칭되는 사고가 있었다)
    # 이럴 때 로스터리 이름을 붙이면 검색이 훨씬 정확해진다.
    tokens_are_weak = len(tokens) <= 1 or len(core) < 8
    if tokens_are_weak and roastery_name:
        rn = re.sub(r"[^\w가-힣\s]", " ", roastery_name).strip()
        if rn:
            core = f"{rn} {core}".strip()

    return f"{core} 원두 후기".strip()


def collect_blog_reviews_for_bean(
    db: Session,
    bean_id: int,
    display: int = 30,
    include_cafe: bool = True,
    exclude_ads: bool = True,
) -> Dict[str, Any]:
    """원두 1건에 대한 블로그·카페 후기를 수집해 BeanReview로 저장한다.

    중복은 source_url(글 링크)로 판별한다.
    """
    from app.services.operation.bean_review_service import analyze_review_sentiment_and_keywords

    bean = db.query(RoasteryBean).filter(RoasteryBean.id == bean_id).first()
    if not bean:
        return {"bean_id": bean_id, "collected": 0, "message": "존재하지 않는 원두입니다."}

    roastery_name = bean.roastery.name if bean.roastery else ""
    query = build_query(bean.name, roastery_name)
    core_tokens = extract_core_tokens(bean.name)

    sources = [(BLOG_SOURCE_SITE, "blog")]
    if include_cafe:
        sources.append((CAFE_SOURCE_SITE, "cafearticle"))

    collected = 0
    skipped_ads = 0
    skipped_irrelevant = 0
    seen_urls = {
        r.source_url
        for r in db.query(BeanReview.source_url).filter(BeanReview.bean_id == bean_id).all()
        if r.source_url
    }

    for source_site, endpoint in sources:
        items = _search_naver(endpoint, query, display=display)
        for it in items:
            link = (it.get("link") or "").strip()
            title = _strip_tags(it.get("title", ""))
            desc = _strip_tags(it.get("description", ""))
            content = f"{title}. {desc}".strip(". ").strip()

            if not link or link in seen_urls:
                continue
            if len(content) < _MIN_CONTENT_LEN:
                continue
            if exclude_ads and _looks_like_ad(content):
                skipped_ads += 1
                continue
            # [한글 주석] 네이버 유사 검색 때문에 엉뚱한 글이 딸려온다.
            # (실제로 'BG블랜드'가 커피머신 모델명 'ECOV311.BG'와 매칭됐다)
            if not is_relevant(content, core_tokens):
                skipped_irrelevant += 1
                continue

            analysis = analyze_review_sentiment_and_keywords(content)
            sentiment = analysis.get("sentiment", "neutral")
            # 블로그 글에는 별점이 없다 — 감성에서 추정한 값이며 실제 평점이 아니다.
            rating = 4.5 if sentiment == "positive" else (3.0 if sentiment == "neutral" else 2.0)

            db.add(
                BeanReview(
                    bean_id=bean_id,
                    source_site=source_site,
                    source_url=link,
                    rating=rating,
                    content=content[:1000],
                    sentiment=sentiment,
                    keywords=analysis.get("keywords", []),
                    helpful_count=0,
                )
            )
            seen_urls.add(link)
            collected += 1

    db.commit()

    # [한글 주석] 저장만 하고 끝내면 roastery_beans의 review_count/avg_rating이 0인 채로 남아
    # 화면에는 "리뷰 0개"로 보인다. 실제로 30건을 모으고도 집계가 0이던 버그가 있었다.
    # 수집 직후 집계를 갱신해 저장과 표시가 어긋나지 않게 한다.
    summary = None
    if collected:
        try:
            from app.services.operation.bean_review_service import update_bean_review_summary
            s = update_bean_review_summary(db, bean_id)
            summary = {
                "review_count": s.review_count,
                "avg_rating": s.avg_rating,
                "positive_ratio": s.positive_ratio,
                "top_keywords": s.top_keywords,
            }
        except Exception as e:
            # 집계 실패가 수집 자체를 무효로 만들지는 않는다 — 다만 조용히 넘기지 않는다.
            logger.warning("리뷰 집계 갱신 실패 (bean_id=%s): %s", bean_id, e)

    return {
        "bean_id": bean_id,
        "query": query,
        "core_tokens": core_tokens,
        "collected": collected,
        "skipped_ads": skipped_ads,
        "skipped_irrelevant": skipped_irrelevant,
        "summary": summary,
        "message": (
            f"후기 {collected}건 수집 "
            f"(광고 {skipped_ads}건, 무관한 글 {skipped_irrelevant}건 제외)"
        ),
    }


def collect_blog_reviews_bulk(
    db: Session,
    limit: int = 50,
    display: int = 20,
    only_missing: bool = True,
    rate_limit_sec: float = 0.3,
) -> Dict[str, Any]:
    """여러 원두에 대해 순차 수집한다 (네이버 초당 요청 제한을 지키며).

    only_missing=True면 아직 리뷰가 없는 원두부터 채운다.
    """
    q = db.query(RoasteryBean)
    if only_missing:
        q = q.filter((RoasteryBean.review_count == 0) | (RoasteryBean.review_count.is_(None)))
    beans = q.order_by(RoasteryBean.id.asc()).limit(limit).all()

    total, done, ads, reused = 0, 0, 0, 0
    # [한글 주석] 같은 원두의 200g/400g/800g 상품은 검색어가 동일해진다.
    # 같은 질의를 반복하면 네이버 호출만 낭비되므로, 이미 부른 질의는 건너뛴다.
    seen_queries: set = set()

    for b in beans:
        query = build_query(b.name, b.roastery.name if b.roastery else "")
        if query in seen_queries:
            reused += 1
            continue
        seen_queries.add(query)

        res = collect_blog_reviews_for_bean(db, b.id, display=display)
        total += res.get("collected", 0)
        ads += res.get("skipped_ads", 0)
        done += 1
        time.sleep(rate_limit_sec)  # 초당 요청 제한 준수

    return {
        "beans_processed": done,
        "reviews_collected": total,
        "ads_skipped": ads,
        "duplicate_queries_skipped": reused,
        "message": (
            f"원두 {done}건에서 후기 {total}건 수집 "
            f"(광고 {ads}건 제외, 중복 검색어 {reused}건 건너뜀)"
        ),
    }
