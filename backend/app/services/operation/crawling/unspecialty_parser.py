"""언스페셜티(unspecialty.com) 상품 목록 파서 — 카페24 기반 쇼핑몰

[한글 주석] 이 사이트를 고른 근거:
  robots.txt에서 크롤링을 허용하고 있고(2026-07 확인), 상품 정보가 정적 HTML에
  그대로 들어 있어 브라우저 없이 파싱된다.
  (반면 코케비즈는 Next.js SPA라 HTML에 상품이 없고, 생두모아는 robots.txt가 금지한다)

카페24 상품 목록의 실제 구조:
    <li id="anchorBoxId_775">                            ← 상품번호
      <div class="thumbnail">
        <a href="/product/detail.html?product_no=775">
        <img src="//unspecialty.com/web/product/...">    ← 이미지
      <div class="description" ec-data-price="9000">     ← 가격(숫자 속성)
        <div class="name">... 상품명 ...</div>

  가격은 화면에 '9,000원'으로 찍히지만 ec-data-price 속성에 숫자만 따로 있어
  콤마·통화기호를 파싱할 필요가 없다. 이 속성을 1순위로 쓰고, 없으면 본문에서 찾는다.
"""
import logging
import re
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

BASE_URL = "https://unspecialty.com"
SOURCE_SITE = "언스페셜티"

# 상품 한 건의 블록을 잘라내는 기준 — <li id="anchorBoxId_숫자"> 부터 다음 상품 전까지
_ITEM_RE = re.compile(r'<li[^>]*id="anchorBoxId_(\d+)"[^>]*>(.*?)(?=<li[^>]*id="anchorBoxId_\d+"|</ul>)', re.S)

_PRICE_ATTR_RE = re.compile(r'ec-data-price="(\d+)"')
_PRICE_TEXT_RE = re.compile(r'([\d,]{3,})\s*원')
_NAME_BLOCK_RE = re.compile(r'<div class="name">(.*?)</div>', re.S)
_IMG_RE = re.compile(r'<img[^>]+src="([^"]+)"')
_TAG_RE = re.compile(r"<[^>]+>")


def _clean_text(html: str) -> str:
    """태그와 HTML 엔티티를 제거해 사람이 읽는 문자열로 만든다."""
    text = _TAG_RE.sub(" ", html or "")
    text = (
        text.replace("&quot;", '"').replace("&amp;", "&")
        .replace("&lt;", "<").replace("&gt;", ">")
        .replace("&nbsp;", " ").replace("&#39;", "'")
    )
    return re.sub(r"\s+", " ", text).strip()


def _extract_name(block: str) -> str:
    """상품명을 뽑는다.

    [한글 주석] 카페24는 name 블록 안에 '상품명 :' 이라는 안내 라벨을 숨겨서 넣어둔다.
    (화면에는 displaynone으로 안 보이지만 HTML에는 존재한다)
    그대로 두면 모든 상품명이 '상품명 : ...'으로 시작하므로 걷어낸다.
    """
    m = _NAME_BLOCK_RE.search(block)
    if not m:
        return ""
    name = _clean_text(m.group(1))
    name = re.sub(r"^\s*상품명\s*:\s*", "", name)
    return name.strip()


def _extract_price(block: str) -> Optional[int]:
    """가격을 뽑는다 — ec-data-price 속성 우선, 없으면 '9,000원' 텍스트."""
    m = _PRICE_ATTR_RE.search(block)
    if m:
        try:
            return int(m.group(1))
        except ValueError:
            pass
    m = _PRICE_TEXT_RE.search(_clean_text(block))
    if m:
        try:
            return int(m.group(1).replace(",", ""))
        except ValueError:
            return None
    return None


# [한글 주석] 언스페셜티는 원두와 장비를 함께 판다.
# 원두 DB에 에스프레소 머신·드리퍼가 섞이면 시세 통계가 통째로 망가지므로
# (실제로 730,000원짜리 머신이 목록에 있었다) 이름으로 걸러낸다.
_EQUIPMENT_WORDS = [
    "머신", "그라인더", "드리퍼", "탬퍼", "디스트리뷰터", "포터필터", "케틀", "주전자",
    "저울", "스케일", "서버", "정수기", "텀블러", "머그", "잔", "컵", "필터페이퍼",
    "여과지", "청소", "세척", "브러시", "매트", "노크박스", "샷글라스", "스팀피처",
    "스팀피쳐", "바스켓", "가스켓", "받침", "거치대", "케이스", "가방", "굿즈", "티셔츠",
    "도구", "필터", "액세서리", "악세서리", "디스펜서", "쉐이퍼", "샤워스크린",
    "홈 로스터", "홈로스터", "로스터기", "브루잉", "센서리",
    "드립포트", "드립 포트", "포트", "색도계", "핸드워시", "온도계", "타이머",
]

# 상품명 앞의 [카테고리] 표기 — 언스페셜티는 이 규칙을 일관되게 지킨다.
# 예) '[커피 생두] 브라질...', '[에스프레소 머신] WPM프리머스', '[색도계] LeBrew...'
_CATEGORY_RE = re.compile(r"^\s*\[([^\]]+)\]")

# 판매가 끝난 상품은 시세 데이터로 쓸 수 없다.
_DEAD_CATEGORIES = ["판매 종료", "판매종료", "품절", "일시품절"]

# 원두임을 알려주는 신호 (장비 단어가 이름에 우연히 들어간 경우를 구제)
_BEAN_WORDS = ["생두", "원두", "로스터스", "로스터리", "디카페인", "블렌드", "블랜드", "싱글오리진"]

# [한글 주석] 가격 상한선.
# 언스페셜티 원두는 대체로 1만~5만원대이고, 생두 대용량도 10만원을 크게 넘지 않는다.
# 반면 장비는 수십만~수백만원이다. 이름만으로 못 거르는 것들
# (예: '[홈 로스터] 빈본 BB100+' 198만원)을 이 선에서 잡는다.
_MAX_BEAN_PRICE = 300_000


def is_bean_product(name: str, price: Optional[int] = None) -> bool:
    """상품명(과 가격)으로 '원두/생두'인지 '장비'인지 판정한다.

    장비 단어가 있어도 원두 신호가 함께 있으면 원두로 본다
    (예: '드립백' 같은 상품이 걸러지지 않도록).
    """
    if not name:
        return False

    # [한글 주석] 카테고리 표기가 가장 신뢰할 만한 신호다.
    # 본문에 '생두'가 들어가도 카테고리가 장비면 장비다
    # (실제 사례: '[색도계] LeBrew RoastSee C1 생두 원두 색도계' — 57만원짜리 측정기)
    m = _CATEGORY_RE.match(name)
    category = m.group(1) if m else ""

    if category:
        if any(w in category for w in _DEAD_CATEGORIES):
            return False  # 판매 종료 상품은 시세 데이터가 될 수 없다
        if any(w in category for w in _EQUIPMENT_WORDS):
            return False

    has_bean = any(w in name for w in _BEAN_WORDS)
    has_equipment = any(w in name for w in _EQUIPMENT_WORDS)

    if has_equipment and not has_bean:
        return False

    # 이름으로 못 걸러도 가격이 비상식적이면 원두가 아니다.
    if price is not None and price > _MAX_BEAN_PRICE and not has_bean:
        return False

    return True


def _absolute(url: str) -> str:
    """//도메인/... 또는 /경로 형태를 완전한 주소로 만든다."""
    if not url:
        return ""
    if url.startswith("//"):
        return "https:" + url
    if url.startswith("/"):
        return BASE_URL + url
    return url


# ═══════════════════════════════════════════════════
# [한글 주석] 렌더링된 카드 구조 파서 (all_beans.html 등)
#
# 정적 HTML에는 상품이 없고 JS가 그린다. Playwright로 렌더링하면 아래 카드가 나온다:
#   <div class="_card_xkhrv_5" data-product-id="802">
#     <p class="_roastery_...">코스피어</p>              ← 로스터리
#     <h3 class="_name_...">프루츠프루츠 (언스페셜티 블렌드)</h3>
#     <p class="_cupnotes_...">백합, 과일 바구니, 핵과류</p>  ← 컵노트
#     <span class="_weight_...">200g</span>              ← 용량 (g당 단가 계산 가능)
#     <span class="_originalPrice_...">19,000원</span>
#     <span class="_priceValue_...">17,500원</span>       ← 실제 판매가
#
# 홈페이지(prdList 구조)보다 정보가 훨씬 풍부하다 —
# 컵노트와 용량은 기존 DB에 아예 없던 데이터다.
#
# 주의: 클래스명 뒤 해시(_xkhrv_)는 빌드할 때마다 바뀔 수 있으므로
# 정확한 이름이 아니라 '접두어'로 매칭한다.
# ═══════════════════════════════════════════════════

_CARD_RE = re.compile(r'<div class="_card_[^"]*"\s+data-product-id="(\d+)"(.*?)(?=<div class="_card_[^"]*"\s+data-product-id=|\Z)', re.S)
_ROASTERY_RE = re.compile(r'class="_roastery_[^"]*"[^>]*>(.*?)</p>', re.S)
_NAME_RE = re.compile(r'class="_name_[^"]*"[^>]*>(.*?)</h3>', re.S)
_CUPNOTES_RE = re.compile(r'class="_cupnotes_[^"]*"[^>]*>(.*?)</p>', re.S)
_WEIGHT_RE = re.compile(r'class="_weight_[^"]*"[^>]*>(.*?)</span>', re.S)
_PRICEVAL_RE = re.compile(r'class="[^"]*_priceValue_[^"]*"[^>]*>(.*?)</span>', re.S)
_ORIGPRICE_RE = re.compile(r'class="[^"]*_originalPrice_[^"]*"[^>]*>(.*?)</span>', re.S)


def _won_to_int(text: str) -> Optional[int]:
    """'17,500원' → 17500"""
    if not text:
        return None
    m = re.search(r"([\d,]+)\s*원", _clean_text(text))
    if not m:
        return None
    try:
        return int(m.group(1).replace(",", ""))
    except ValueError:
        return None


def _weight_to_grams(text: str) -> Optional[float]:
    """'200g' → 200.0 / '1kg' → 1000.0"""
    if not text:
        return None
    m = re.search(r"([\d.]+)\s*(kg|g)\b", _clean_text(text), re.I)
    if not m:
        return None
    try:
        v = float(m.group(1))
        return v * 1000 if m.group(2).lower() == "kg" else v
    except ValueError:
        return None


def parse_unspecialty_cards(html: str, beans_only: bool = True) -> List[Dict[str, Any]]:
    """렌더링된 페이지의 상품 카드를 파싱한다 (컵노트·용량 포함).

    반환 항목에 cup_notes, weight_g, price_per_gram, roastery_name이 추가된다.
    """
    if not html:
        return []

    results: List[Dict[str, Any]] = []
    seen: set = set()
    skipped = 0

    for m in _CARD_RE.finditer(html):
        product_no = m.group(1)
        block = m.group(2)
        if product_no in seen:
            continue

        name_m = _NAME_RE.search(block)
        name = _clean_text(name_m.group(1)) if name_m else ""
        if not name:
            continue

        # 할인가(_priceValue_)가 실제 판매가다. _originalPrice_는 할인 전 정가.
        price = _won_to_int(_PRICEVAL_RE.search(block).group(1)) if _PRICEVAL_RE.search(block) else None
        orig_m = _ORIGPRICE_RE.search(block)
        original_price = _won_to_int(orig_m.group(1)) if orig_m else None

        if beans_only and not is_bean_product(name, price):
            seen.add(product_no)
            skipped += 1
            continue

        r_m = _ROASTERY_RE.search(block)
        c_m = _CUPNOTES_RE.search(block)
        w_m = _WEIGHT_RE.search(block)

        grams = _weight_to_grams(w_m.group(1)) if w_m else None
        ppg = round(price / grams, 2) if (price and grams) else None

        img = _IMG_RE.search(block)
        seen.add(product_no)

        results.append({
            "product_no": product_no,
            "name": name,
            "price": price,
            "original_price": original_price,
            "roastery_name": _clean_text(r_m.group(1)) if r_m else "",
            "cup_notes": _clean_text(c_m.group(1)) if c_m else "",
            "weight_g": grams,
            "price_per_gram": ppg,
            "product_url": f"{BASE_URL}/product/detail.html?product_no={product_no}",
            "thumbnail_url": _absolute(img.group(1) if img else ""),
            "source_site": SOURCE_SITE,
        })

    if not results:
        logger.warning("언스페셜티 카드 파싱 결과 0건 — 렌더링이 안 됐거나 구조가 바뀌었습니다")
    elif skipped:
        logger.info("언스페셜티 카드 파싱: 원두 %d건 / 장비 %d건 제외", len(results), skipped)

    return results


def parse_unspecialty_products(html: str, beans_only: bool = True) -> List[Dict[str, Any]]:
    """언스페셜티 상품 목록 HTML에서 상품들을 추출한다.

    반환 항목: product_no, name, price, product_url, thumbnail_url, source_site
    같은 상품이 여러 진열 영역에 중복 노출되므로 product_no로 한 번 걸러낸다.
    beans_only=True면 장비(머신·드리퍼 등)를 제외하고 원두/생두만 남긴다.
    """
    if not html:
        return []

    results: List[Dict[str, Any]] = []
    seen: set = set()
    skipped_equipment = 0

    for m in _ITEM_RE.finditer(html):
        product_no = m.group(1)
        block = m.group(2)

        if product_no in seen:
            continue

        name = _extract_name(block)
        price = _extract_price(block)

        # 이름이 없으면 상품 블록이 아니거나 파싱이 어긋난 것이므로 버린다.
        if not name:
            continue

        # 장비(머신·드리퍼 등)는 원두 DB에 들어가면 안 된다.
        if beans_only and not is_bean_product(name, price):
            seen.add(product_no)
            skipped_equipment += 1
            continue

        img = _IMG_RE.search(block)
        seen.add(product_no)

        results.append({
            "product_no": product_no,
            "name": name,
            "price": price,
            "product_url": f"{BASE_URL}/product/detail.html?product_no={product_no}",
            "thumbnail_url": _absolute(img.group(1) if img else ""),
            "source_site": SOURCE_SITE,
        })

    if not results:
        # 조용히 0건을 반환하면 "상품이 없다"와 "구조가 바뀌었다"를 구분할 수 없다.
        logger.warning("언스페셜티 파싱 결과 0건 — 사이트 구조가 변경되었을 수 있습니다")
    elif skipped_equipment:
        logger.info("언스페셜티 파싱: 원두 %d건 / 장비 %d건 제외", len(results), skipped_equipment)

    return results
