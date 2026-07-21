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


def extract_curation_attributes_with_llm(cleaned_review_text: str, is_short: bool = False) -> ReviewCurationExtraction:
    """
    [한글 주석]
    정제된 리뷰 텍스트를 LLM(Gemini)에 전달하여 큐레이터 속성을 추출합니다.
    15자 미만 숏 리뷰이거나 파싱 실패 시 안전한 폴백(감성만 판별)을 수행합니다.
    """
    # 숏 리뷰인 경우: LLM 호출 최소화 (속성은 null, 감성만 기본 생성)
    if is_short or not cleaned_review_text.strip():
        # 간단 감성 체크
        sentiment: Literal["positive", "neutral", "negative"] = "positive" if any(w in cleaned_review_text for w in ["좋아요", "굿", "최고", "맛있", "만족"]) else "neutral"
        return ReviewCurationExtraction(
            acidity=None, body=None, sweetness=None, bitterness=None,
            roast_level=None, process=None, origin=None, caffeine=None,
            sentiment=sentiment,
            keywords=[],
            evidence=None
        )

    api_key = os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY")
    if not api_key:
        logger.warning("Gemini API Key가 지정되지 않아 큐레이터 속성 기본 폴백으로 반환합니다.")
        return ReviewCurationExtraction(sentiment="neutral", keywords=[])

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
            
            # JSON 파싱 및 Pydantic 엄격 검증
            data = json.loads(raw_json)
            validated = ReviewCurationExtraction.model_validate(data)
            return validated

        except (json.JSONDecodeError, ValidationError, Exception) as e:
            logger.warning("LLM 큐레이터 속성 파싱 실패 (시도 %d/2): %s", attempt + 1, str(e))
            if attempt == 1:
                # 2회 시도 실패 시 파이프라인 중단 없이 안전 폴백 반환
                return ReviewCurationExtraction(
                    sentiment="neutral",
                    keywords=["리뷰분석오류"],
                    evidence=f"추출 실패: {str(e)[:50]}"
                )
