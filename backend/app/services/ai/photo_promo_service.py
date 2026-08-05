"""실물 사진 기반 홍보 이미지 (백엔드 B) — 누끼 + 배경 합성.

AI 생성 이미지는 우리 매장 실물과 다를 수 있다. 그래서 사장님이 올린 메뉴 사진에서
피사체만 오려내(rembg·U2-Net 경량모델, 서버 CPU에서 동작 — 외부 유출 없음)
감성 배경 위에 자연스럽게 합성한다:

  ① 누끼: rembg(u2netp) — 첫 호출 때 모델(~5MB)을 내려받아 세션을 재사용
  ② 배경: 요청 경로에서는 절대 AI를 기다리지 않는다 — 캐시된 AI 배경이 있으면 그걸,
          없으면 번들 배경(static/promo_bg)을 즉시 쓰고, 다음 사용자를 위한 새 AI
          배경은 백그라운드 스레드가 미리 만들어 캐시에 넣는다(_refresh_bg_async).
          '항상 똑같은 배경' 문제는 캐시에 여러 장을 쌓아 무작위로 골라 해결한다.
  ③ 합성: Pillow — 피사체를 중앙 하단에 배치하고 부드러운 그림자를 깔아
          '스티커 붙인 느낌'을 줄인다
  ④ 저장·문서 연결은 기존 marketing_service 경로를 그대로 재사용

키가 전혀 없어도(무료 환경) 전 과정이 동작한다.

[속도] 결과물은 JPEG로 저장한다. PNG는 같은 1472² 합성본이 3.1MB인데 JPEG q92는
0.5MB로, 모바일에서 체감 지연(실측 37초)의 대부분이 이 다운로드였다. 서버 처리 자체는
누끼+합성 2~4초다(Cloud Run 실측).
"""
from __future__ import annotations

import io
import logging
import threading
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

# 배경 캐시 — (스타일, 비율)별로 6시간 재사용. AI 배경 생성이 수십 초로 가장 느린
# 구간이라, 실측 프로덕션 첫 합성이 78초까지 갔고 모바일 연결이 그 사이 끊겨
# '인터넷 연결 확인' 오류로 보였다. 그래서 요청 경로에서는 캐시/번들만 쓰고, 새 배경은
# 백그라운드로 채운다 — 합성은 항상 2~3초로 끝난다.
_BG_TTL = 6 * 3600
# 한 (스타일, 비율)당 최대 이만큼 쌓아 두고 무작위로 고른다 — '배경이 늘 똑같다'를
# 지연 없이 해결하는 방법. 캐시 전체는 _BG_CACHE_MAX장으로 묶어 메모리를 제한한다
# (Cloud Run 1Gi, 장당 JPEG 0.3~0.6MB).
_BG_PER_KEY = 3
_BG_CACHE_MAX = 9
# 마지막 배경이 이보다 오래됐고 아직 여유가 있으면 새 배경을 한 장 더 받아 둔다
_BG_REFRESH_AFTER = 20 * 60
_bg_cache: dict[tuple[str, str], list[tuple[float, bytes]]] = {}
_bg_inflight: set[tuple[str, str]] = set()
# 캐시는 요청 스레드(읽기)와 배경 생성 스레드(쓰기)가 함께 만진다 — 항상 이 락 아래에서
_bg_lock = threading.Lock()


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


def _bg_prompt(style: str) -> str:
    return BACKGROUND_STYLES.get(style, BACKGROUND_STYLES["wood"])["prompt"] + _NO_TEXT


def _cover_crop(raw: bytes, w: int, h: int):
    """AI/번들 배경 바이트를 요청 비율에 맞춰 확대 후 중앙 크롭 (왜곡 없음)."""
    import io as _io

    from PIL import Image

    bg = Image.open(_io.BytesIO(raw)).convert("RGB")
    scale = max(w / bg.width, h / bg.height)
    bg = bg.resize((round(bg.width * scale), round(bg.height * scale)), Image.LANCZOS)
    left, top = (bg.width - w) // 2, (bg.height - h) // 2
    return bg.crop((left, top, left + w, top + h))


def _bg_cache_get(key: tuple[str, str]) -> Optional[bytes]:
    """캐시된 AI 배경 하나를 무작위로 — 같은 스타일이라도 매번 같은 그림이 되지 않게."""
    import random
    import time

    with _bg_lock:
        fresh = [(ts, data) for ts, data in _bg_cache.get(key, []) if time.time() - ts < _BG_TTL]
        if len(fresh) != len(_bg_cache.get(key, [])):
            _bg_cache[key] = fresh
        return random.choice(fresh)[1] if fresh else None


def _bg_cache_put(key: tuple[str, str], data: bytes) -> None:
    """[주의] 호출자가 _bg_lock을 잡은 상태여야 한다."""
    import time

    entries = _bg_cache.setdefault(key, [])
    entries.append((time.time(), data))
    del entries[:-_BG_PER_KEY]
    # 전체 장수 제한 — 가장 오래된 것부터 버린다
    while sum(len(v) for v in _bg_cache.values()) > _BG_CACHE_MAX:
        oldest_key = min(_bg_cache, key=lambda k: _bg_cache[k][0][0] if _bg_cache[k] else 0)
        _bg_cache[oldest_key].pop(0)
        if not _bg_cache[oldest_key]:
            del _bg_cache[oldest_key]


def _refresh_bg_async(style: str, aspect_ratio: str) -> None:
    """다음 사용자를 위한 AI 배경을 백그라운드로 한 장 만들어 캐시에 넣는다.

    요청 응답과 무관하게 돌기 때문에 생성이 수십 초 걸려도 사장님이 기다리는 시간에는
    전혀 영향이 없다. 공급자가 막혀 있으면 그냥 번들 배경이 계속 쓰인다 — 실패는 무시.
    """
    import os
    import time

    if os.getenv("PHOTO_BG_AI", "1") == "0":
        return

    key = (style, aspect_ratio)
    with _bg_lock:
        entries = _bg_cache.get(key, [])
        if key in _bg_inflight:
            return
        if len(entries) >= _BG_PER_KEY and time.time() - entries[-1][0] < _BG_REFRESH_AFTER:
            return
        _bg_inflight.add(key)

    def _run() -> None:
        try:
            from app.services.ai import marketing_service as M

            raw, _mime, provider = M._generate_image_bytes(_bg_prompt(style), aspect_ratio, "standard")
            with _bg_lock:
                _bg_cache_put(key, raw)
            logger.info("[사진 합성] 배경 캐시 채움: %s/%s (%s)", style, aspect_ratio, provider)
        except Exception as e:
            logger.info("[사진 합성] 배경 미리 생성 실패(무해): %s", e)
        finally:
            with _bg_lock:
                _bg_inflight.discard(key)

    threading.Thread(target=_run, daemon=True, name=f"promo-bg-{style}").start()


def _background(style: str, aspect_ratio: str):
    """배경 이미지(RGB) — 절대 네트워크를 기다리지 않는다.

    ① 캐시된 AI 배경(있으면 무작위 1장) ② 번들 배경(static/promo_bg) ③ 크림 그라데이션.
    어느 쪽이든 즉시 끝나고, 다음 요청용 새 AI 배경은 백그라운드가 채운다.
    (예전에는 여기서 Gemini 25초 + Pollinations 12초를 기다려 최악 37초가 그대로
     사장님 대기 시간이 됐다 — 두 공급자 모두 무료 한도가 막힌 지금은 그 시간이
     '기다렸다가 결국 번들 배경'이라 순수 손해였다.)
    """
    import os

    from PIL import Image

    from app.services.ai import marketing_service as M

    w, h = M._AR_SIZES.get(aspect_ratio, (1472, 1472))

    if style not in BACKGROUND_STYLES:
        style = "wood"

    cached = _bg_cache_get((style, aspect_ratio))
    _refresh_bg_async(style, aspect_ratio)
    if cached:
        try:
            return _cover_crop(cached, w, h), "ai-cached"
        except Exception as e:
            logger.warning("[사진 합성] 캐시 배경 디코드 실패 → 번들 폴백: %s", e)

    asset = os.path.join(os.path.dirname(__file__), "..", "..", "static", "promo_bg", f"{style}.jpg")
    try:
        with open(asset, "rb") as f:
            return _cover_crop(f.read(), w, h), "bundled"
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

    # JPEG로 저장한다 — 같은 합성본이 PNG 3.1MB vs JPEG q92 0.5MB(실측)로, 사장님이
    # 체감하는 지연의 대부분이 이 다운로드였다. 사진 합성물이라 화질 차이는 안 보인다.
    buf = io.BytesIO()
    final.save(buf, format="JPEG", quality=92, subsampling=0, optimize=True)
    image_id, filename = M._save_image(buf.getvalue(), "image/jpeg")

    entry = {
        "image_id": image_id,
        "filename": filename,
        "url": M.image_url(filename),
        "raw_filename": filename,
        "raw_url": M.image_url(filename),
        "overlay": "none",
        "slogan": "",
        "mime_type": "image/jpeg",
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
    """기동 시 누끼 모델(onnx 세션)과 AI 배경 한 장을 백그라운드로 미리 준비한다.

    rembg 세션 생성+첫 추론이 새 인스턴스에서 수십 초(실측: 배포 직후 첫 합성 98초)를
    잡아먹는다. 부팅 때 작은 더미 이미지로 한 번 돌려두면 첫 사용자부터 수 초 합성을
    본다. PHOTO_BG_WARM=0 으로 끌 수 있다(테스트·오프라인 환경).

    AI 배경은 여기서 미리 받지 않는다 — 무료 이미지 생성 할당량이 앱 전체 공유라,
    아무도 안 쓸 수도 있는 기동 시점에 한 장을 태우면 정작 사장님 요청 때 모자란다.
    첫 합성은 번들 배경으로 즉시 끝내고, 그때 백그라운드가 다음 장을 채운다.
    PHOTO_BG_AI=1(기본)일 때만 그 예열이 돈다.
    """
    import os

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
