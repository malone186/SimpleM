# c:\Users\USER\Documents\본 프로젝트\SimpleM\backend\app\services\operation\review_preprocessing_service.py
"""
[한글 주석] 리뷰 텍스트 전처리 및 품질 검증 서비스 모듈
- 이모지, HTML, 광고 문구, 이중 공백 제거
- 전화번호, 이메일 등 개인정보 마스킹
- source_url + 본문 해시 기반 멱등 중복 검사
- 15자 미만 숏 리뷰 판별 (속성 추출 스킵, 감성만 판별 대상)
"""

import re
import hashlib
import logging
from typing import Dict, Any, Tuple, Optional

logger = logging.getLogger(__name__)

# [한글 주석] 이모지 및 특수 이모티콘 제거용 정규표현식
EMOJI_PATTERN = re.compile(
    "["
    "\U0001F600-\U0001F64F"  # emoticons
    "\U0001F300-\U0001F5FF"  # symbols & pictographs
    "\U0001F680-\U0001F6FF"  # transport & map symbols
    "\U0001F1E0-\U0001F1FF"  # flags (iOS)
    "\U00002702-\U000027B0"
    "\U000024C2-\U0001F251"
    "]+",
    flags=re.UNICODE
)

# [한글 주석] 개인정보 마스킹용 정규표현식 (전화번호, 이메일)
PHONE_PATTERN = re.compile(r"01[016789]-?\d{3,4}-?\d{4}")
EMAIL_PATTERN = re.compile(r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}")

# [한글 주석] 광고성 템플릿 제거 키워드
AD_KEYWORDS = ["무료협찬", "원고료지원", "내돈내산은아님", "협찬받음", "체험단후기"]


def clean_review_text(raw_text: str) -> str:
    """
    [한글 주석]
    리뷰 본문에서 HTML 태그, 이모지, 광고 문구, 연속된 공백을 정제하고 개인정보를 마스킹합니다.
    """
    if not raw_text:
        return ""

    text = raw_text

    # 1. HTML 태그 제거
    text = re.sub(r"<[^>]+>", " ", text)

    # 2. 이모지 제거
    text = EMOJI_PATTERN.sub("", text)

    # 3. 개인정보 마스킹
    text = PHONE_PATTERN.sub("[전화번호마스킹]", text)
    text = EMAIL_PATTERN.sub("[이메일마스킹]", text)

    # 4. 광고 키워드 관련 문장 정제
    for kw in AD_KEYWORDS:
        if kw in text:
            text = text.replace(kw, "")

    # 5. 연속 공백 및 줄바꿈 정규화
    text = re.sub(r"\s+", " ", text).strip()

    return text


def compute_review_hash(source_url: Optional[str], content: str) -> str:
    """
    [한글 주석]
    source_url과 정제된 본문을 조합하여 unique 해시값을 생성합니다 (중복 검사용).
    """
    url_part = source_url or "no_url"
    raw_key = f"{url_part}:{content.strip()}"
    return hashlib.sha256(raw_key.encode("utf-8")).hexdigest()


def is_short_review(text: str, min_length: int = 15) -> bool:
    """
    [한글 주석]
    글자 수가 지정된 길이에 미달하여 척도/범주 속성 추출을 스킵해야 하는 숏 리뷰 여부를 판별합니다.
    """
    cleaned = re.sub(r"[^\w가-힣a-zA-Z0-9]", "", text)
    return len(cleaned) < min_length


def preprocess_review_item(item: Dict[str, Any]) -> Dict[str, Any]:
    """
    [한글 주석]
    개별 리뷰 객체를 전달받아 정제된 텍스트, 해시, 숏 리뷰 여부를 결합하여 반환합니다.
    """
    raw_content = item.get("content", "")
    cleaned_content = clean_review_text(raw_content)
    is_short = is_short_review(cleaned_content, min_length=15)
    review_hash = compute_review_hash(item.get("source_url"), cleaned_content)

    return {
        "raw_content": raw_content,
        "cleaned_content": cleaned_content,
        "is_short": is_short,
        "review_hash": review_hash,
    }
