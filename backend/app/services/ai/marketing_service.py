"""홍보/마케팅 도우미 (백엔드 B) — AI 홍보 문구 + AI 홍보 이미지 생성

등록한 카페를 홍보하는 콘텐츠를 만든다:

  1) 홍보 문구 생성  → generate_promotion_copy()
     매장 사실(상호·업태·위치·베스트 메뉴)을 근거로 눈길을 끄는 헤드라인·SNS 캡션·
     해시태그·이미지 프롬프트를 한 번에 만든다. 결과는 generated_documents에
     kind="marketing_content"로 저장돼 챗봇 카드·문서 목록에서 다시 볼 수 있다.

  2) 홍보 이미지 생성 → generate_promotion_image()
     4단계 파이프라인으로 '팔리는 홍보물'을 만든다:
       ① 프롬프트 정교화 — 무료 텍스트 모델이 짧은 아이디어를 구도·조명·렌즈·색감까지
          지정된 영어 아트 디렉션으로 확장한다 (_refine_image_prompt).
       ② 이미지 생성 — 여러 공급자를 순서대로 시도한다 (_generate_image_bytes).
          글자는 넣지 않는다.
       ③ 마감 보정 — 언샤프 마스크·미세 채도/대비로 화면에서 또렷하게 (_polish).
       ④ 한글 슬로건 합성 — Pillow로 그라데이션 스크림 + 슬로건/보조문구/상호를 얹는다
          (_compose_overlay). 모델이 한글을 못 그리는 문제를 우회하면서, 오히려
          모델 렌더링보다 훨씬 반듯한 타이포가 나온다.
     결과는 '슬로건 버전'과 '원본(글자 없는 버전)' 두 URL로 돌려준다.

  3) 슬로건 레이아웃 변경 → recompose_promotion_image()
     이미 만든 이미지의 원본을 재사용해 글자 위치만 바꾼다 (AI 재호출 없이 즉시).

과장·허위 금지: 프롬프트가 '매장 정보에 있는 사실 + 사장님 요청'만 재료로 쓰도록 강제한다.
없는 메뉴·지어낸 수상 경력·근거 없는 '전국 1위' 류 문구는 만들지 않는다.

필요 키 (backend/.env):
  GEMINI_API_KEY — 문구 생성용 (팀 공유 무료 키, 쿼터 주의)

이미지 생성 공급자 (순서대로 시도, 하나라도 되면 성공):
  1) pollinations — 주 공급자 (gen.pollinations.ai). GET 한 번으로 이미지를 준다.
                   2026-08-05 기준 Seed/Flower 같은 무료 티어는 폐지되고("Tiers have
                   stopped") Pollen 크레딧 지갑 방식이 됐다 → POLLINATIONS_TOKEN 필수.
                   기본 모델 zimage(0.004/장, 해상도 정확·5초) → 실패 시 klein으로
                   1회 폴백. flux는 2026-08-06 실측에서 요청 해상도를 무시하고
                   1024×1088만 돌려줘 기본에서 내렸다. 잔액이 떨어지면 402로 막힌다.
  MARKETING_IMAGE_PROVIDERS 로 순서·사용 여부를 바꾼다 (기본 "pollinations").
  [gemini 이미지 삭제 2026-08-08] 이미지 모델(gemini-*-image)은 무료 티어 한도가 0이라
                (실측 2026-07-31/08-05, 전 계열 limit: 0) 유료 키 없이는 반드시 실패했고,
                우리는 유료 키를 쓰지 않기로 해 경로 자체를 걷어냈다. 실질적인 폴백은
                Pollinations 모델 교체(zimage→klein)와 로컬 배경이다. 문구·정교화 같은
                텍스트 호출은 GEMINI_MODEL(3.1 계열)로 계속 Gemini를 쓴다.
모델 교체 (env):
  MARKETING_GEMINI_MODEL — 문구 생성 (기본: GEMINI_MODEL과 동일)
  POLLINATIONS_TOKEN — enter.pollinations.ai 가입 후 발급
  POLLINATIONS_MODEL / POLLINATIONS_FALLBACK_MODEL — 주/폴백 이미지 모델 (기본 zimage/klein)
한글 폰트 (슬로건 합성용):
  MARKETING_FONT_BOLD / MARKETING_FONT_REGULAR — 없으면 시스템 한글 폰트를 자동 탐색
  (리눅스 나눔고딕·노토, 윈도우 맑은고딕, macOS 애플고딕). 하나도 없으면 슬로건 합성만
  건너뛰고 이미지 자체는 정상 반환한다 → 배포 이미지에는 fonts-nanum을 넣어 둔다.
"""

import json
import logging
import os
import re
import time
import uuid
from functools import lru_cache
from io import BytesIO
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger(__name__)

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "") or os.getenv("GOOGLE_API_KEY", "")
COPY_MODEL = os.getenv("MARKETING_GEMINI_MODEL", "") or os.getenv("GEMINI_MODEL", "gemini-3.1-flash-lite")
IMAGE_PROVIDERS = [p.strip() for p in
                   os.getenv("MARKETING_IMAGE_PROVIDERS", "pollinations").split(",")
                   if p.strip()]

UPLOAD_DIR = Path(os.getenv("MARKETING_UPLOAD_DIR",
                            Path(__file__).resolve().parents[3] / "uploads" / "marketing"))
# 챗봇 라우터(/api/v1/chatbot)의 이미지 서빙 엔드포인트와 짝 — 여기 바꾸면 chatbot.py도 같이
IMAGE_URL_PREFIX = "/api/v1/chatbot/marketing/images"

# 영구 보관용 GCS 버킷 — 비우면 예전처럼 로컬 디스크만 쓴다(로컬 개발 기본값).
#
# [왜 필요한가] Cloud Run의 파일시스템은 인스턴스 메모리 위의 임시 공간이다. 배포할
# 때마다, 그리고 인스턴스가 늘거나 재생성될 때마다 uploads/marketing이 통째로 사라져
# 사장님 보관함의 홍보 이미지가 전부 깨진다(문서에는 URL이 남아 있는데 파일이 없음).
# 인스턴스가 2개 이상이면 A에서 만든 이미지를 B가 서빙하다 404가 나기도 한다.
#
# [비용] 버킷을 us-central1에 두면 GCP 상시 무료 한도(월 5GB 저장·쓰기 5천·읽기 5만·
# 북미발 전송 100GB)에 들어가 사실상 0원이다. 장당 0.5MB 기준 1만 장까지 무료.
GCS_BUCKET = os.getenv("MARKETING_GCS_BUCKET", "")
GCS_PREFIX = os.getenv("MARKETING_GCS_PREFIX", "marketing")

COPY_TIMEOUT = float(os.getenv("MARKETING_COPY_TIMEOUT", "30"))
# [15초 상한] 사장님이 버튼을 누르고 기다리는 시간이다. 90초를 주면 느린 날엔 정말로
# 90초를 기다리게 되고, 그 사이에 앱을 닫아 버린다. 공급자 하나당이 아니라 '전체 합계'다.
IMAGE_TIMEOUT = float(os.getenv("MARKETING_IMAGE_TIMEOUT", "15"))
# 생성 공급자가 전부 실패·지연했을 때 번들 배경으로라도 이미지를 낸다.
# 이게 있어야 '상한 안에 반드시 이미지가 나온다'가 성립한다 (0으로 끄면 에러를 던진다).
LOCAL_IMAGE_FALLBACK = os.getenv("MARKETING_IMAGE_LOCAL_FALLBACK", "1") not in ("0", "false", "False")
# 로컬 배경을 만들 시간 몫. 1707px 크롭·인코딩이 실측 0.2초라 1초면 충분히 넉넉하다.
_LOCAL_FALLBACK_RESERVE = 1.0
# 프롬프트 정교화 — 무료 텍스트 모델을 한 번 더 부르는 대신 결과 품질이 크게 오른다.
# 쿼터가 아까우면 0으로 끈다 (끄면 문구 AI가 준 image_prompt를 그대로 쓴다).
PROMPT_REFINE = os.getenv("MARKETING_PROMPT_REFINE", "1") not in ("0", "false", "False")
REFINE_TIMEOUT = float(os.getenv("MARKETING_REFINE_TIMEOUT", "20"))
# [정교화 벽시계 상한] REFINE_TIMEOUT은 HTTP 한 번의 제한이다 — Gemini 재시도(429 sleep
# 포함)에 Pollinations 텍스트 폴백까지 겹치면 생성을 시작하기도 전에 수십 초가 샌다.
# 사장님이 기다리는 건 '정교화 + 생성' 합계라, 여기서 벽시계로 한 번 더 자른다.
# 상한을 넘기면 원본 아이디어로 바로 생성에 들어간다 (품질보다 응답이 먼저다).
REFINE_BUDGET = float(os.getenv("MARKETING_REFINE_BUDGET", "8"))

# Gemini 이미지 모델이 지원하는 화면비 — SNS 정방형(1:1)이 기본, 스토리는 9:16
_ASPECT_RATIOS = {"1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"}

DOC_KIND = "marketing_content"

_CHANNEL_LABELS = {
    "instagram": "인스타그램 게시물",
    "blog": "네이버 블로그/매장 소식 글",
    "banner": "매장 현수막·포스터",
    "sms": "단골 안내 문자",
}


class MarketingError(RuntimeError):
    """홍보 콘텐츠 생성 실패 (키 미설정·쿼터 소진·이미지 생성 실패)"""


class _FreeTierZero(MarketingError):
    """이 키의 요금제에 해당 모델 한도가 아예 없다(limit: 0) — 기다려도 안 풀린다."""


class ImageCapacityError(MarketingError):
    """이미지 생성 공급자가 전부 한도에 걸렸다 — 서버 고장이 아니라 '지금은 불가'."""


# 세대별 thinking 설정은 gemini_config 한 곳에서 관리한다
from app.services.ai.gemini_config import thinking_config as _thinking_config


def _gemini_call(model: str, payload: dict[str, Any], timeout: float,
                 api_key: str = "") -> dict[str, Any]:
    """Gemini generateContent 공통 호출 — 5xx는 재시도, 429는 쿼터 안내로 즉시 실패.

    쿼터(429)는 팀 공유 무료 키라 재시도로 안 풀리는 경우가 대부분이다 — 짧게 한 번만
    더 시도하고, 사장님이 이해할 수 있는 문구로 실패를 알린다.
    api_key: 비우면 공용 GEMINI_API_KEY (이미지처럼 유료 키를 따로 쓸 때만 넘긴다)
    """
    key = (api_key or GEMINI_API_KEY or os.getenv("GEMINI_API_KEY", "")
           or os.getenv("GOOGLE_API_KEY", ""))
    if not key:
        raise MarketingError("GEMINI_API_KEY가 설정되어 있지 않아 홍보 콘텐츠를 만들 수 없습니다")

    import httpx

    last_error: Exception | None = None
    for attempt in (1, 2, 3):
        try:
            resp = httpx.post(
                f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={key}",
                json=payload,
                timeout=timeout,
            )
            if resp.status_code == 429:
                # "limit: 0" = 이 키의 요금제에 해당 모델 무료 한도가 아예 없다는 뜻 —
                # 기다려도 안 풀리므로 재시도하지 않고 원인을 그대로 알린다.
                # (실측 2026-07-31: 이미지 생성 모델 전 계열이 무료 티어 limit 0.
                #  텍스트 모델은 무료 한도가 있어 문구 생성은 정상 동작한다.)
                if "limit: 0" in resp.text:
                    raise _FreeTierZero(
                        "지금 서버의 AI 키 요금제에서는 이미지 생성이 지원되지 않습니다. "
                        "홍보 문구는 정상 이용 가능하며, 이미지는 유료 API 키 등록 후 열립니다.")
                if attempt == 1:
                    time.sleep(2)
                    continue
                raise MarketingError(
                    "오늘 사용할 수 있는 AI 사용량이 잠시 부족합니다. 조금 뒤에 다시 시도해 주세요.")
            if resp.status_code >= 500:
                last_error = MarketingError(f"Gemini HTTP {resp.status_code}")
                if attempt < 3:
                    time.sleep(2 * attempt)
                continue
            resp.raise_for_status()
            return resp.json()
        except MarketingError:
            raise
        except (httpx.HTTPError, ValueError, KeyError, IndexError) as e:
            from app.services.ai.gemini_config import safe_error_label
            last_error = MarketingError(safe_error_label(e))
            if attempt < 3:
                time.sleep(2 * attempt)
    raise MarketingError(f"AI 호출에 실패했습니다 ({model}): {last_error}")


# ---------------------------------------------------------------------------
# 매장 컨텍스트 — 문구의 '재료'가 되는 사실만 모은다 (전부 best-effort)
# ---------------------------------------------------------------------------

def _store_context(store_id: str) -> dict[str, Any]:
    """상호·업태·위치·영업시간·베스트 메뉴를 모은다. 조회 실패는 항목 생략으로 처리 —
    컨텍스트가 비어도 문구 생성 자체는 가능해야 한다 (신규 매장·DB 장애 대비)."""
    ctx: dict[str, Any] = {"store_name": "", "biz_type": "", "region": "",
                           "hours": "", "best_menus": []}
    try:
        from app.models.user import User
        from app.services.ai.document_service import _session

        with _session() as db:
            user = db.query(User).filter(User.email == store_id).first()
            if user:
                ctx["store_name"] = user.store_name or ""
                ctx["biz_type"] = user.store_biz_type or ""
                if user.store_lat is not None and user.store_lon is not None:
                    try:
                        from app.services.ai import forecast_service

                        region = forecast_service._reverse_geocode(user.store_lat, user.store_lon)
                        if region and not region.startswith("위도"):
                            ctx["region"] = region
                    except Exception:
                        pass
    except Exception:
        logger.warning("홍보 컨텍스트: 매장 기본 정보 조회 실패 — 생략하고 계속", exc_info=True)

    try:
        from app.models.ai import StoreProfile
        from app.services.ai.document_service import _session

        with _session() as db:
            profile = db.get(StoreProfile, store_id)
            if profile and profile.configured:
                ctx["hours"] = f"{profile.open_hour}~{profile.close_hour}"
                if profile.business_type:
                    ctx["biz_type"] = ctx["biz_type"] or profile.business_type
    except Exception:
        pass

    try:
        from datetime import datetime, timedelta

        from sqlalchemy import func as sa_func

        from app.models.inventory import Menu, Sale
        from app.services.ai.document_service import _session

        since = datetime.now() - timedelta(days=30)
        with _session() as db:
            rows = (
                db.query(Menu.name, sa_func.sum(Sale.quantity).label("qty"))
                .join(Menu, Sale.menu_id == Menu.id)
                .filter(Sale.store_id == store_id, Sale.sold_at >= since)
                .group_by(Menu.name)
                .order_by(sa_func.sum(Sale.quantity).desc())
                .limit(3)
                .all()
            )
            ctx["best_menus"] = [name for name, _qty in rows]
    except Exception:
        pass

    return ctx


# ---------------------------------------------------------------------------
# 1) 홍보 문구 생성
# ---------------------------------------------------------------------------

_COPY_SCHEMA = {
    "type": "object",
    "properties": {
        "headline": {"type": "string"},
        "sub_headline": {"type": "string"},
        "body": {"type": "string"},
        "sns_caption": {"type": "string"},
        "hashtags": {"type": "array", "items": {"type": "string"}},
        "short_slogan": {"type": "string"},
        "image_prompt": {"type": "string"},
        "posting_tip": {"type": "string"},
    },
    "required": ["headline", "sub_headline", "body", "sns_caption", "hashtags",
                 "short_slogan", "image_prompt", "posting_tip"],
}

_COPY_PROMPT = """너는 동네 카페 전문 마케팅 카피라이터다.
아래 매장 정보와 사장님 요청을 바탕으로, 지나가던 사람도 멈춰 서게 만드는 홍보 콘텐츠를 만든다.

절대 규칙:
- 매장 정보에 있는 사실과 사장님 요청만 재료로 쓴다. 없는 메뉴·지어낸 수상 경력·
  "전국 1위" 같은 근거 없는 주장·과장 광고는 금지.
- 할인·이벤트는 사장님 요청에 명시된 경우에만 언급한다 (멋대로 만들지 말 것).
- 한국어로 쓴다. 해시태그는 한국어·영어를 섞어도 좋다.

[매장 정보]
상호: {store_name}
업태/상권: {biz_type}
위치: {region}
영업시간: {hours}
최근 30일 베스트 메뉴: {best_menus}

[사장님 요청]
홍보 주제: {topic}
게시 채널: {channel}
원하는 톤: {tone}
강조할 메뉴: {menu}

출력 필드 규칙:
- headline: 15자 이내 캐치프레이즈 한 줄 — 눈길을 끄는 게 최우선
- sub_headline: headline을 받쳐주는 보조 문구, 25자 이내
- body: 매장 소식·블로그용 소개문 3~5문장 (채널이 sms면 90자 이내 문자 한 통으로)
- sns_caption: 인스타그램 캡션 — 이모지 2~4개, 줄바꿈 포함, 250자 이내, 해시태그는 넣지 말 것
- hashtags: 8~12개, 각 항목 # 포함 (지역명 + 메뉴 + 감성 태그 조합)
- short_slogan: 홍보 이미지에 크게 새길 8자 이내 문구
- image_prompt: 이 홍보물에 어울리는 이미지 생성용 영어 프롬프트 1~3문장.
  주제와 톤에서 어울리는 아트 디렉션을 스스로 골라 첫 문장에 명시할 것 —
  실사 사진(photorealistic photography), 수채화(watercolor illustration),
  플랫 벡터 일러스트(bold flat vector illustration), 레트로 필름(retro film),
  미니멀(minimal design), 아늑한 손그림(cozy hand-drawn art) 등에서 컨셉에 맞게.
  poster·sign·menu board처럼 글자를 유발하는 단어는 쓰지 말 것.
  '나무 테이블 위 커피잔' 같은 뻔한 구도를 피하고 주제에 맞는 장면·색감·분위기로
  매번 다르게 묘사할 것 (예: 여름 이벤트면 시원한 청량감, 유쾌한 톤이면 팝한 색).
  글자·텍스트를 넣으라는 지시는 쓰지 말 것.
- posting_tip: 이 채널에 올릴 때 도움이 될 팁 한 문장 (업로드 시간대·구도 등)"""


def generate_promotion_copy(store_id: str, topic: str = "", channel: str = "instagram",
                            tone: str = "", menu: str = "") -> dict[str, Any]:
    """매장 사실 기반 홍보 문구 세트를 만들어 문서로 저장한다.

    channel: instagram(기본) / blog / banner / sms.
    반환: document_service 문서 dict — content에 headline·sns_caption·hashtags·
          image_prompt 등 전체 필드와 images(생성 이미지 목록, 처음엔 빈 배열)가 담긴다.
    """
    from app.services.ai import document_service

    channel = channel if channel in _CHANNEL_LABELS else "instagram"
    ctx = _store_context(store_id)

    generation_config: dict[str, Any] = {
        "temperature": 0.9,  # 홍보 문구는 다양성이 생명 — 같은 요청에도 다른 카피가 나와야 한다
        "responseMimeType": "application/json",
        "responseSchema": _COPY_SCHEMA,
        "maxOutputTokens": 2048,
    }
    thinking = _thinking_config(COPY_MODEL)
    if thinking:
        generation_config["thinkingConfig"] = thinking

    prompt = _COPY_PROMPT.format(
        store_name=ctx["store_name"] or "이름 미등록 카페",
        biz_type=ctx["biz_type"] or "카페",
        region=ctx["region"] or "정보 없음",
        hours=ctx["hours"] or "정보 없음",
        best_menus=", ".join(ctx["best_menus"]) or "정보 없음",
        topic=topic or "매장 일반 홍보",
        channel=_CHANNEL_LABELS[channel],
        tone=tone or "따뜻하고 친근하게",
        menu=menu or "지정 없음",
    )

    raw = _gemini_call(COPY_MODEL, {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": generation_config,
    }, COPY_TIMEOUT)

    try:
        copy = json.loads(raw["candidates"][0]["content"]["parts"][0]["text"])
    except (KeyError, IndexError, json.JSONDecodeError) as e:
        raise MarketingError(f"홍보 문구 응답을 해석하지 못했습니다: {e}")

    content = {
        "channel": channel,
        "channel_label": _CHANNEL_LABELS[channel],
        "topic": topic,
        "tone": tone,
        "focus_menu": menu,
        "store_name": ctx["store_name"],
        **copy,
        "images": [],  # generate_promotion_image가 생성할 때마다 여기 추가된다
    }
    title = f"홍보 콘텐츠 — {copy.get('headline') or topic or _CHANNEL_LABELS[channel]}"
    return document_service._save_document(store_id, DOC_KIND, title[:200], content)


# ---------------------------------------------------------------------------
# 2) 홍보 이미지 생성
# ---------------------------------------------------------------------------

# Pollinations 생성용 화면비 → 픽셀 크기 (전부 64의 배수).
# 홍보물은 품질이 곧 설득력이라 고해상도(1400px대)를 기본으로 뽑는다.
# [실측 2026-08-06] zimage는 이 크기를 정확히 지키고 약 5초. 이보다 키우면(2.2MP급)
# 생성이 15~34초로 급증해 화질 이득 대비 손해다 — 그래서 quality=high가 곧 이 표다.
_AR_SIZES: dict[str, tuple[int, int]] = {
    "1:1": (1472, 1472), "4:5": (1152, 1440), "5:4": (1440, 1152),
    "3:4": (1056, 1408), "4:3": (1408, 1056), "2:3": (960, 1440), "3:2": (1440, 960),
    "9:16": (864, 1536), "16:9": (1536, 864), "21:9": (1792, 768),
}


def _target_size(aspect_ratio: str, quality: str) -> tuple[int, int]:
    """화면비·품질 → 생성 픽셀 크기. 가로세로에 같은 배율을 써서 비율이 틀어지지 않게 한다.

    high(기본)는 표의 1400px급 그대로, standard는 0.75배 — 사진 합성 배경처럼
    어차피 크롭·합성될 이미지는 작게 뽑아 더 빠르게.
    """
    w, h = _AR_SIZES.get(aspect_ratio, (1472, 1472))
    if quality == "high":
        return w, h
    return (max(512, round(w * 0.75 / 64) * 64), max(512, round(h * 0.75 / 64) * 64))


# Pollinations 신규 API. 예전 image.pollinations.ai/prompt/... 는 레거시고, 지금은
# gen.pollinations.ai가 공식이다 (OpenAPI: gen.pollinations.ai/openapi.json).
# 인증은 쿼리스트링 token이 아니라 Authorization: Bearer <pk_/sk_ 키>다.
POLLINATIONS_URL = os.getenv("POLLINATIONS_URL", "https://gen.pollinations.ai/image")
# 기본 zimage (장당 0.004 Pollen): [실측 2026-08-06 비교] flux는 이제 width/height를
# 무시하고 1024×1088 근처로만 돌려줘 4:5·16:9 요청이 전부 정방형에 가깝게 깨진다.
# zimage는 요청 해상도를 정확히 지키고, 더 빠르고(5초 vs 7.5초), 디테일도 또렷하다.
# flux(0.002)·klein(0.005)·dreamshaper(0.0001, 512² 저화질)는 env로 교체 가능.
POLLINATIONS_MODEL = os.getenv("POLLINATIONS_MODEL", "zimage")
# 주 모델이 타임아웃·5xx·429로 죽으면 이 모델로 1회 더 시도한다 — Gemini 폴백은
# 유료 키가 없으면 시체라, 실질 폴백은 이 모델 교체다. klein도 해상도를 지킨다(실측).
POLLINATIONS_FALLBACK_MODEL = os.getenv("POLLINATIONS_FALLBACK_MODEL", "klein")
# 모델당 대기 상한 — zimage 실측 4~15초라 45초면 넉넉하고, 폴백까지 돌아도
# 사장님 대기가 IMAGE_TIMEOUT(15초) 한 번 수준을 넘지 않는다.
_ATTEMPT_TIMEOUT = float(os.getenv("POLLINATIONS_ATTEMPT_TIMEOUT", "45"))

# Pollen 잔액이 이 값 아래로 내려가면 경고 로그 — 지갑이 비면 이미지 생성이 402로
# 조용히 죽는다(자동 충전 없음). 0.1 Pollen ≈ flux 50~100장, 충전할 시간은 충분하다.
_POLLEN_WARN_BELOW = float(os.getenv("POLLINATIONS_BALANCE_WARN", "0.1"))
_pollen_next_check = 0.0  # 성공할 때마다 매번 확인할 필요는 없다 — 10분에 한 번


def _check_pollen_balance() -> None:
    """잔액을 확인해 임박 소진을 로그로 미리 알린다 (백그라운드 전용, 실패 무해).

    Pollinations는 잔액 부족을 402 시점에야 알려줘, 그때는 이미 사장님이 실패를 겪은
    뒤다. 생성 성공 직후 가끔(10분 1회) 잔액을 조회해 Cloud Run 로그로 경고를 남기면
    소진 전에 enter.pollinations.ai에서 Quest/충전으로 대응할 수 있다.
    """
    global _pollen_next_check
    if time.monotonic() < _pollen_next_check:
        return
    _pollen_next_check = time.monotonic() + 600
    token = os.getenv("POLLINATIONS_TOKEN", "").strip()
    if not token:
        return
    try:
        import httpx

        r = httpx.get("https://gen.pollinations.ai/account/balance",
                      headers={"Authorization": f"Bearer {token}"}, timeout=8)
        balance = float(r.json().get("balance"))
    except Exception:
        logger.debug("Pollen 잔액 조회 실패(무해)", exc_info=True)
        return
    if balance < _POLLEN_WARN_BELOW:
        logger.warning(
            "Pollinations Pollen 잔액 %.3f — 곧 소진되어 홍보 이미지 생성이 멈춥니다. "
            "enter.pollinations.ai에서 Quest 보상 수령 또는 충전이 필요합니다.", balance)
    else:
        logger.info("Pollinations Pollen 잔액 %.3f", balance)


def image_health() -> dict[str, Any]:
    """이미지 생성 파이프라인 상태 한 장 — 장애 신고가 오면 이것부터 본다.

    잔액 조회는 실시간(best-effort)이라 몇 초 걸릴 수 있고, 실패하면 null.
    """
    balance: Optional[float] = None
    token = os.getenv("POLLINATIONS_TOKEN", "").strip()
    if token:
        try:
            import httpx

            r = httpx.get("https://gen.pollinations.ai/account/balance",
                          headers={"Authorization": f"Bearer {token}"}, timeout=8)
            balance = float(r.json().get("balance"))
        except Exception:
            logger.debug("health: Pollen 잔액 조회 실패", exc_info=True)
    return {
        "providers": IMAGE_PROVIDERS,
        "pollinations_token": bool(token),
        "pollinations_model": POLLINATIONS_MODEL,
        "pollinations_fallback_model": POLLINATIONS_FALLBACK_MODEL,
        # 실물 사진 홍보는 별도 편집 모델을 쓴다 — 장당 값이 10배라 여기서 같이 본다
        "photo_edit_model": os.getenv("PHOTO_EDIT_MODEL", "kontext"),
        "photo_edit_enabled": os.getenv("PHOTO_EDIT_AI", "1") != "0",
        "pollen_balance": balance,
        "pollen_warn_below": _POLLEN_WARN_BELOW,
        "korean_font": korean_font_available(),
        "gcs_bucket": GCS_BUCKET if _gcs_bucket() is not None else "",
    }


class _PollinationsHardFail(MarketingError):
    """키·잔액 문제 — 모델을 바꿔도 똑같이 실패하므로 폴백 없이 즉시 알린다."""


def _pollinations_once(prompt: str, model: str, w: int, h: int,
                       token: str, budget: Optional[float] = None) -> tuple[bytes, str, int]:
    """Pollinations 이미지 1회 시도 — 성공 시 (바이트, mime, seed).

    타임아웃·5xx·429·이미지 아닌 응답은 MarketingError(폴백 가능),
    잔액·키 문제는 _PollinationsHardFail(폴백 무의미)로 구분해 던진다.
    """
    import urllib.parse

    import httpx

    # 프롬프트가 URL 경로에 실리므로 '/'까지 전부 인코딩해야 한다(safe='') —
    # 기본 quote는 '/'를 남겨 경로가 쪼개지며 404가 난다(실측). 줄바꿈도 공백으로.
    encoded = urllib.parse.quote(" ".join(prompt[:1500].split()), safe="")
    # [같은 이미지 반복 버그 수정] 같은 URL은 캐시로 응답해, seed 없이 부르면 같은
    # 프롬프트가 영원히 같은 이미지를 준다(실측). 매 호출 랜덤 seed로 항상 새 그림을.
    seed = uuid.uuid4().int % 1_000_000_000
    params = {"model": model, "width": str(w), "height": str(h), "seed": str(seed)}
    headers = {"Authorization": f"Bearer {token}"} if token else {}

    # httpx에 float를 주면 연결·읽기·쓰기에 각각 그 시간을 준다 — 합치면 상한을 넘는다.
    # 총 시간을 지키려면 Timeout으로 단계별 몫을 나눠 줘야 한다.
    left = min(IMAGE_TIMEOUT, _ATTEMPT_TIMEOUT) if budget is None else max(1.0, budget)
    limits = httpx.Timeout(left, connect=min(5.0, left), read=left, write=left)
    try:
        r = httpx.get(f"{POLLINATIONS_URL}/{encoded}", params=params, headers=headers,
                      timeout=limits, follow_redirects=True)
    except httpx.TimeoutException:
        raise MarketingError(f"이미지 생성이 {left:.0f}초 안에 끝나지 않았습니다.")
    except httpx.HTTPError as e:
        raise MarketingError(f"이미지 생성 서버(Pollinations)에 연결하지 못했습니다: {e}")

    ctype = (r.headers.get("content-type") or "").split(";")[0].strip()
    if r.status_code == 200 and ctype.startswith("image/") and r.content:
        return r.content, ctype, seed

    # 실패는 원인별로 갈라 안내한다 — 사장님이 할 수 있는 조치가 완전히 다르기 때문이다.
    body = (r.text or "")[:400]
    if r.status_code == 402 or "Insufficient balance" in body or "PAYMENT_REQUIRED" in body:
        raise _PollinationsHardFail(
            "Pollinations API 키가 등록돼 있지 않습니다 (POLLINATIONS_TOKEN)."
            if not token else
            "Pollinations 잔액(Pollen)이 떨어졌습니다. 대시보드에서 Quest를 완료하거나 충전해 주세요.")
    if r.status_code in (401, 403):
        raise _PollinationsHardFail("Pollinations API 키가 거부됐습니다. 키가 유효한지 확인해 주세요.")
    if r.status_code == 429:
        raise MarketingError("이미지 생성 요청이 몰렸습니다. 잠시 뒤에 다시 눌러 주세요.")
    raise MarketingError(f"이미지 생성에 실패했습니다 (HTTP {r.status_code}): {body[:150]}")


def _pollinations_generate(prompt: str, aspect_ratio: str, quality: str = "high",
                           timeout: Optional[float] = None) -> tuple[bytes, str, dict[str, Any]]:
    """주 공급자 — Pollinations.ai. 성공 시 (바이트, mime, {model, seed}).

    주 모델(zimage)이 타임아웃·일시 오류로 죽으면 대체 모델(klein)로 1회 더 시도한다 —
    Gemini 공급자 폴백은 유료 키가 없으면 동작하지 않아, 실질적인 폴백은 이 모델
    교체다. 잔액·키 문제는 모델을 바꿔도 똑같으므로 즉시 실패한다.

    이미지 모델은 한글 렌더링이 깨지므로 글자 없는 프롬프트로만 부르고, 슬로건은
    _compose_overlay가 Pillow로 직접 얹는다.

    [토큰 필수] 2026-08-05 기준 Pollinations는 Pollen(크레딧) 지갑 방식이고, 예전
    Seed/Flower 티어는 폐지됐다("Tiers have stopped"). 토큰 없는 익명 호출은 잔액
    부족으로 402가 난다(실측). enter.pollinations.ai에서 GitHub 로그인 → API 키를
    만들고 POLLINATIONS_TOKEN에 넣어야 동작한다.
    """
    w, h = _target_size(aspect_ratio, quality)
    token = os.getenv("POLLINATIONS_TOKEN", "").strip()

    models = [POLLINATIONS_MODEL]
    if POLLINATIONS_FALLBACK_MODEL and POLLINATIONS_FALLBACK_MODEL not in models:
        models.append(POLLINATIONS_FALLBACK_MODEL)

    # 모델 교체도 주어진 예산 '안에서' 끝나야 한다 — 모델마다 상한을 새로 주면 두 배가 된다
    deadline = None if timeout is None else time.monotonic() + timeout
    last_error: Exception | None = None
    for model in models:
        budget = None if deadline is None else deadline - time.monotonic()
        if budget is not None and budget <= 1.0:
            break  # 1초 미만 남으면 왕복만 낭비된다
        try:
            image, mime, seed = _pollinations_once(prompt, model, w, h, token, budget=budget)
        except _PollinationsHardFail:
            raise
        except MarketingError as e:
            last_error = e
            logger.info("Pollinations 모델 %s 실패 → 다음 모델: %s", model, e)
            continue
        # 잔액 확인은 응답을 붙잡지 않게 백그라운드로 — 실패해도 이번 생성과 무관
        import threading

        threading.Thread(target=_check_pollen_balance, daemon=True).start()
        return image, mime, {"model": model, "seed": seed}
    raise last_error or MarketingError("이미지 생성에 실패했습니다")


# ---------------------------------------------------------------------------
# 공급자 체인 — 하나라도 성공하면 이미지가 나온다
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# 마지막 수단 — 네트워크를 타지 않는 로컬 배경
# ---------------------------------------------------------------------------

_LOCAL_BG_DIR = os.path.join(os.path.dirname(__file__), "..", "..", "static", "promo_bg")
# 번들 배경 파일명. photo_promo_service의 BACKGROUND_STYLES와 같은 자산을 쓴다.
_LOCAL_BG_FILES = ("wood", "marble", "cozy", "studio", "season")


def _local_background(aspect_ratio: str, quality: str) -> tuple[bytes, str]:
    """번들 배경(없으면 그라데이션)을 요청 비율로 잘라 돌려준다. 실패하지 않는다.

    이게 있어야 '15초 안에 반드시 이미지가 나온다'가 참이 된다. 생성 공급자는 남의
    서버라 응답 시간을 우리가 정할 수 없지만, 이 경로는 디스크와 CPU만 쓰므로
    수십 밀리초면 끝난다.

    AI가 만든 그림이 아니므로 provider를 'local-bundled'로 남긴다 — 화면과 저장
    문서에서 어느 것이 AI 생성물인지 구분할 수 있어야 한다.
    """
    import io as _io
    import random

    from PIL import Image

    w, h = _target_size(aspect_ratio, quality)

    for name in random.sample(_LOCAL_BG_FILES, len(_LOCAL_BG_FILES)):
        path = os.path.join(_LOCAL_BG_DIR, f"{name}.jpg")
        try:
            with open(path, "rb") as f:
                bg = Image.open(_io.BytesIO(f.read())).convert("RGB")
        except Exception:
            continue  # 자산이 빠졌어도 다음 파일 / 최후엔 그라데이션으로 간다
        scale = max(w / bg.width, h / bg.height)
        bg = bg.resize((round(bg.width * scale), round(bg.height * scale)), Image.LANCZOS)
        left, top = (bg.width - w) // 2, (bg.height - h) // 2
        buf = _io.BytesIO()
        bg.crop((left, top, left + w, top + h)).save(buf, "JPEG", quality=92)
        return buf.getvalue(), "image/jpeg"

    # 자산이 하나도 없을 때 — 크림→라떼 베이지 그라데이션 (photo_promo_service와 같은 색)
    img = Image.new("RGB", (w, h))
    top_c, bottom_c = (250, 246, 240), (233, 223, 208)
    for y in range(h):
        t = y / max(1, h - 1)
        img.paste(tuple(round(top_c[i] + (bottom_c[i] - top_c[i]) * t) for i in range(3)),
                  (0, y, w, y + 1))
    buf = _io.BytesIO()
    img.save(buf, "JPEG", quality=92)
    return buf.getvalue(), "image/jpeg"


# [gemini 이미지 삭제 2026-08-08] 이미지 생성 공급자 테이블 — 이름 → 생성 함수.
# 서명은 (prompt, aspect_ratio, quality, timeout=None) → (bytes, mime, meta)로 통일한다.
# 새 공급자는 여기 한 줄이면 체인(합계 시간 상한·화면비 보정·로컬 폴백)을 그대로 얻는다.
_PROVIDER_FUNCS = {
    "pollinations": lambda prompt, aspect_ratio, quality, timeout=None:
        _pollinations_generate(prompt, aspect_ratio, quality, timeout=timeout),
}


def _enforce_aspect(image_bytes: bytes, mime: str, aspect_ratio: str) -> tuple[bytes, str]:
    """공급자가 요청 화면비를 무시하면 중앙 크롭으로 맞춘다.

    [실측 2026-08-06] flux는 width/height를 무시하고 1024×1088 근처만 돌려준다 —
    기본 모델에서는 내렸지만 env로 되살릴 수 있고, 폴백 모델이 언제 같은 버릇을
    보일지 모른다. 화면비가 틀어진 채 내보내면 4:5 피드·16:9 배너 자리에서 잘리거나
    찌그러진다. 오차 2% 이내면 원본 그대로, 그 밖이면 긴 쪽을 잘라 비율을 맞춘다.
    해석 불가한 바이트(디코드 실패)는 원본을 그대로 돌려준다 — 여기서 죽으면 안 된다.
    """
    try:
        from PIL import Image

        w, h = _AR_SIZES.get(aspect_ratio, (1472, 1472))
        target = w / h
        im = Image.open(BytesIO(image_bytes))
        actual = im.width / im.height
        if abs(actual - target) / target <= 0.02:
            return image_bytes, mime
        if actual > target:  # 요청보다 넓다 → 좌우를 잘라낸다
            new_w = round(im.height * target)
            left = (im.width - new_w) // 2
            im = im.crop((left, 0, left + new_w, im.height))
        else:                # 요청보다 길다 → 위아래를 잘라낸다
            new_h = round(im.width / target)
            top = (im.height - new_h) // 2
            im = im.crop((0, top, im.width, top + new_h))
        logger.info("공급자가 화면비 %s를 무시(%.2f) → 중앙 크롭 %d×%d",
                    aspect_ratio, actual, im.width, im.height)
        buf = BytesIO()
        im.convert("RGB").save(buf, format="JPEG", quality=_JPEG_QUALITY, subsampling=0)
        return buf.getvalue(), "image/jpeg"
    except Exception:
        return image_bytes, mime


def _generate_image_bytes(prompt: str, aspect_ratio: str,
                          quality: str) -> tuple[bytes, str, str, dict[str, Any]]:
    """설정된 공급자를 순서대로 시도해 (바이트, mime, 공급자명, 메타)를 돌려준다.

    메타에는 실제 사용된 model과 (Pollinations면) seed가 담긴다 — 어떤 모델이 그렸는지
    추적하고, 같은 그림을 재현할 수 있게.

    [총 IMAGE_TIMEOUT초 상한] 공급자·모델마다 타임아웃을 주면 여러 번 시도할 때 그만큼
    배로 걸린다. 여기서 벽시계 마감을 한 번 잡고 남은 시간만 아래로 넘겨, 몇 번을
    시도하든 전체가 그 시간을 넘지 않게 한다 — 사장님이 실제로 기다리는 건 이 합계다.

    [반드시 이미지가 나온다] 생성 공급자는 남의 서버라 응답 시간을 우리가 정할 수
    없다. 그래서 마지막에 네트워크를 타지 않는 로컬 배경을 둔다 — 디스크와 CPU만 쓰니
    수십 밀리초면 끝나고, 실패할 구석이 없다. 덕분에 '상한 안에 무조건 이미지가
    나온다'가 참이 된다. 대신 AI 생성물이 아니므로 provider로 구분되게 남긴다.

    MARKETING_IMAGE_LOCAL_FALLBACK=0 으로 끄면 예전처럼 전부 실패 시 에러를 던진다.
    """
    deadline = time.monotonic() + IMAGE_TIMEOUT
    errors: list[str] = []
    for name in IMAGE_PROVIDERS:
        # 로컬 폴백이 돌 시간(넉넉히 1초)은 남겨 둔다 — 그래야 상한을 넘기지 않는다
        left = deadline - time.monotonic() - _LOCAL_FALLBACK_RESERVE
        if left <= 1.0:  # 1초 미만 남으면 어차피 못 받는다 — 왕복만 낭비된다
            errors.append(f"[{name}] {IMAGE_TIMEOUT:.0f}초 안에 순서가 오지 않아 건너뜀")
            break
        provider_fn = _PROVIDER_FUNCS.get(name)
        if provider_fn is None:
            continue  # 모르는 공급자 이름은 건너뛴다 (env 오타가 전체를 죽이지 않게)
        try:
            image, mime, meta = provider_fn(prompt, aspect_ratio, quality, timeout=left)
            # 공급자가 요청 화면비를 무시했으면 여기서 바로잡는다 (2% 이내면 원본 유지)
            image, mime = _enforce_aspect(image, mime, aspect_ratio)
            return image, mime, name, meta
        except Exception as e:  # 어떤 공급자가 어떻게 죽든 다음 공급자로 넘어간다
            errors.append(f"[{name}] {e}")
            logger.info("이미지 공급자 %s 실패 → 다음 공급자: %s", name, e)

    detail = " / ".join(errors)[:500]
    if LOCAL_IMAGE_FALLBACK:
        logger.warning("생성 공급자 전부 실패 → 로컬 배경으로 채움: %s", detail)
        image, mime = _local_background(aspect_ratio, quality)
        return image, mime, "local-bundled", {"model": "local-bundled", "seed": None}

    logger.error("이미지 생성 전 공급자 실패: %s", detail)
    raise ImageCapacityError(
        "지금은 무료 이미지 생성 한도가 모두 차 있어요. 10분쯤 뒤에 다시 시도해 주세요. "
        "(홍보 문구와 '내 사진으로 만들기'는 지금도 됩니다)")


# ---------------------------------------------------------------------------
# 2-①) 프롬프트 정교화 — 무료 텍스트 모델로 아트 디렉션을 붙인다
# ---------------------------------------------------------------------------

_REFINE_PROMPT = """너는 광고 사진 아트 디렉터다. 아래 '이미지 아이디어'를 이미지 생성 모델에
넣을 영어 프롬프트 한 문단으로 정교하게 다듬어라.

반드시 구체적으로 담을 것:
1) 피사체와 디테일(재료의 질감, 김·물방울·crema 같은 미시 묘사)
2) 카메라 구도와 앵글(예: 45-degree angle, overhead flat lay, close-up macro)
3) 조명(예: soft window light from the left, golden hour backlight, moody low-key)
4) 렌즈·촬영 스펙 — 실사 계열일 때만 (예: 85mm f/1.8, shallow depth of field)
5) 색감 팔레트와 분위기, 배경·소품 구성

규칙:
- 아트 디렉션 지시가 주어졌다면 그 스타일을 최우선으로 따르고, 사진 용어는 그 스타일의
  언어로 바꿔라 (일러스트면 brush stroke·line weight·flat color 등).
- 글자·문자·타이포그래피·간판·로고·메뉴판은 절대 넣지 않는다. poster, sign, text, menu board,
  label, logo 같은 단어 자체를 쓰지 마라 (모델이 깨진 가짜 글자를 그려 넣는다).
- '글자가 붙어 있을 법한 물건'도 배경에서 빼라: 칠판·액자·자격증·상표 붙은 포장·전단.
  벽은 비우고, 소품은 식물·컵·원두·천 같은 글자 없는 것만 쓴다.
- 가능하면 넓은 실내 전경보다 피사체에 가까운 구도를 택해라 — 배경이 넓을수록 모델이
  빈 벽을 간판으로 채우려 든다(실측).
- 사람은 얼굴 클로즈업 대신 손·실루엣·뒷모습 위주로만 등장시켜라.
- {composition_hint}
- 60~90 단어의 영어 산문 한 문단만 출력한다. 목록·설명·따옴표 금지.

[이미지 아이디어]
{idea}

[아트 디렉션 지시]
{style}

[화면비]
{aspect_ratio}"""

# 슬로건을 얹을 자리를 미리 비워 두게 한다 — 합성 결과가 눈에 띄게 깔끔해진다.
# [실측 2026-08-06] '어두운 여백(dark negative space)'이라고 쓰면 정교화가 그 문구를
# 그대로 옮기고, 프롬프트를 정확히 따르는 모델(zimage)이 진짜 검은 단색 띠를 그린다.
# 반드시 '장면의 일부(테이블 표면·그림자·보케)로 잔잔하게'라고 시켜야 한다.
_COMPOSITION_HINTS = {
    "bottom": "화면 아래 1/3은 주 피사체 없이 잔잔하게 두되, 빈 여백 블록이 아니라 "
              "초점이 나간 테이블 표면·부드러운 그림자처럼 장면의 자연스러운 연장으로 채워라 "
              "(그 자리에 문구가 올라간다). 'empty space'나 'negative space' 같은 표현은 쓰지 마라 — "
              "모델이 검은 단색 띠를 그린다.",
    "top": "화면 위 1/3은 주 피사체 없이 잔잔하게 두되, 빈 여백 블록이 아니라 흐린 배경·"
           "부드러운 빛처럼 장면의 자연스러운 연장으로 채워라 (그 자리에 문구가 올라간다). "
           "'empty space'나 'negative space' 같은 표현은 쓰지 마라.",
    "center": "화면 한가운데는 시선이 쉬도록 단순하게 두고 피사체는 가장자리로 배치해라 "
              "(가운데에 문구가 올라간다).",
    "none": "화면 전체를 꽉 채우는 완결된 구도로 만들어라.",
}


def _pollinations_text(prompt: str) -> str:
    """Pollinations 텍스트 모델로 짧은 완성을 받는다 (프롬프트 정교화 폴백용).

    Gemini 무료 쿼터가 마르면 정교화가 통째로 건너뛰어지는데, 그러면 한국어 아이디어가
    번역도 안 된 채 이미지 모델로 넘어가 결과가 크게 망가진다(실측: '라떼 클로즈업'을
    넣었는데 가짜 간판 가득한 실내 전경이 나옴). 이미지와 같은 계정의 텍스트 모델을
    쓰면 비용이 사실상 0(장당 0.00001 Pollen 수준)이라 폴백으로 적합하다.
    """
    import httpx

    token = os.getenv("POLLINATIONS_TOKEN", "").strip()
    if not token:
        raise MarketingError("POLLINATIONS_TOKEN이 없어 텍스트 폴백을 쓸 수 없습니다")
    r = httpx.post(
        "https://gen.pollinations.ai/v1/chat/completions",
        headers={"Authorization": f"Bearer {token}"},
        json={"model": os.getenv("POLLINATIONS_TEXT_MODEL", "nova-fast"),
              "messages": [{"role": "user", "content": prompt}],
              "max_tokens": 300, "temperature": 0.85},
        timeout=REFINE_TIMEOUT,
    )
    if r.status_code != 200:
        raise MarketingError(f"Pollinations 텍스트 HTTP {r.status_code}: {r.text[:120]}")
    return (r.json()["choices"][0]["message"]["content"] or "").strip()


# Gemini 정교화가 쿼터로 죽으면 한동안 건너뛴다 — 죽은 시간대에는 요청마다
# 실패 왕복(재시도 sleep 포함 4~8초)을 반복하며 사장님 대기만 늘리기 때문이다.
# 블록 중에는 바로 Pollinations 텍스트 폴백으로 간다. 쿼터는 보통 다음날(한국
# 오후 4~5시) 풀리지만, 일시 오류일 수도 있어 10분 단위로만 막는다.
_gemini_refine_blocked_until = 0.0
_REFINE_BLOCK_SECONDS = float(os.getenv("MARKETING_REFINE_BLOCK_SECONDS", "600"))


def _refine_image_prompt(idea: str, style: str, aspect_ratio: str, layout: str) -> str:
    """짧은 이미지 아이디어를 상세 아트 디렉션 프롬프트로 확장한다.

    이 단계는 '있으면 좋은 것'이 아니라 사실상 필수다 — 사장님 입력은 한국어인데
    이미지 모델은 영어 프롬프트를 기대하기 때문이다. 그래서 Gemini가 쿼터로 막히면
    Pollinations 텍스트 모델로 폴백한다. 둘 다 실패할 때만 원본을 그대로 쓴다.
    """
    global _gemini_refine_blocked_until

    if not PROMPT_REFINE or not idea.strip():
        return idea
    prompt = _REFINE_PROMPT.format(
        idea=idea.strip()[:1200],
        style=style.strip() or "지정 없음 — 아이디어에 가장 어울리는 스타일을 골라라",
        aspect_ratio=aspect_ratio,
        composition_hint=_COMPOSITION_HINTS.get(layout, _COMPOSITION_HINTS["none"]),
    )
    generation_config: dict[str, Any] = {"temperature": 0.85, "maxOutputTokens": 512}
    thinking = _thinking_config(COPY_MODEL)
    if thinking:
        generation_config["thinkingConfig"] = thinking
    try:
        if time.monotonic() < _gemini_refine_blocked_until:
            raise MarketingError("Gemini 정교화가 쿼터로 막혀 있어 건너뜁니다")
        raw = _gemini_call(COPY_MODEL, {
            "contents": [{"parts": [{"text": prompt}]}],
            "generationConfig": generation_config,
        }, REFINE_TIMEOUT)
        text = raw["candidates"][0]["content"]["parts"][0]["text"].strip()
    except (MarketingError, KeyError, IndexError) as e:
        if time.monotonic() >= _gemini_refine_blocked_until:
            _gemini_refine_blocked_until = time.monotonic() + _REFINE_BLOCK_SECONDS
            logger.info("Gemini 프롬프트 정교화 실패 (%s) — %d초 블록, Pollinations 텍스트로 폴백",
                        e, int(_REFINE_BLOCK_SECONDS))
        try:
            text = _pollinations_text(prompt)
        except Exception as e2:
            logger.info("프롬프트 정교화 폴백도 실패 (%s) — 원본 프롬프트 사용", e2)
            return idea
    text = " ".join(text.replace("\n", " ").split())
    # 모델이 가끔 따옴표로 감싸 돌려준다 — 그대로 두면 프롬프트에 그대로 실린다
    text = text.strip('"').strip("'").strip()
    return text or idea


def _refine_with_budget(idea: str, style: str, aspect_ratio: str, layout: str) -> str:
    """_refine_image_prompt를 REFINE_BUDGET초 벽시계 상한 안에서 돌린다.

    정교화 내부는 HTTP 재시도·폴백이 겹쳐 최악의 경우 상한 없이 늘어진다 — 그 시간은
    전부 사장님 대기다. 스레드로 돌리고 상한까지만 기다린 뒤, 못 끝냈으면 원본
    아이디어로 진행한다 (뒤늦게 끝난 스레드 결과는 버려진다 — 무해).
    """
    if not PROMPT_REFINE or not idea.strip():
        return idea
    import threading

    result: list[str] = []
    worker = threading.Thread(
        target=lambda: result.append(_refine_image_prompt(idea, style, aspect_ratio, layout)),
        daemon=True)
    worker.start()
    worker.join(REFINE_BUDGET)
    if not result:
        logger.info("프롬프트 정교화가 %.0f초 안에 못 끝나 원본 아이디어로 진행", REFINE_BUDGET)
        return idea
    return result[0]


# ---------------------------------------------------------------------------
# 2-③) 마감 보정 — 언샤프 마스크로 화면에서 또렷하게
# ---------------------------------------------------------------------------

# 최종 저장 포맷: 사진형 홍보물이라 JPEG 고품질이 PNG보다 10배 가볍고 화질 차이가 없다.
# 모바일에서 로딩이 체감으로 빨라진다.
_JPEG_QUALITY = int(os.getenv("MARKETING_JPEG_QUALITY", "93"))


def _polish(image_bytes: bytes, fallback_mime: str = "image/png") -> tuple[bytes, str]:
    """생성 이미지를 인쇄물 느낌으로 다듬는다 — 선명도 ↑, 채도·대비 미세 보정.

    보정 실패(포맷 이상 등)는 원본 바이트와 원래 mime을 그대로 반환한다.
    """
    try:
        from PIL import Image, ImageEnhance, ImageFilter

        im = Image.open(BytesIO(image_bytes))
        im = im.convert("RGB")
        # radius/percent는 과하면 윤곽에 흰 테두리(halo)가 생긴다 — 실측으로 잡은 보수적 값
        im = im.filter(ImageFilter.UnsharpMask(radius=1.4, percent=52, threshold=3))
        im = ImageEnhance.Color(im).enhance(1.05)
        im = ImageEnhance.Contrast(im).enhance(1.04)
        buf = BytesIO()
        im.save(buf, format="JPEG", quality=_JPEG_QUALITY, subsampling=0, optimize=True)
        return buf.getvalue(), "image/jpeg"
    except Exception:
        logger.warning("이미지 마감 보정 실패 — 원본 사용", exc_info=True)
        return image_bytes, fallback_mime


# ---------------------------------------------------------------------------
# 2-④) 한글 슬로건 합성 — Pillow로 직접 그린다
# ---------------------------------------------------------------------------

OVERLAY_LAYOUTS = ("auto", "none", "bottom", "center", "top")

_FONT_CANDIDATES_BOLD = [
    os.getenv("MARKETING_FONT_BOLD", ""),
    "/usr/share/fonts/truetype/nanum/NanumGothicBold.ttf",
    "/usr/share/fonts/truetype/nanum/NanumBarunGothicBold.ttf",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Bold.ttc",
    "C:/Windows/Fonts/malgunbd.ttf",
    "/System/Library/Fonts/AppleSDGothicNeo.ttc",
]
_FONT_CANDIDATES_REGULAR = [
    os.getenv("MARKETING_FONT_REGULAR", ""),
    "/usr/share/fonts/truetype/nanum/NanumGothic.ttf",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
    "C:/Windows/Fonts/malgun.ttf",
    "/System/Library/Fonts/AppleSDGothicNeo.ttc",
]


@lru_cache(maxsize=2)
def _font_path(bold: bool) -> str:
    """설치된 한글 폰트 경로 하나를 고른다 (없으면 빈 문자열)."""
    for cand in (_FONT_CANDIDATES_BOLD if bold else _FONT_CANDIDATES_REGULAR):
        if cand and Path(cand).is_file():
            return cand
    # 굵은 폰트가 없으면 일반 폰트라도 (반대도 마찬가지)
    for cand in (_FONT_CANDIDATES_REGULAR if bold else _FONT_CANDIDATES_BOLD):
        if cand and Path(cand).is_file():
            return cand
    return ""


def korean_font_available() -> bool:
    """슬로건 합성이 가능한 환경인지 — 프론트에 기능 노출 여부를 알릴 때 쓴다."""
    return bool(_font_path(True))


def _load_font(bold: bool, size: int):
    from PIL import ImageFont

    path = _font_path(bold)
    if not path:
        raise MarketingError("한글 폰트를 찾을 수 없습니다")
    return ImageFont.truetype(path, size)


def _wrap_lines(draw, text: str, font, max_width: int, max_lines: int) -> tuple[list[str], bool]:
    """글자 단위 줄바꿈 — 한국어는 공백이 드물어 단어 단위로는 거의 안 접힌다.

    반환: (줄 목록, 전부 담겼는지). 다 못 담으면 마지막 줄 끝을 …으로 줄인다.
    """
    lines: list[str] = []
    cur = ""
    for ch in text:
        if not cur or draw.textlength(cur + ch, font=font) <= max_width:
            cur += ch
            continue
        lines.append(cur)
        cur = ch
        if len(lines) == max_lines:
            last = lines[-1]
            while last and draw.textlength(last + "…", font=font) > max_width:
                last = last[:-1]
            lines[-1] = last + "…"
            return lines, False
    if cur:
        lines.append(cur)
    return lines, True


def _fit_text(draw, text: str, max_width: int, start: int, bold: bool,
              floor_1line: int, floor_2line: int) -> tuple[Any, list[str]]:
    """한 줄로 들어가게 최대한 줄여 보고, 그래도 안 되면 두 줄로 접는다.

    슬로건은 한 줄이 가장 예쁘지만, 무리하게 줄이면 글자가 작아 눈에 안 띈다 —
    한 줄 하한(floor_1line)까지만 줄이고 그 아래로는 두 줄 배치로 넘어간다.
    """
    for max_lines, floor in ((1, floor_1line), (2, floor_2line)):
        size = start
        while size >= floor:
            font = _load_font(bold, size)
            lines, ok = _wrap_lines(draw, text, font, max_width, max_lines)
            if ok:
                return font, lines
            size = int(size * 0.94)
    font = _load_font(bold, floor_2line)
    return font, _wrap_lines(draw, text, font, max_width, 2)[0]


def _scrim(size: tuple[int, int], anchor: str, coverage: float, strength: int):
    """텍스트 가독성용 그라데이션 검은 막 — anchor 쪽이 진하고 반대쪽으로 투명해진다."""
    from PIL import Image

    w, h = size
    span = max(1, int(h * coverage))
    grad = Image.new("L", (1, span))
    for y in range(span):
        t = y / max(1, span - 1)
        # 제곱 커브: 가장자리는 확실히 가리고 가운데로 갈수록 자연스럽게 사라진다
        value = int(strength * (t ** 1.6)) if anchor == "bottom" else int(strength * ((1 - t) ** 1.6))
        grad.putpixel((0, y), value)
    mask = grad.resize((w, span))
    layer = Image.new("L", (w, h), 0)
    layer.paste(mask, (0, 0 if anchor == "top" else h - span))
    return layer


def _draw_text(draw, xy, text, font, fill, shadow=True, anchor="la"):
    """그림자를 깐 텍스트 — 밝은 사진 위에서도 글자가 뜬다."""
    if shadow:
        off = max(1, font.size // 22)
        draw.text((xy[0] + off, xy[1] + off), text, font=font, fill=(0, 0, 0, 130), anchor=anchor)
    draw.text(xy, text, font=font, fill=fill, anchor=anchor)


_ACCENT = (226, 130, 87)  # colors.pointOrange — 앱 테마와 같은 색


def _compose_overlay(image_bytes: bytes, *, slogan: str, sub: str, store: str,
                     layout: str) -> Optional[bytes]:
    """홍보 이미지 위에 한글 슬로건·보조문구·상호를 얹는다.

    반환: 합성된 JPEG 바이트. 합성할 게 없거나 폰트가 없으면 None (원본을 그대로 쓴다).
    """
    slogan = (slogan or "").strip()
    if layout == "none" or not slogan or not korean_font_available():
        return None
    try:
        from PIL import Image, ImageDraw

        im = Image.open(BytesIO(image_bytes)).convert("RGB")
        W, H = im.size
        pad = int(W * 0.065)
        max_w = W - pad * 2

        # --- 배경 막
        if layout == "center":
            veil = Image.new("RGB", (W, H), (0, 0, 0))
            im = Image.blend(im, veil, 0.34)
        else:
            anchor = "top" if layout == "top" else "bottom"
            shade = Image.new("RGB", (W, H), (0, 0, 0))
            im = Image.composite(shade, im, _scrim((W, H), anchor, 0.52, 215))

        overlay = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        draw = ImageDraw.Draw(overlay)

        # --- 폰트 (이미지 높이 기준 상대 크기 → 어떤 화면비에서도 균형이 맞는다)
        base = min(W, int(H * 0.9))
        slogan_font, slogan_lines = _fit_text(
            draw, slogan, max_w, int(base * 0.135), True,
            floor_1line=int(base * 0.082), floor_2line=int(base * 0.052))
        sub_font = _load_font(False, max(14, int(base * 0.042)))
        store_font = _load_font(True, max(12, int(base * 0.031)))

        sub_lines = _wrap_lines(draw, sub.strip(), sub_font, max_w, 2)[0] if sub.strip() else []
        gap = int(base * 0.028)

        slogan_h = int(slogan_font.size * 1.18) * len(slogan_lines)
        sub_h = int(sub_font.size * 1.45) * len(sub_lines)
        store_h = int(store_font.size * 1.5) if store else 0
        bar_h = max(3, int(base * 0.009))
        bar_w = int(base * 0.11)
        block_h = bar_h + gap + slogan_h + (gap // 2 + sub_h if sub_lines else 0) + \
            (gap + store_h if store else 0)

        centered = layout == "center"
        if layout == "top":
            y = pad
        elif centered:
            y = (H - block_h) // 2
        else:
            y = H - pad - block_h

        x = W // 2 if centered else pad
        text_anchor = "ma" if centered else "la"

        # 액센트 바 — 브랜드 색 한 줄이 들어가면 '광고물' 느낌이 확 산다
        bar_x0 = (W - bar_w) // 2 if centered else pad
        draw.rounded_rectangle([bar_x0, y, bar_x0 + bar_w, y + bar_h],
                               radius=bar_h // 2, fill=(*_ACCENT, 255))
        y += bar_h + gap

        for line in slogan_lines:
            _draw_text(draw, (x, y), line, slogan_font, (255, 255, 255, 255), anchor=text_anchor)
            y += int(slogan_font.size * 1.18)

        if sub_lines:
            y += gap // 2
            for line in sub_lines:
                _draw_text(draw, (x, y), line, sub_font, (255, 255, 255, 226), anchor=text_anchor)
                y += int(sub_font.size * 1.45)

        if store:
            y += gap
            # 상호는 자간을 벌려 캡션처럼 — 광고물에서 브랜드 서명 역할
            spaced = " ".join(store[:24])
            _draw_text(draw, (x, y), spaced, store_font, (*_ACCENT, 240), anchor=text_anchor)

        im = Image.alpha_composite(im.convert("RGBA"), overlay).convert("RGB")
        buf = BytesIO()
        im.save(buf, format="JPEG", quality=_JPEG_QUALITY, subsampling=0, optimize=True)
        return buf.getvalue()
    except MarketingError:
        return None
    except Exception:
        logger.warning("슬로건 합성 실패 — 글자 없는 원본으로 대체", exc_info=True)
        return None


def _auto_layout(aspect_ratio: str) -> str:
    """화면비에 어울리는 기본 슬로건 위치 — 세로가 길수록 아래쪽 여백이 넉넉하다."""
    return "center" if aspect_ratio in ("1:1", "16:9", "21:9") else "bottom"


@lru_cache(maxsize=1)
def _gcs_bucket():
    """GCS 버킷 핸들 (미설정·라이브러리 없음·권한 없음이면 None → 로컬 디스크로 동작)."""
    if not GCS_BUCKET:
        return None
    try:
        from google.cloud import storage

        return storage.Client().bucket(GCS_BUCKET)
    except Exception as e:
        logger.warning("GCS 버킷(%s) 연결 실패 — 로컬 디스크로 저장합니다: %s", GCS_BUCKET, e)
        return None


def image_url(filename: str) -> str:
    """표시용 URL. GCS를 쓰면 공개 URL을 직접 준다 — 앱이 Cloud Run을 거치지 않고
    버킷에서 바로 받아 서버 부하도, 아시아 리전 전송 비용도 들지 않는다.
    (프론트 promoImageUrl()이 http로 시작하면 그대로 쓰고, 아니면 API 주소를 붙인다)"""
    if _gcs_bucket() is not None:
        return f"https://storage.googleapis.com/{GCS_BUCKET}/{GCS_PREFIX}/{filename}"
    return f"{IMAGE_URL_PREFIX}/{filename}"


def _save_image(image_bytes: bytes, mime: str) -> tuple[str, str]:
    """이미지를 저장하고 (image_id, filename)을 돌려준다.

    GCS 버킷이 설정돼 있으면 버킷에, 아니면 uploads/marketing에 쓴다. 버킷 업로드가
    실패해도 로컬에 남겨 이번 요청은 살린다 (이후 서빙 엔드포인트가 로컬을 먼저 본다).
    """
    ext = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp"}.get(mime, ".png")
    image_id = uuid.uuid4().hex[:12]
    filename = f"{image_id}{ext}"

    bucket = _gcs_bucket()
    if bucket is not None:
        try:
            blob = bucket.blob(f"{GCS_PREFIX}/{filename}")
            blob.cache_control = "public, max-age=86400"
            blob.upload_from_string(image_bytes, content_type=mime)
            return image_id, filename
        except Exception as e:
            logger.warning("GCS 업로드 실패 → 로컬 디스크로 폴백: %s", e)

    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    (UPLOAD_DIR / filename).write_bytes(image_bytes)
    return image_id, filename


def _read_image(filename: str) -> bytes:
    """저장된 이미지를 다시 읽는다 (슬로건 위치 변경 시 원본 재사용). 로컬 → GCS 순."""
    path = image_file(filename)  # 파일명 검증 겸용 — 잘못된 이름은 여기서 걸린다
    if path.is_file():
        return path.read_bytes()

    bucket = _gcs_bucket()
    if bucket is not None:
        try:
            return bucket.blob(f"{GCS_PREFIX}/{filename}").download_as_bytes()
        except Exception as e:
            raise MarketingError(f"저장된 이미지를 찾을 수 없습니다: {e}")
    raise MarketingError("저장된 이미지를 찾을 수 없습니다")


def _delete_image(filename: str) -> None:
    """저장본 삭제 (실패는 무시 — 지우기 실패로 기능이 멈추면 안 된다)."""
    try:
        (UPLOAD_DIR / filename).unlink(missing_ok=True)
    except OSError:
        pass
    bucket = _gcs_bucket()
    if bucket is not None:
        try:
            bucket.blob(f"{GCS_PREFIX}/{filename}").delete()
        except Exception:
            logger.debug("GCS 이미지 삭제 실패(무해): %s", filename, exc_info=True)


def generate_promotion_image(store_id: str, doc_id: str = "", request: str = "",
                             style: str = "", aspect_ratio: str = "1:1",
                             include_text: bool = True, overlay: str = "auto",
                             quality: str = "high") -> dict[str, Any]:
    """홍보 이미지를 생성해 저장하고 표시용 URL을 돌려준다.

    파이프라인: 프롬프트 정교화 → 생성(pollinations→gemini 폴백) → 마감 보정 →
    한글 슬로건 합성. 이미지 모델에는 항상 '글자 없는' 프롬프트만 보내고 한글은
    우리가 직접 얹는다 — 어떤 모델이든 한글을 제대로 못 그리기 때문이다.

    doc_id: generate_promotion_copy로 만든 문서 id — 그 문서의 image_prompt를 쓰고,
            생성 결과가 문서 content.images에 기록된다 (챗봇 카드에 함께 표시).
    request: doc_id가 없거나 프롬프트를 직접 바꾸고 싶을 때의 이미지 설명 (한국어 가능).
    style: 추가 스타일 지시 (예: "수채화 일러스트", "필름 감성").
    include_text: False면 슬로건을 얹지 않는다 (overlay="none"과 같다, 구버전 호환).
    overlay: auto(화면비에 맞춰 자동) | none | bottom | center | top
    quality: high(기본, 고해상도) | standard

    반환: {image_id, filename, url, raw_url, overlay, slogan, mime_type, aspect_ratio,
           provider, prompt, doc(있으면 갱신된 문서 전문)}
    """
    from app.services.ai import document_service

    doc: Optional[dict[str, Any]] = None
    if doc_id:
        try:
            doc = document_service.get_document(store_id, doc_id)
        except document_service.DocumentError as e:
            raise MarketingError(str(e))
        if doc["kind"] != DOC_KIND:
            raise MarketingError(f"문서 {doc_id}는 홍보 콘텐츠가 아닙니다 (kind={doc['kind']})")

    if aspect_ratio not in _ASPECT_RATIOS:
        aspect_ratio = "1:1"
    quality = quality if quality in ("high", "standard") else "high"

    content = doc["content"] if doc else {}
    slogan = (content.get("short_slogan") or "").strip()
    layout = overlay if overlay in OVERLAY_LAYOUTS else "auto"
    if not include_text:
        layout = "none"
    if layout == "auto":
        layout = _auto_layout(aspect_ratio) if slogan else "none"
    if not slogan or not korean_font_available():
        layout = "none"

    # 프롬프트 조립: 직접 요청 > 문서의 image_prompt > 매장 정보 기반 기본 프롬프트
    base = (request or "").strip()
    if not base and doc:
        base = (content.get("image_prompt") or "").strip()
    if not base:
        # 아무 지시가 없을 때만 기본으로 '실사 사진' 스타일을 깐다 — 그 외에는
        # 스타일을 강제하지 않아야 프롬프트에 따라 느낌이 완전히 달라진다.
        # (예전엔 아래에서 'marketing photography'를 항상 덧붙여, 수채화를 시켜도
        #  사진풍으로 회귀하고 결과가 죄다 '나무 테이블 위 커피잔'처럼 비슷해졌다)
        ctx = _store_context(store_id)
        name = ctx["store_name"] or "a cozy local cafe"
        menus = ", ".join(ctx["best_menus"]) or "signature coffee"
        base = (f"A warm, inviting professional promotional photo for the cafe '{name}', "
                f"featuring {menus}, soft natural lighting, shallow depth of field")

    # ① 무료 텍스트 모델로 구도·조명·렌즈까지 지정된 프롬프트로 확장 (벽시계 상한 안에서)
    base = _refine_with_budget(base, style, aspect_ratio, layout)

    parts = [
        "Create a single eye-catching, professional-grade cafe advertising image.",
        base,
    ]
    if style.strip():
        # 사용자가 고른 스타일이 최우선 — image_prompt에 다른 스타일이 있어도 이걸 따른다
        parts.append(f"Art direction: {style.strip()}. Follow this style strictly, "
                     "it overrides any other style mentioned above.")
    parts.append(
        "Award-winning commercial quality, immaculate composition, rich micro-detail and "
        "texture, professional color grading, clean edges, no watermark, no logo, no brand marks.")
    # 모델이 가짜 글자(외계 문자)를 그려 넣는 버릇이 있어(실측) 금지를 강하게 반복한다.
    # 한글은 어차피 우리가 얹는다.
    #
    # [실측 2026-08-05] "no text"만으로는 부족하다 — 글자를 직접 안 써도 '글자가 있을
    # 법한 물건'(간판·메뉴판·칠판·액자·포스터·자격증)을 그려 넣고 거기에 깨진 활자를
    # 채운다. 그래서 글자 자체가 아니라 **그 물건들을 금지**하고, 벽·창을 비우라고
    # 지시해야 눈에 띄게 줄어든다(카페 실내 컷에서 큰 간판 → 작은 액자 수준으로).
    # 완전 제거는 모델 한계라 불가능하다 — 유료 이미지 모델에서만 깨끗하다.
    parts.append(
        "IMPORTANT: absolutely no text, no letters, no words, no numbers, no typography, "
        "no captions anywhere in the image. Also avoid any object that would carry writing: "
        "no signage, no menu boards, no chalkboards, no posters, no framed pictures, "
        "no certificates, no labeled packaging, no printed paper. "
        "Keep walls plain and empty, keep windows bare. Pure visual imagery only.")
    if layout != "none":
        hint = {"bottom": "the lower third", "top": "the upper third",
                "center": "the central area"}[layout]
        # '비워라(empty/negative space)'라고 하면 zimage가 검은 단색 띠를 그린다(실측) —
        # '장면의 자연스러운 연장으로 잔잔하게'라고 시켜야 한다.
        parts.append(
            f"Keep {hint} of the frame visually calm: no main subject there, but fill it "
            "with a natural continuation of the scene (soft out-of-focus surface, gentle "
            "shadow, bokeh) — never a solid dark band, black bar, or artificial empty block.")
    final_prompt = "\n".join(parts)

    # ② 생성 — 공급자 체인 (pollinations 주모델→대체모델 → gemini), 하나라도 되면 성공
    image_bytes, mime, provider, meta = _generate_image_bytes(final_prompt, aspect_ratio, quality)

    # ③ 마감 보정 후 '글자 없는 원본'으로 저장 — 슬로건 위치를 바꿀 때 재사용한다
    image_bytes, mime = _polish(image_bytes, mime)
    raw_id, raw_filename = _save_image(image_bytes, mime)

    # ④ 한글 슬로건 합성 (가능할 때만 별도 파일로)
    composed = _compose_overlay(image_bytes, slogan=slogan,
                                sub=(content.get("sub_headline") or ""),
                                store=(content.get("store_name") or ""), layout=layout)
    if composed:
        image_id, filename = _save_image(composed, "image/jpeg")
        mime = "image/jpeg"
    else:
        layout = "none"
        image_id, filename = raw_id, raw_filename

    entry = {
        "image_id": image_id,
        "filename": filename,
        "url": image_url(filename),
        "raw_filename": raw_filename,
        "raw_url": image_url(raw_filename),  # 글자 없는 버전
        "overlay": layout,          # none이면 url == raw_url
        "slogan": slogan if layout != "none" else "",
        "mime_type": mime,
        "aspect_ratio": aspect_ratio,
        "style": style,
        "quality": quality,
        "provider": provider,  # pollinations(주 공급자) | gemini(유료 키가 있을 때만)
        "model": meta.get("model", ""),   # 실제 그린 모델 — 폴백이 발동했는지 추적
        "seed": meta.get("seed"),         # 같은 그림 재현용 (Pollinations만)
        "prompt": final_prompt[:2000],  # 재현·디버깅용
    }

    if doc:
        images = list(content.get("images") or [])
        images.append(entry)
        content["images"] = images
        doc = document_service.update_document(store_id, doc_id, content)
    else:
        # 문구 문서 없이 만든 이미지(문구 생성이 쿼터로 실패했을 때 등)도 문서에 담아 저장한다.
        # 예전엔 그냥 entry만 돌려줘서 이미지가 어느 문서에도 기록되지 않았다 — 보관함에
        # 안 뜨고, 화면을 새로 그리거나 '문구 다시 쓰기'를 누르면 영구 소실됐다.
        # 게다가 화면이 임시로 만든 빈 id를 그대로 다시 보내면 '이미지 다시 그리기'가
        # 여기 else로 들어와 응답의 doc이 계속 비어, 눌러도 아무 일이 없어 보였다.
        content = {
            "channel": "", "channel_label": "", "topic": (request or "").strip()[:200],
            "tone": "", "focus_menu": "", "store_name": "",
            "headline": "", "sub_headline": "", "body": "", "sns_caption": "",
            "hashtags": [], "short_slogan": "", "image_prompt": base, "posting_tip": "",
            "images": [entry],
        }
        doc = document_service._save_document(
            store_id, DOC_KIND, f"홍보 이미지 — {content['topic'] or '직접 생성'}"[:200], content)

    return {**entry, "doc": doc}


def recompose_promotion_image(store_id: str, doc_id: str, image_id: str = "",
                              layout: str = "bottom") -> dict[str, Any]:
    """이미 만든 홍보 이미지의 슬로건 위치만 바꾼다 — AI 재호출 없이 즉시 처리.

    글자 없는 원본(raw)을 다시 합성하므로 여러 번 바꿔도 화질이 나빠지지 않는다.
    image_id를 비우면 문서의 마지막 이미지를 대상으로 한다.
    """
    from app.services.ai import document_service

    try:
        doc = document_service.get_document(store_id, doc_id)
    except document_service.DocumentError as e:
        raise MarketingError(str(e))
    if doc["kind"] != DOC_KIND:
        raise MarketingError(f"문서 {doc_id}는 홍보 콘텐츠가 아닙니다 (kind={doc['kind']})")

    content = doc["content"]
    images = list(content.get("images") or [])
    if not images:
        raise MarketingError("이 홍보물에는 아직 이미지가 없습니다")
    idx = next((i for i, e in enumerate(images) if e.get("image_id") == image_id),
               len(images) - 1) if image_id else len(images) - 1
    entry = dict(images[idx])

    if layout not in OVERLAY_LAYOUTS:
        layout = "bottom"
    if layout == "auto":
        layout = _auto_layout(entry.get("aspect_ratio") or "1:1")

    raw_name = entry.get("raw_filename") or entry.get("filename") or ""
    try:
        raw_bytes = _read_image(raw_name)
    except MarketingError:
        raise MarketingError(
            "원본 이미지를 찾을 수 없어 위치를 바꿀 수 없습니다. 이미지를 다시 만들어 주세요.")

    slogan = (content.get("short_slogan") or "").strip()
    if layout == "none" or not slogan:
        composed, new_layout = None, "none"
    else:
        composed = _compose_overlay(raw_bytes, slogan=slogan,
                                    sub=(content.get("sub_headline") or ""),
                                    store=(content.get("store_name") or ""), layout=layout)
        new_layout = layout if composed else "none"

    old_filename = entry.get("filename")
    if composed:
        _, filename = _save_image(composed, "image/jpeg")
        entry["mime_type"] = "image/jpeg"
    else:
        filename = raw_name
        entry["mime_type"] = "image/jpeg"
    entry["filename"] = filename
    entry["url"] = image_url(filename)
    entry["raw_filename"] = raw_name
    entry["raw_url"] = image_url(raw_name)
    entry["overlay"] = new_layout
    entry["slogan"] = slogan if new_layout != "none" else ""

    # 이전 합성본은 지운다 (원본은 남긴다) — 레이아웃을 여러 번 바꿔도 저장소가 안 샌다
    if old_filename and old_filename not in (filename, raw_name):
        _delete_image(old_filename)

    images[idx] = entry
    content["images"] = images
    doc = document_service.update_document(store_id, doc_id, content)
    return {**entry, "doc": doc}


def image_file(filename: str) -> Path:
    """파일명 검증 후 로컬 경로를 돌려준다 (존재 여부는 호출자가 판단한다).

    파일명은 우리가 만든 '12자리 hex + 확장자'만 통과시킨다 — 경로 조작(../) 차단이
    목적이라 정규식 밖 이름은 존재 여부와 무관하게 거절한다.
    존재 확인을 여기서 하지 않는 이유: GCS를 쓰면 로컬에 파일이 없는 게 정상이고,
    그때는 버킷을 봐야 한다 (_read_image / 서빙 엔드포인트가 이어서 처리).
    """
    if not re.fullmatch(r"[0-9a-f]{12}\.(png|jpg|webp)", filename):
        raise MarketingError("잘못된 이미지 파일명입니다")
    return UPLOAD_DIR / filename
