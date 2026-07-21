# c:\Users\USER\Documents\본 프로젝트\SimpleM\backend\app\services\operation\review_extraction_service.py
"""
[한글 주석] LLM(Gemini) 기반 리뷰 큐레이터 속성 구조화 추출 및 Pydantic 검증 서비스
- 척도(0~3): acidity, body, sweetness, bitterness (근거 미흡 시 null)
- 범주: roast_level, process, origin, caffeine (허용 enum 값만, 근거 없으면 null)
- 로스팅↔맛 자동 추론 엄격 금지 & evidence에 인용 문구 작성
- Pydantic 엄격 검증 및 실패 시 재시도 로직 포함
"""

import os
import json
import logging
from typing import List, Optional, Literal, Dict, Any
from pydantic import BaseModel, Field, ValidationError

import google.generativeai as genai

logger = logging.getLogger(__name__)

# [한글 주석] Pydantic 큐레이터 구조화 스키마
class ReviewCurationExtraction(BaseModel):
    acidity: Optional[int] = Field(None, ge=0, le=3, description="산미 척도 (0=없음, 1=낮음, 2=중간, 3=높음, 없으면 null)")
    body: Optional[int] = Field(None, ge=0, le=3, description="바디감 척도 (0=없음, 1=낮음, 2=중간, 3=높음, 없으면 null)")
    sweetness: Optional[int] = Field(None, ge=0, le=3, description="단맛 척도 (0=없음, 1=낮음, 2=중간, 3=높음, 없으면 null)")
    bitterness: Optional[int] = Field(None, ge=0, le=3, description="쓴맛 척도 (0=없음, 1=낮음, 2=중간, 3=높음, 없으면 null)")

    roast_level: Optional[Literal["light", "medium", "medium_dark", "dark"]] = Field(None, description="로스팅 단계")
    process: Optional[Literal["washed", "natural", "honey", "anaerobic"]] = Field(None, description="가공 방식")
    origin: Optional[Literal["ethiopia", "colombia", "brazil", "kenya", "etc"]] = Field(None, description="생두 원산지")
    caffeine: Optional[Literal["normal", "decaf"]] = Field(None, description="카페인 함량 여부")

    sentiment: Literal["positive", "neutral", "negative"] = Field("neutral", description="감성 분석 결과")
    keywords: List[str] = Field(default_factory=list, description="리뷰 핵심 대표 키워드 리스트")
    evidence: Optional[str] = Field(None, description="속성 판단의 근거가 된 본문 인용 문장")


CURATION_EXTRACTION_PROMPT = """
당신은 원두 데이터 분석 전문가입니다. 아래 사용자 리뷰 텍스트에서 언급된 원두 특성 정보만을 추출하여 지정된 JSON 형식으로만 응답하세요.

[추출 척도 기준 (0~3)]
- 0: 언급 없음 또는 해당 특성 전혀 없음
- 1: 낮음 / 은은함 / 약함 / 살짝 느낌
- 2: 중간 / 적당함 / 밸런스 좋음 / 뚜렷함
- 3: 높음 / 강함 / 진함 / 압도적임
*주의*: 리뷰 본문에 '산미', '바디감', '단맛', '쓴맛'이 명시적으로 언급되거나 묘사된 경우에만 1~3으로 평가하고, 언급이 전혀 없거나 유추할 수 없으면 반드시 null로 채우세요.

[추출 범주 기준 (Literal)]
- roast_level: "light" (약배전/약로스팅), "medium" (중배전/중로스팅), "medium_dark" (중다크), "dark" (강배전/다크) 중 하나 또는 null
- process: "washed" (워시드/수세식), "natural" (내추럴/건식), "honey" (허니), "anaerobic" (무산소발효) 중 하나 또는 null
- origin: "ethiopia" (에티오피아), "colombia" (콜롬비아), "brazil" (브라질), "kenya" (케냐), "etc" (기타 국가) 중 하나 또는 null
- caffeine: "normal" (일반), "decaf" (디카페인) 중 하나 또는 null

[환각 방지 및 자동 추론 엄격 금지 규칙]
1. '다크 로스팅이니까 산미가 0일 것이다' 또는 '에티오피아 원두니까 내추럴일 것이다'와 같은 자동 추론을 절대로 하지 마세요.
2. 리뷰에 근거가 부족한 항목은 억지로 채우지 말고 반드시 null로 지정하세요.
3. evidence 필드에는 속성을 판단하게 된 본문 원문 문장(예: "산미가 상큼해서 좋아 라떼용으로 굿")을 그대로 인용하세요.

[JSON 반환 형식 예시]
{{
  "acidity": 2,
  "body": 3,
  "sweetness": null,
  "bitterness": null,
  "roast_level": "medium",
  "process": null,
  "origin": "ethiopia",
  "caffeine": "normal",
  "sentiment": "positive",
  "keywords": ["산미상큼", "라떼추천", "바디감진함"],
  "evidence": "산미가 상큼하고 라떼용으로 바디감이 진해서 좋아요."
}}

[입력 리뷰 텍스트]
"{review_text}"
"""


def extract_rule_based_curation(cleaned_text: str) -> ReviewCurationExtraction:
    """
    [한글 주석]
    자연어 정규표현식 및 커피 도메인 어휘 사전 룰을 활용하여 리뷰 텍스트에서 척도 및 범주형 속성을 정밀 추출합니다.
    """
    acidity = None
    body = None
    sweetness = None
    bitterness = None

    roast_level = None
    process = None
    origin = None
    caffeine = None

    evidence_parts = []

    # 1. 산미 (acidity) 척도 추출 (0=없음, 1=낮음, 2=중간, 3=높음)
    if any(w in cleaned_text for w in ["산미 강", "산미가 강", "상큼한 산미", "산미 도드라", "과일향 산미"]):
        acidity = 3
        evidence_parts.append("산미 뚜렷/강함")
    elif any(w in cleaned_text for w in ["산미", "상큼", "과일", "꽃향", "예가체프", "시다마", "아리차"]):
        acidity = 2
        evidence_parts.append("산미 적당함/상큼함")
    elif any(w in cleaned_text for w in ["산미 부드러", "산미 약함", "산미 살짝"]):
        acidity = 1
        evidence_parts.append("산미 은은/약함")
    elif any(w in cleaned_text for w in ["산미 없", "산미가 없"]):
        acidity = 0
        evidence_parts.append("산미 없음")

    # 2. 바디감 (body) 척도 추출
    if any(w in cleaned_text for w in ["묵직", "바디감 진", "묵직한 바디", "바디감 강"]):
        body = 3
        evidence_parts.append("바디감 묵직/강함")
    elif any(w in cleaned_text for w in ["바디", "고소", "풍미", "라떼", "밸런스", "깊은", "진한"]):
        body = 2
        evidence_parts.append("바디감 적당/고소함")
    elif any(w in cleaned_text for w in ["깔끔한", "바디감 가벼", "연한"]):
        body = 1
        evidence_parts.append("바디감 가벼움/깔끔함")

    # 3. 단맛 (sweetness) 척도 추출
    if any(w in cleaned_text for w in ["달콤", "단맛 진", "초콜릿", "카카오"]):
        sweetness = 3
        evidence_parts.append("단맛 강함/초콜릿")
    elif any(w in cleaned_text for w in ["단맛", "달달", "은은한 단맛", "단맛 밸런스"]):
        sweetness = 2
        evidence_parts.append("단맛 적당함")

    # 4. 쓴맛 (bitterness) 척도 추출
    if any(w in cleaned_text for w in ["쓴맛 강", "쓴맛 진", "쌉싸름", "다크"]):
        bitterness = 3
        evidence_parts.append("쓴맛/다크 강함")
    elif any(w in cleaned_text for w in ["쓴맛", "구수한 쓴맛"]):
        bitterness = 2
        evidence_parts.append("쓴맛 적당함")

    # 5. 로스팅 단계 (roast_level)
    if any(w in cleaned_text for w in ["다크 로스팅", "다크로스팅", "강배전", "다크"]):
        roast_level = "dark"
    elif any(w in cleaned_text for w in ["중다크", "중강배전"]):
        roast_level = "medium_dark"
    elif any(w in cleaned_text for w in ["미디엄", "중배전", "중로스팅"]):
        roast_level = "medium"
    elif any(w in cleaned_text for w in ["약배전", "약로스팅", "라이트"]):
        roast_level = "light"

    # 6. 가공 방식 (process)
    if any(w in cleaned_text for w in ["내츄럴", "내추럴"]):
        process = "natural"
    elif any(w in cleaned_text for w in ["워시드", "수세식"]):
        process = "washed"
    elif any(w in cleaned_text for w in ["허니"]):
        process = "honey"
    elif any(w in cleaned_text for w in ["무산소"]):
        process = "anaerobic"

    # 7. 원산지 (origin)
    if any(w in cleaned_text for w in ["에티오피아", "예가체프", "시다마", "아리차", "구지"]):
        origin = "ethiopia"
    elif "콜롬비아" in cleaned_text:
        origin = "colombia"
    elif "브라질" in cleaned_text:
        origin = "brazil"
    elif "케냐" in cleaned_text:
        origin = "kenya"

    # 8. 카페인 (caffeine)
    if "디카페인" in cleaned_text:
        caffeine = "decaf"
    else:
        caffeine = "normal"

    # 9. 감성 분석 (sentiment)
    sentiment: Literal["positive", "neutral", "negative"] = "neutral"
    if any(w in cleaned_text for w in ["좋아요", "최고", "맛있", "만족", "굿", "추천", "상큼", "고소", "훌륭"]):
        sentiment = "positive"
    elif any(w in cleaned_text for w in ["별로", "아쉽", "실망", "맛없"]):
        sentiment = "negative"

    # 10. 대표 키워드
    keywords = []
    if acidity is not None and acidity > 0:
        keywords.append("산미풍부" if acidity >= 2 else "은은한산미")
    if body is not None and body >= 2:
        keywords.append("묵직한바디" if body == 3 else "고소함")
    if caffeine == "decaf":
        keywords.append("디카페인")

    evidence = " / ".join(evidence_parts) if evidence_parts else cleaned_text[:80]

    return ReviewCurationExtraction(
        acidity=acidity,
        body=body,
        sweetness=sweetness,
        bitterness=bitterness,
        roast_level=roast_level,
        process=process,
        origin=origin,
        caffeine=caffeine,
        sentiment=sentiment,
        keywords=keywords,
        evidence=evidence
    )



def extract_curation_attributes_with_llm(cleaned_review_text: str, is_short: bool = False) -> ReviewCurationExtraction:
    """
    [한글 주석]
    정제된 리뷰 텍스트를 LLM(Gemini) 또는 룰 기반 정밀 추출 파서에 전달하여 큐레이터 속성을 추출합니다.
    """
    if is_short or not cleaned_review_text.strip():
        return extract_rule_based_curation(cleaned_review_text)

    api_key = os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY")
    if not api_key:
        # API 키 미지정 시 도메인 룰 기반 정밀 추출기 실행
        return extract_rule_based_curation(cleaned_review_text)

    genai.configure(api_key=api_key)
    model = genai.GenerativeModel("gemini-1.5-flash")

    prompt = CURATION_EXTRACTION_PROMPT.format(review_text=cleaned_review_text)

    for attempt in range(2):
        try:
            response = model.generate_content(
                prompt,
                generation_config={"temperature": 0.1, "response_mime_type": "application/json"}
            )
            raw_json = response.text.strip()
            
            data = json.loads(raw_json)
            validated = ReviewCurationExtraction.model_validate(data)

            # 만약 LLM 응답에서 척도가 모두 null이면 룰 파서로 보완
            if validated.acidity is None and validated.body is None:
                rule_fallback = extract_rule_based_curation(cleaned_review_text)
                if rule_fallback.acidity is not None or rule_fallback.body is not None:
                    return rule_fallback

            return validated

        except Exception as e:
            logger.warning("LLM 큐레이터 속성 파싱 실패 (시도 %d/2): %s — 룰 파서로 전환", attempt + 1, str(e))
            if attempt == 1:
                return extract_rule_based_curation(cleaned_review_text)

