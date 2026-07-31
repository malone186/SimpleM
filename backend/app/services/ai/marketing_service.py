"""홍보/마케팅 도우미 (백엔드 B) — AI 홍보 문구 + AI 홍보 이미지 생성

등록한 카페를 홍보하는 콘텐츠를 만든다:

  1) 홍보 문구 생성  → generate_promotion_copy()
     매장 사실(상호·업태·위치·베스트 메뉴)을 근거로 눈길을 끄는 헤드라인·SNS 캡션·
     해시태그·이미지 프롬프트를 한 번에 만든다. 결과는 generated_documents에
     kind="marketing_content"로 저장돼 챗봇 카드·문서 목록에서 다시 볼 수 있다.

  2) 홍보 이미지 생성 → generate_promotion_image()
     Gemini 이미지 생성 모델로 홍보물 이미지를 만들어 uploads/marketing/에 저장하고,
     앱이 바로 <Image>로 띄울 수 있는 URL을 돌려준다. 문구 문서(doc_id)를 주면
     그 문서의 image_prompt를 쓰고, 생성된 이미지가 문서에 함께 기록된다.

과장·허위 금지: 프롬프트가 '매장 정보에 있는 사실 + 사장님 요청'만 재료로 쓰도록 강제한다.
없는 메뉴·지어낸 수상 경력·근거 없는 '전국 1위' 류 문구는 만들지 않는다.

필요 키 (backend/.env):
  GEMINI_API_KEY — 문구·이미지 모두 여기 하나로 (팀 공유 키, 쿼터 주의)
  이미지 경로: Gemini 이미지 모델은 무료 티어 한도가 0이라(실측 2026-07-31, 전 계열
  limit: 0) 유료 키가 없으면 실패한다 → 그 경우 Pollinations.ai(키 불필요, 무료,
  FLUX 기반)로 자동 폴백해 이미지 생성은 항상 동작한다. 단 FLUX는 한글이 깨져
  폴백 이미지에는 글자를 넣지 않는다 — 한글 슬로건 오버레이는 유료 Gemini 키를
  넣으면 자동으로 살아난다 (MARKETING_IMAGE_MODEL로 모델 교체 가능).
모델 교체 (env):
  MARKETING_GEMINI_MODEL — 문구 생성 (기본: GEMINI_MODEL과 동일)
  MARKETING_IMAGE_MODEL  — 이미지 생성 (기본: gemini-2.5-flash-image)
"""

import base64
import json
import logging
import os
import re
import time
import uuid
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger(__name__)

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "") or os.getenv("GOOGLE_API_KEY", "")
COPY_MODEL = os.getenv("MARKETING_GEMINI_MODEL", "") or os.getenv("GEMINI_MODEL", "gemini-2.5-flash")
# 이미지 생성은 전용 모델만 가능하다 — 텍스트 모델에 responseModalities=IMAGE를 줘도 400이 난다
IMAGE_MODEL = os.getenv("MARKETING_IMAGE_MODEL", "gemini-2.5-flash-image")

UPLOAD_DIR = Path(os.getenv("MARKETING_UPLOAD_DIR",
                            Path(__file__).resolve().parents[3] / "uploads" / "marketing"))
# 챗봇 라우터(/api/v1/chatbot)의 이미지 서빙 엔드포인트와 짝 — 여기 바꾸면 chatbot.py도 같이
IMAGE_URL_PREFIX = "/api/v1/chatbot/marketing/images"

COPY_TIMEOUT = float(os.getenv("MARKETING_COPY_TIMEOUT", "30"))
IMAGE_TIMEOUT = float(os.getenv("MARKETING_IMAGE_TIMEOUT", "60"))

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


def _thinking_config(model: str) -> Optional[dict[str, Any]]:
    """모델 세대별 thinking 설정 — 2.5 계열은 기본 thinking이 출력 예산을 잠식한다."""
    if model.startswith("gemini-2.5") and "image" not in model:
        return {"thinkingBudget": 0}
    if model.startswith("gemini-3"):
        return {"thinkingLevel": "low"}
    return None


def _gemini_call(model: str, payload: dict[str, Any], timeout: float) -> dict[str, Any]:
    """Gemini generateContent 공통 호출 — 5xx는 재시도, 429는 쿼터 안내로 즉시 실패.

    쿼터(429)는 팀 공유 무료 키라 재시도로 안 풀리는 경우가 대부분이다 — 짧게 한 번만
    더 시도하고, 사장님이 이해할 수 있는 문구로 실패를 알린다.
    """
    key = GEMINI_API_KEY or os.getenv("GEMINI_API_KEY", "") or os.getenv("GOOGLE_API_KEY", "")
    if not key:
        raise MarketingError("GEMINI_API_KEY가 설정되어 있지 않아 홍보 콘텐츠를 만들 수 없습니다")

    import httpx

    last_error: Exception | None = None
    for attempt in (1, 2, 3):
        try:
            resp = httpx.post(
                f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
                json=payload,
                headers={"x-goog-api-key": key},
                timeout=timeout,
            )
            if resp.status_code == 429:
                # "limit: 0" = 이 키의 요금제에 해당 모델 무료 한도가 아예 없다는 뜻 —
                # 기다려도 안 풀리므로 재시도하지 않고 원인을 그대로 알린다.
                # (실측 2026-07-31: 이미지 생성 모델 전 계열이 무료 티어 limit 0.
                #  텍스트 모델은 무료 한도가 있어 문구 생성은 정상 동작한다.)
                if "limit: 0" in resp.text:
                    raise MarketingError(
                        "지금 서버의 AI 키 요금제에서는 이미지 생성이 지원되지 않습니다. "
                        "홍보 문구는 정상 이용 가능하며, 이미지는 유료 API 키 등록 후 열립니다.")
                if attempt == 1:
                    time.sleep(2)
                    continue
                raise MarketingError(
                    "오늘 사용할 수 있는 AI 사용량이 잠시 부족합니다. 조금 뒤에 다시 시도해 주세요.")
            if resp.status_code >= 500:
                last_error = MarketingError(f"Gemini HTTP {resp.status_code}: {resp.text[:200]}")
                if attempt < 3:
                    time.sleep(2 * attempt)
                continue
            resp.raise_for_status()
            return resp.json()
        except MarketingError:
            raise
        except httpx.HTTPError as e:
            last_error = e
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
  카페 분위기·메뉴·조명·구도를 구체적으로, 실사 사진 스타일로 묘사할 것.
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

def _extract_image(raw: dict[str, Any]) -> tuple[bytes, str]:
    """generateContent 응답에서 이미지 바이트와 mime을 꺼낸다 (camel/snake 모두 방어)."""
    for cand in raw.get("candidates", []):
        for part in (cand.get("content") or {}).get("parts", []):
            inline = part.get("inlineData") or part.get("inline_data")
            if inline and inline.get("data"):
                mime = inline.get("mimeType") or inline.get("mime_type") or "image/png"
                return base64.b64decode(inline["data"]), mime
    # 안전 필터 등으로 이미지 없이 텍스트만 돌아온 경우 — 이유를 그대로 전달
    for cand in raw.get("candidates", []):
        for part in (cand.get("content") or {}).get("parts", []):
            if part.get("text"):
                raise MarketingError(f"이미지가 생성되지 않았습니다: {part['text'][:200]}")
    raise MarketingError("이미지 생성 응답이 비어 있습니다. 잠시 후 다시 시도해 주세요.")


# Pollinations 무료 생성용 화면비 → 픽셀 크기.
# 홍보물은 품질이 곧 설득력이라 고해상도(1400px대)로 뽑는다 — 실측 1472² 약 10초로
# 체감 손해가 크지 않다. FLUX는 64 배수 해상도가 안전해 전부 64의 배수로 맞췄다.
_AR_SIZES: dict[str, tuple[int, int]] = {
    "1:1": (1472, 1472), "4:5": (1152, 1440), "5:4": (1440, 1152),
    "3:4": (1056, 1408), "4:3": (1408, 1056), "2:3": (960, 1440), "3:2": (1440, 960),
    "9:16": (864, 1536), "16:9": (1536, 864), "21:9": (1792, 768),
}


def _pollinations_generate(prompt: str, aspect_ratio: str) -> tuple[bytes, str]:
    """무료 폴백 — Pollinations.ai (FLUX 기반, API 키 불필요).

    Gemini 이미지 모델은 무료 티어 한도가 0이라(실측 2026-07-31) 유료 키가 없으면
    항상 막힌다. Pollinations는 키 없이 GET 한 번으로 이미지를 주며 품질도 실측으로
    확인했다(카페 홍보 사진 수준 충분). 다만 FLUX는 한글 렌더링이 깨지므로
    글자 없는 이미지 프롬프트로만 부른다 — 슬로건은 앱 화면에서 이미지 위에 얹으면 된다.
    """
    import urllib.parse

    import httpx

    w, h = _AR_SIZES.get(aspect_ratio, (1024, 1024))
    # 프롬프트가 URL 경로에 실리므로 '/'까지 전부 인코딩해야 한다(safe='') —
    # 기본 quote는 '/'를 남겨 경로가 쪼개지며 404가 난다(실측). 줄바꿈도 공백으로.
    encoded = urllib.parse.quote(" ".join(prompt[:1500].split()), safe="")
    try:
        r = httpx.get(
            "https://image.pollinations.ai/prompt/" + encoded,
            # enhance=true: 서버 쪽 LLM이 프롬프트를 화보용으로 보강한다 — 실측으로
            # 구도·조명 묘사가 눈에 띄게 좋아져 기본 켠다
            # model=flux: 익명 티어 기본 모델(sana, 경량)보다 품질이 좋은 FLUX를 명시.
            # 실측 1024² 약 5초 — 홍보물은 품질이 우선이라 속도 손해를 감수한다.
            params={"width": w, "height": h, "nologo": "true", "enhance": "true",
                    "model": "flux"},
            timeout=IMAGE_TIMEOUT,
            follow_redirects=True,
        )
        r.raise_for_status()
    except httpx.HTTPError as e:
        raise MarketingError(f"무료 이미지 생성(Pollinations)도 실패했습니다: {e}")
    ctype = (r.headers.get("content-type") or "").split(";")[0].strip()
    if not ctype.startswith("image/") or not r.content:
        raise MarketingError("무료 이미지 생성 응답이 이미지가 아닙니다. 잠시 후 다시 시도해 주세요.")
    return r.content, ctype


def generate_promotion_image(store_id: str, doc_id: str = "", request: str = "",
                             style: str = "", aspect_ratio: str = "1:1",
                             include_text: bool = True) -> dict[str, Any]:
    """홍보 이미지를 생성해 저장하고 표시용 URL을 돌려준다.

    1순위 Gemini(유료 키가 있으면 한글 슬로건 오버레이까지 가능) →
    실패(무료 티어 한도 0·쿼터) 시 Pollinations 무료 생성으로 자동 폴백.
    doc_id: generate_promotion_copy로 만든 문서 id — 그 문서의 image_prompt를 쓰고,
            생성 결과가 문서 content.images에 기록된다 (챗봇 카드에 함께 표시).
    request: doc_id가 없거나 프롬프트를 직접 바꾸고 싶을 때의 이미지 설명 (한국어 가능).
    style: 추가 스타일 지시 (예: "수채화 일러스트", "필름 감성").
    include_text: 문서의 short_slogan을 이미지 위에 한글로 새길지 (Gemini 경로만 지원).

    반환: {image_id, filename, url, mime_type, aspect_ratio, provider,
           doc(있으면 갱신된 문서 전문)}
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

    # 프롬프트 조립: 직접 요청 > 문서의 image_prompt > 매장 정보 기반 기본 프롬프트
    base = (request or "").strip()
    if not base and doc:
        base = (doc["content"].get("image_prompt") or "").strip()
    if not base:
        ctx = _store_context(store_id)
        name = ctx["store_name"] or "a cozy local cafe"
        menus = ", ".join(ctx["best_menus"]) or "signature coffee"
        base = (f"A warm, inviting promotional photo for the cafe '{name}', "
                f"featuring {menus}, soft natural lighting, shallow depth of field")

    parts = [
        "Create a single eye-catching cafe promotional image.",
        base,
        "High quality, appetizing, professional food/beverage marketing photography. "
        "No watermark, no logo, no brand marks.",
    ]
    if style.strip():
        parts.append(f"Style: {style.strip()}")
    # 글자 없는 공통 프롬프트 — Pollinations(FLUX)는 한글이 깨져서 텍스트 지시를 못 넣는다
    textless_prompt = "\n".join(parts + ["No text, no letters, no captions in the image."])

    slogan = (doc["content"].get("short_slogan") or "").strip() if doc else ""
    if include_text and slogan:
        parts.append(
            f'Overlay the Korean text "{slogan}" as a short, elegant headline — '
            "large, clearly legible, well-integrated into the composition. "
            "Render the Korean characters exactly as given.")
    final_prompt = "\n".join(parts)

    if aspect_ratio not in _ASPECT_RATIOS:
        aspect_ratio = "1:1"

    provider = "gemini"
    try:
        raw = _gemini_call(IMAGE_MODEL, {
            "contents": [{"parts": [{"text": final_prompt}]}],
            "generationConfig": {
                "responseModalities": ["TEXT", "IMAGE"],
                "imageConfig": {"aspectRatio": aspect_ratio},
            },
        }, IMAGE_TIMEOUT)
        image_bytes, mime = _extract_image(raw)
    except MarketingError as e:
        # 무료 티어 한도 0·쿼터 소진 — 키 없이 되는 무료 생성으로 폴백해 기능을 살린다
        logger.info("Gemini 이미지 생성 실패 → Pollinations 무료 폴백: %s", e)
        provider = "pollinations"
        image_bytes, mime = _pollinations_generate(textless_prompt, aspect_ratio)

    ext = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp"}.get(mime, ".png")
    image_id = uuid.uuid4().hex[:12]
    filename = f"{image_id}{ext}"
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    (UPLOAD_DIR / filename).write_bytes(image_bytes)

    entry = {
        "image_id": image_id,
        "filename": filename,
        "url": f"{IMAGE_URL_PREFIX}/{filename}",
        "mime_type": mime,
        "aspect_ratio": aspect_ratio,
        "style": style,
        "provider": provider,  # gemini(한글 슬로건 가능) | pollinations(무료, 글자 없음)
    }

    if doc:
        images = list(doc["content"].get("images") or [])
        images.append(entry)
        doc["content"]["images"] = images
        doc = document_service.update_document(store_id, doc_id, doc["content"])

    return {**entry, "doc": doc}


def image_file(filename: str) -> Path:
    """서빙 엔드포인트용 — 파일명 검증 후 실제 경로를 돌려준다.

    파일명은 우리가 만든 '12자리 hex + 확장자'만 통과시킨다 — 경로 조작(../) 차단이
    목적이라 정규식 밖 이름은 존재 여부와 무관하게 거절한다.
    """
    if not re.fullmatch(r"[0-9a-f]{12}\.(png|jpg|webp)", filename):
        raise MarketingError("잘못된 이미지 파일명입니다")
    path = UPLOAD_DIR / filename
    if not path.is_file():
        raise MarketingError("이미지를 찾을 수 없습니다 (삭제됐거나 다른 서버에서 생성됨)")
    return path
