"""Gemini 세대별 thinking 설정 — 한 곳에서 관리 (백엔드 B)

같은 분기(2.5는 thinkingBudget=0, 3.x는 thinkingLevel=low)가 서비스 6곳에 복붙돼
있었다 — 새 세대가 나오면 6곳을 다 고쳐야 하고 하나만 빠뜨려도 그 기능만 조용히
사고 토큰을 태우거나(2.5) 400을 맞는다(설정 이름 불일치). 여기 한 곳만 고치면 된다.

- 2.5 계열: 기본 '동적 사고'가 출력 토큰 예산을 잠식해 JSON이 잘린다(실측 349자 절단)
  → thinkingBudget=0. 단 이미지 모델(*-image)은 이 설정 자체가 400이라 제외.
- 3.x 계열: thinkingBudget 대신 thinkingLevel — 정형 추출·짧은 문구 위주라 low.
- 그 외(미래 세대·비지원 모델): None — 호출부는 설정을 넣지 않는다.
"""
from typing import Any, Optional


def thinking_config(model: str) -> Optional[dict[str, Any]]:
    """generationConfig["thinkingConfig"]에 넣을 값. 필요 없으면 None."""
    if model.startswith("gemini-2.5") and "image" not in model:
        return {"thinkingBudget": 0}
    if model.startswith("gemini-3"):
        return {"thinkingLevel": "low"}
    return None


def apply_thinking(generation_config: dict[str, Any], model: str) -> dict[str, Any]:
    """generation_config에 thinkingConfig를 제자리 적용하고 그대로 돌려준다."""
    cfg = thinking_config(model)
    if cfg:
        generation_config["thinkingConfig"] = cfg
    return generation_config


def safe_error_label(error: BaseException) -> str:
    """외부 AI 호출 오류를 비밀값 없는 운영용 라벨로 바꾼다.

    httpx 예외 문자열에는 `?key=...`가 붙은 요청 URL이 포함될 수 있다. 사용자 응답,
    폴백 결과 또는 로그에 예외 전문을 그대로 넣지 않고 오류 종류와 HTTP 상태만 남긴다.
    """
    response = getattr(error, "response", None)
    status = getattr(response, "status_code", None)
    kind = type(error).__name__
    return f"{kind} (HTTP {status})" if status is not None else kind
