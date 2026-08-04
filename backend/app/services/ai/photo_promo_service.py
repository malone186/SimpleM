"""실물 사진 기반 홍보 이미지 (백엔드 B) — 누끼 + 배경 합성.

AI 생성 이미지는 우리 매장 실물과 다를 수 있다. 그래서 사장님이 올린 메뉴 사진에서
피사체만 오려내(rembg·U2-Net 경량모델, 서버 CPU에서 동작 — 외부 유출 없음)
감성 배경 위에 자연스럽게 합성한다:

  ① 누끼: rembg(u2netp) — 첫 호출 때 모델(~5MB)을 내려받아 세션을 재사용
  ② 배경: Pollinations(무료)로 '빈' 카페 배경 생성 → 실패 시 크림 그라데이션 폴백
  ③ 합성: Pillow — 피사체를 중앙 하단에 배치하고 부드러운 그림자를 깔아
          '스티커 붙인 느낌'을 줄인다
  ④ 저장·문서 연결은 기존 marketing_service 경로를 그대로 재사용

키가 전혀 없어도(무료 환경) 전 과정이 동작한다.
"""
from __future__ import annotations

import io
import logging
from typing import Any, Optional

logger = logging.getLogger(__name__)

# 배경 스타일 — 라벨은 앱 칩에, 프롬프트는 Pollinations에. '빈' 장면을 강제해
# 합성할 자리를 비워 둔다 (글자·기존 음식이 그려지면 합성이 지저분해진다).
BACKGROUND_STYLES: dict[str, dict[str, str]] = {
    "wood": {
        "label": "우드 테이블",
        "prompt": "empty warm wooden cafe table surface, soft natural window light, "
                  "blurred cozy cafe interior background, empty space in center for product",
    },
    "marble": {
        "label": "대리석",
        "prompt": "empty white marble countertop, bright airy minimal studio light, "
                  "soft shadows, empty center space for product placement",
    },
    "cozy": {
        "label": "코지 감성",
        "prompt": "empty rustic table with soft beige linen cloth, warm afternoon sunlight, "
                  "dried flowers blurred in background, empty space in the middle",
    },
    "studio": {
        "label": "스튜디오",
        "prompt": "clean minimal studio product backdrop, soft gradient cream background, "
                  "professional product photography lighting, empty pedestal space",
    },
    "season": {
        "label": "시즌 감성",
        "prompt": "empty cafe table decorated subtly for the current season in Korea, "
                  "soft bokeh lights, warm inviting mood, clear empty space in center",
    },
}
_NO_TEXT = (" IMPORTANT: absolutely no text, no letters, no logos, no food, no drinks, "
            "no cups in the scene. Pure empty background only.")

_session = None  # rembg 세션 — 프로세스당 1회 로드해 재사용

# 배경 캐시 — (스타일, 비율)별로 6시간 재사용. 배경 생성(Pollinations)이 수십 초로
# 가장 느린 구간이라, 실측 프로덕션 첫 합성이 78초까지 갔고 모바일 연결이 그 사이
# 끊겨 '인터넷 연결 확인' 오류로 보였다. 같은 배경을 재사용하면 합성은 2~3초로 준다.
_BG_TTL = 6 * 3600
_bg_cache: dict[tuple[str, str], tuple[float, bytes]] = {}


class PhotoPromoError(RuntimeError):
    """사진 합성 실패 (누끼 불가·이미지 손상 등)."""


def _cutout(photo_bytes: bytes):
    """사진에서 피사체만 오려낸 RGBA 이미지를 돌려준다."""
    global _session
    try:
        from rembg import new_session, remove
    except Exception:
        raise PhotoPromoError("서버에 배경 제거 모듈(rembg)이 없습니다. 관리자에게 문의해 주세요.")
    from PIL import Image

    if _session is None:
        # u2netp: 경량(≈5MB) 모델 — Cloud Run 1Gi 메모리에서도 안전
        _session = new_session("u2netp")
    try:
        src = Image.open(io.BytesIO(photo_bytes)).convert("RGBA")
    except Exception:
        raise PhotoPromoError("사진 파일을 읽지 못했습니다. JPG/PNG 사진인지 확인해 주세요.")
    # 아주 큰 원본은 누끼 전에 줄인다 — 품질 손해 없이 속도·메모리 확보
    src.thumbnail((1600, 1600))
    cut = remove(src, session=_session)

    bbox = cut.getbbox()
    if bbox is None:
        raise PhotoPromoError("사진에서 메뉴(피사체)를 찾지 못했습니다. 다른 사진으로 시도해 주세요.")
    cut = cut.crop(bbox)
    # 피사체가 사진의 티끌 수준이면 누끼 실패로 간주
    if cut.width < 40 or cut.height < 40:
        raise PhotoPromoError("피사체가 너무 작게 인식됐어요. 메뉴가 크게 나온 사진으로 시도해 주세요.")
    return cut


def _background(style: str, aspect_ratio: str):
    """배경 이미지(RGB). Pollinations 실패 시 크림 그라데이션 폴백 — 항상 성공한다."""
    from PIL import Image

    from app.services.ai import marketing_service as M

    w, h = M._AR_SIZES.get(aspect_ratio, (1472, 1472))
    meta = BACKGROUND_STYLES.get(style) or BACKGROUND_STYLES["wood"]

    import time as _time
    key = (style, aspect_ratio)
    hit = _bg_cache.get(key)
    if hit and _time.time() - hit[0] < _BG_TTL:
        bg = Image.open(io.BytesIO(hit[1])).convert("RGB").resize((w, h))
        return bg, "pollinations(cached)"
    try:
        bg_bytes, _mime = M._pollinations_generate(meta["prompt"] + _NO_TEXT, aspect_ratio)
        _bg_cache[key] = (_time.time(), bg_bytes)
        bg = Image.open(io.BytesIO(bg_bytes)).convert("RGB").resize((w, h))
        return bg, "pollinations"
    except Exception as e:
        logger.info("배경 생성 실패 → 그라데이션 폴백: %s", e)
        bg = Image.new("RGB", (w, h))
        top, bottom = (250, 246, 240), (233, 223, 208)  # 크림 → 라떼 베이지
        for y in range(h):
            t = y / max(1, h - 1)
            bg.paste(tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(3)),
                     (0, y, w, y + 1))
        return bg, "gradient"


def _composite(cut, bg):
    """피사체를 배경 중앙 하단에 그림자와 함께 얹는다."""
    from PIL import Image, ImageFilter

    W, H = bg.size
    # 피사체 크기: 캔버스 높이의 68% — '내 메뉴'가 주인공으로 보이게 크게.
    # (62%로는 배경이 화면을 지배해 'AI가 다 그린 그림'처럼 오해될 수 있었다)
    target_h = int(H * 0.68)
    scale = target_h / cut.height
    cut = cut.resize((max(1, int(cut.width * scale)), target_h), Image.LANCZOS)
    if cut.width > int(W * 0.86):  # 아주 넓은 피사체(접시 등)는 폭 기준으로 재조정
        scale = (W * 0.86) / cut.width
        cut = cut.resize((int(cut.width * scale), max(1, int(cut.height * scale))), Image.LANCZOS)

    x = (W - cut.width) // 2
    y = H - cut.height - int(H * 0.10)  # 바닥에서 10% 띄움

    canvas = bg.convert("RGBA")
    # 그림자: 피사체 실루엣을 눌러(높이 22%) 발밑에 깔고 크게 블러 — 조명 정합감
    alpha = cut.split()[-1]
    sh_h = max(8, int(cut.height * 0.22))
    shadow_mask = alpha.resize((cut.width, sh_h)).filter(ImageFilter.GaussianBlur(18))
    shadow = Image.new("RGBA", (cut.width, sh_h), (0, 0, 0, 0))
    shadow.putalpha(shadow_mask.point(lambda a: int(a * 0.38)))
    canvas.alpha_composite(shadow, (x, y + cut.height - sh_h // 2))
    canvas.alpha_composite(cut, (x, y))
    return canvas.convert("RGB")


def compose_from_photo(store_id: str, photo_bytes: bytes, style: str = "wood",
                       aspect_ratio: str = "1:1", doc_id: str = "") -> dict[str, Any]:
    """실물 사진 → 누끼 → 배경 합성 → 저장. 반환은 기존 이미지 엔트리와 같은 형태.

    doc_id를 주면 그 홍보 문서의 images에 붙어 챗봇 카드·보관함에 함께 보인다.
    """
    from app.services.ai import document_service
    from app.services.ai import marketing_service as M

    if aspect_ratio not in M._ASPECT_RATIOS:
        aspect_ratio = "1:1"

    doc: Optional[dict[str, Any]] = None
    if doc_id:
        try:
            doc = document_service.get_document(store_id, doc_id)
        except document_service.DocumentError as e:
            raise PhotoPromoError(str(e))
        if doc["kind"] != M.DOC_KIND:
            raise PhotoPromoError(f"문서 {doc_id}는 홍보 콘텐츠가 아닙니다")

    cut = _cutout(photo_bytes)
    bg, bg_provider = _background(style, aspect_ratio)
    final = _composite(cut, bg)

    buf = io.BytesIO()
    final.save(buf, format="PNG")
    image_id, filename = M._save_image(buf.getvalue(), "image/png")

    entry = {
        "image_id": image_id,
        "filename": filename,
        "url": f"{M.IMAGE_URL_PREFIX}/{filename}",
        "raw_filename": filename,
        "raw_url": f"{M.IMAGE_URL_PREFIX}/{filename}",
        "overlay": "none",
        "slogan": "",
        "mime_type": "image/png",
        "aspect_ratio": aspect_ratio,
        "style": f"photo:{style}",
        "quality": "high",
        "provider": f"photo_composite({bg_provider})",  # 실물 사진 누끼 + 배경 합성
        "prompt": "",
    }

    if doc:
        images = list(doc["content"].get("images") or [])
        images.append(entry)
        doc["content"]["images"] = images
        doc = document_service.update_document(store_id, doc_id, doc["content"])

    return {**entry, "doc": doc}
