"""실물 사진 기반 홍보 이미지 (백엔드 B) — 누끼 + 배경 합성.

AI 생성 이미지는 우리 매장 실물과 다를 수 있다. 그래서 사장님이 올린 메뉴 사진에서
피사체만 오려내(rembg·U2-Net 경량모델, 서버 CPU에서 동작 — 외부 유출 없음)
감성 배경 위에 자연스럽게 합성한다:

  ① 누끼: rembg(u2netp) — 첫 호출 때 모델(~5MB)을 내려받아 세션을 재사용
  ② 배경: Gemini 이미지 모델(결제 켜진 프로젝트면) → Pollinations(무료, 12초 제한)
          → 둘 다 실패하면 번들 배경(static/promo_bg) → 최후엔 크림 그라데이션.
          매번 새로 생성해 '항상 똑같은 배경' 문제를 없애되, 실패해도 절대 안 죽는다.
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
    # 아주 큰 원본은 누끼 전에 줄인다 — 속도·메모리 확보.
    # (1600에서 1280으로 축소: 1Gi 인스턴스에서 onnx 추론 중 OOM으로 503이 나던
    #  실측 사례 대응. 홍보 컷 기준 화질 차이는 체감되지 않는다)
    src.thumbnail((1280, 1280))
    cut = remove(src, session=_session)

    bbox = cut.getbbox()
    if bbox is None:
        raise PhotoPromoError("사진에서 메뉴(피사체)를 찾지 못했습니다. 다른 사진으로 시도해 주세요.")
    cut = cut.crop(bbox)
    # 피사체가 사진의 티끌 수준이면 누끼 실패로 간주
    if cut.width < 40 or cut.height < 40:
        raise PhotoPromoError("피사체가 너무 작게 인식됐어요. 메뉴가 크게 나온 사진으로 시도해 주세요.")
    return cut


# Gemini 이미지 모델이 429(쿼터 0·소진)를 주면 이 시각까지 재시도하지 않는다 —
# 무료 티어는 이미지 모델 한도가 0이라 매 요청 헛손질하게 되는 걸 막는다.
_gemini_img_dead_until = 0.0

# Gemini 이미지 모델이 지원하는 화면비 — 이 안에 있으면 그대로 넘긴다
_GEMINI_ARS = {"1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"}


def _gemini_background(prompt: str, aspect_ratio: str) -> Optional[bytes]:
    """Gemini 이미지 모델로 배경 생성. 결제가 안 켜진 프로젝트(무료 티어)는 한도가
    0이라 즉시 429가 온다 → 10분간 시도 자체를 건너뛴다. 실패는 전부 None."""
    global _gemini_img_dead_until
    import os
    import time

    key = os.getenv("GEMINI_API_KEY", "") or os.getenv("GOOGLE_API_KEY", "")
    if not key or time.time() < _gemini_img_dead_until:
        return None
    try:
        import httpx

        body: dict[str, Any] = {
            "contents": [{"parts": [{"text": prompt}]}],
            "generationConfig": {"responseModalities": ["IMAGE"]},
        }
        if aspect_ratio in _GEMINI_ARS:
            body["generationConfig"]["imageConfig"] = {"aspectRatio": aspect_ratio}
        r = httpx.post(
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent",
            params={"key": key}, json=body, timeout=25,
        )
        if r.status_code == 429:
            _gemini_img_dead_until = time.time() + 600
            logger.info("[사진 합성] Gemini 이미지 쿼터 없음(429) → 10분간 건너뜀")
            return None
        r.raise_for_status()
        parts = r.json()["candidates"][0]["content"]["parts"]
        data = next((p["inlineData"]["data"] for p in parts if "inlineData" in p), None)
        if not data:
            return None
        import base64

        return base64.b64decode(data)
    except Exception as e:
        logger.info("[사진 합성] Gemini 배경 생성 실패 → 다음 단계로: %s", e)
        return None


def _pollinations_background(prompt: str, w: int, h: int) -> Optional[bytes]:
    """Pollinations(무료 FLUX)로 배경 생성. 12초 안에 못 주면 포기하고 None —
    실측상 5~99초로 널뛰는 서비스라, 느린 날엔 기다리지 말고 번들 배경으로 간다."""
    try:
        from urllib.parse import quote

        import httpx

        url = (f"https://image.pollinations.ai/prompt/{quote(prompt)}"
               f"?width={w}&height={h}&nologo=true&enhance=true")
        r = httpx.get(url, timeout=12, follow_redirects=True)
        if r.status_code == 200 and r.content[:3] in (b"\xff\xd8\xff", b"\x89PN"):
            return r.content
    except Exception as e:
        logger.info("[사진 합성] Pollinations 배경 실패/지연 → 번들 폴백: %s", e)
    return None


def _background(style: str, aspect_ratio: str):
    """배경 이미지(RGB) — AI 생성을 먼저 시도하고, 실패하면 내장 자산으로 폴백.

    시도 순서: ① Gemini 이미지 모델(프로젝트에 결제가 켜져 있을 때만 성공, ~10초)
              ② Pollinations 무료 생성(12초 제한) ③ 번들 배경(static/promo_bg, 즉시)
              ④ 크림 그라데이션. AI 배경은 매번 새로 생성돼 결과물이 늘 다르다 —
    '미리 만든 배경이라 다 똑같다'는 피드백 대응. 캐시를 일부러 안 쓰는 이유이기도
    하다(캐시하면 다양성이 도로 사라진다). 최악의 추가 지연은 25+12초, 그 뒤 폴백.
    """
    import io as _io
    import os

    from PIL import Image

    from app.services.ai import marketing_service as M

    w, h = M._AR_SIZES.get(aspect_ratio, (1472, 1472))

    prompt = (BACKGROUND_STYLES.get(style, BACKGROUND_STYLES["wood"])["prompt"] + _NO_TEXT)
    raw = _gemini_background(prompt, aspect_ratio)
    provider = "gemini" if raw else ""
    if not raw:
        raw = _pollinations_background(prompt, w, h)
        provider = "pollinations" if raw else ""
    if raw:
        try:
            bg = Image.open(_io.BytesIO(raw)).convert("RGB")
            scale = max(w / bg.width, h / bg.height)
            bg = bg.resize((round(bg.width * scale), round(bg.height * scale)), Image.LANCZOS)
            left, top = (bg.width - w) // 2, (bg.height - h) // 2
            return bg.crop((left, top, left + w, top + h)), provider
        except Exception as e:
            logger.warning("[사진 합성] AI 배경 디코드 실패 → 번들 폴백: %s", e)
    asset = os.path.join(os.path.dirname(__file__), "..", "..", "static", "promo_bg",
                         f"{style if style in BACKGROUND_STYLES else 'wood'}.jpg")
    try:
        bg = Image.open(asset).convert("RGB")
        # 커버-크롭: 비율을 채우도록 확대 후 중앙 크롭 — 왜곡 없이 어떤 비율도 대응
        scale = max(w / bg.width, h / bg.height)
        bg = bg.resize((round(bg.width * scale), round(bg.height * scale)), Image.LANCZOS)
        left, top = (bg.width - w) // 2, (bg.height - h) // 2
        return bg.crop((left, top, left + w, top + h)), "bundled"
    except Exception as e:
        logger.warning("내장 배경 로드 실패 → 그라데이션 폴백: %s", e)
        bg = Image.new("RGB", (w, h))
        top_c, bottom_c = (250, 246, 240), (233, 223, 208)  # 크림 → 라떼 베이지
        for y in range(h):
            t = y / max(1, h - 1)
            bg.paste(tuple(round(top_c[i] + (bottom_c[i] - top_c[i]) * t) for i in range(3)),
                     (0, y, w, y + 1))
        return bg, "gradient"


def _clean_edge(cut):
    """③ 가장자리 정리 — rembg 매팅이 남긴 밝은 테두리(halo)를 깎고 경계를 살짝 부드럽게.

    1px 침식으로 피사체 밖으로 번진 배경색 링을 제거하고, 약한 페더링으로 계단
    현상을 없애 배경에 녹아들게 한다. '오려 붙인' 티가 가장 먼저 나는 곳이 경계다.
    """
    from PIL import ImageFilter

    alpha = cut.split()[-1]
    alpha = alpha.filter(ImageFilter.MinFilter(3))       # 1px 침식 → halo 제거
    alpha = alpha.filter(ImageFilter.GaussianBlur(0.6))  # 미세 페더 → 경계 부드럽게
    cut = cut.copy()
    cut.putalpha(alpha)
    return cut


def _harmonize_color(cut, bg_region, strength: float = 0.35, cap: float = 14.0):
    """① 색 조화 — 피사체의 화이트밸런스·노출을 '놓일 자리'의 배경 톤 쪽으로 살짝 당긴다.

    RGB 채널별 '평균 차이'만 strength만큼, 그리고 절대 이동량을 cap(±14레벨)으로 막아
    더한다. 균일한 평행이동이라 방향이 직관적이고(따뜻한 배경 = R↑·B↓ → 피사체도 그쪽)
    제품색이 폭주하지 않는다 — 표준편차까지 맞추는 정식 Reinhard는 평균이 크게 다르면
    픽셀을 극단으로 튕겨(실측: 쿨톤 컵이 네온으로) 광고물엔 위험해 쓰지 않는다. cap
    덕에 최악의 경우에도 은은한 정합에 그치고 메뉴 본래 색은 유지된다.
    """
    import numpy as np
    from PIL import Image

    a = np.asarray(cut.split()[-1])
    m = a > 40  # 반투명 경계는 통계 오염을 막기 위해 제외
    if int(m.sum()) < 50:  # 피사체가 거의 없으면 손대지 않는다
        return cut

    rgb = np.asarray(cut.convert("RGB"), dtype=np.float32)
    bg = np.asarray(bg_region.convert("RGB"), dtype=np.float32)
    out = rgb.copy()
    for ch in range(3):  # R·G·B 각각 배경 평균 쪽으로 (밝기 정합도 자연히 따라온다)
        cm = float(rgb[..., ch][m].mean())
        bm = float(bg[..., ch].mean())
        shift = max(-cap, min(cap, (bm - cm) * strength))  # 절대 이동량 상한
        out[..., ch] += shift

    res = np.dstack([out.clip(0, 255).astype(np.uint8), a]).astype(np.uint8)
    return Image.fromarray(res, "RGBA")


def _unify_grade(im):
    """② 통합 그레이딩 — 합성 완료본 '전체'에 공통 레이어를 한 번 덮어 하나처럼 묶는다.

    피사체와 배경이 같은 위층(따뜻한 틴트·비네트·필름 그레인·미세 대비)을 공유하면
    서로 다른 출처(실물 사진 vs AI 배경)의 이질감이 크게 줄어든다.
    """
    import numpy as np
    from PIL import Image, ImageEnhance

    im = im.convert("RGB")
    W, H = im.size
    arr = np.asarray(im, dtype=np.float32)

    # ⓐ 아주 옅은 따뜻한 틴트 — 같은 광원 아래 있는 느낌
    arr[..., 0] *= 1.015  # R ↑
    arr[..., 2] *= 0.985  # B ↓

    # ⓑ 비네트 — 가장자리를 살짝 눌러 중앙(피사체)로 시선을 모으고 프레임을 하나로
    yy, xx = np.mgrid[0:H, 0:W]
    r = np.sqrt(((xx - W / 2) / (W * 0.75)) ** 2 + ((yy - H * 0.55) / (H * 0.75)) ** 2)
    vig = np.clip(1.0 - (r - 0.7) * 0.35, 0.82, 1.0)[..., None]
    arr *= vig

    # ⓒ 필름 그레인 — 실물/AI의 노이즈 특성 차이를 덮어 경계감을 흐린다
    arr += np.random.normal(0, 3.0, (H, W, 1)).astype(np.float32)

    out = Image.fromarray(arr.clip(0, 255).astype(np.uint8), "RGB")
    # ⓓ 미세 대비 — 붙인 요소들을 같은 톤 커브 위에 올린다
    return ImageEnhance.Contrast(out).enhance(1.04)


def _composite(cut, bg):
    """피사체를 배경 중앙 하단에 얹는다 — 색/밝기 조화(①)·가장자리 정리(③)·통합 그레이딩(②).

    단순히 붙이면 사장님 사진의 원래 노출·화이트밸런스가 AI 배경 위에 '스티커처럼'
    떠 보인다. 붙이기 전에 경계를 정리하고 색을 배경 톤으로 부분 매칭한 뒤, 합성이
    끝난 전체에 공통 그레이딩을 한 번 덮어 자연스럽게 녹인다.
    """
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

    # ③ 가장자리 정리 → ① 놓일 자리의 배경 톤으로 색·밝기 부분 매칭
    cut = _clean_edge(cut)
    region = bg.convert("RGB").crop((x, y, x + cut.width, y + cut.height))
    cut = _harmonize_color(cut, region)

    canvas = bg.convert("RGBA")
    # 그림자: 피사체 실루엣을 눌러(높이 22%) 발밑에 깔고 크게 블러 — 조명 정합감
    alpha = cut.split()[-1]
    sh_h = max(8, int(cut.height * 0.22))
    shadow_mask = alpha.resize((cut.width, sh_h)).filter(ImageFilter.GaussianBlur(18))
    shadow = Image.new("RGBA", (cut.width, sh_h), (0, 0, 0, 0))
    shadow.putalpha(shadow_mask.point(lambda a: int(a * 0.38)))
    canvas.alpha_composite(shadow, (x, y + cut.height - sh_h // 2))
    canvas.alpha_composite(cut, (x, y))

    # ② 합성 완료본 전체에 공통 그레이딩 — 피사체+배경을 하나의 톤으로
    return _unify_grade(canvas.convert("RGB"))


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


def warm_backgrounds_async() -> None:
    """기동 시 누끼 모델(onnx 세션)을 백그라운드로 미리 초기화한다.

    배경은 내장 자산이라 예열이 필요 없지만, rembg 세션 생성+첫 추론이 새 인스턴스
    에서 수십 초(실측: 배포 직후 첫 합성 98초)를 잡아먹는다. 부팅 때 작은 더미
    이미지로 한 번 돌려두면 첫 사용자부터 수 초 합성을 본다.
    PHOTO_BG_WARM=0 으로 끌 수 있다(테스트·오프라인 환경).
    """
    import os
    import threading

    if os.getenv("PHOTO_BG_WARM", "1") == "0":
        return

    def _run() -> None:
        try:
            from PIL import Image, ImageDraw

            img = Image.new("RGB", (96, 96), (240, 240, 238))
            d = ImageDraw.Draw(img)
            d.ellipse([24, 24, 72, 72], fill=(110, 66, 36))
            buf = io.BytesIO()
            img.save(buf, "JPEG")
            _cutout(buf.getvalue())  # 세션 생성 + 첫 추론까지 완료
            logger.info("[사진 합성] 누끼 모델 예열 완료")
        except Exception:
            logger.debug("[사진 합성] 모델 예열 실패(무해)", exc_info=True)

    threading.Thread(target=_run, daemon=True, name="rembg-warm").start()
