"""실물 사진 기반 홍보 이미지 (백엔드 B).

AI 생성 이미지는 우리 매장 실물과 다를 수 있다. 그래서 사장님이 올린 메뉴 사진의
'진짜 우리 메뉴'를 지킨 채 배경만 홍보용으로 바꾼다. 경로는 셋이다.

  ① 누끼 + 배경 합성 — **기본값.** 네트워크도 유료 호출도 없이 서버에서 끝낸다.
     아래 '자연스러움' 항목들. 실측 3초, 비용 0.
  ② 사진 편집(_ai_edit) — `PHOTO_EDIT_AI=1`일 때만. 편집 모델(FLUX Kontext)이 사진
     자체를 다시 그려 원근·조명·그림자·반사가 처음부터 하나로 맞는다. 품질은 가장
     좋지만 **장당 0.04 Pollen**(일반 이미지 생성의 10배)이고 14초 걸린다.
     실패하면 조용히 ①로 되돌아간다.
  ③ 보정만(_retouch) — 오려낼 메뉴가 뚜렷하지 않은 사진(매장 전경 등).

기본 구성에서는 홍보 이미지에 돈이 들지 않는다. AI 배경 미리 생성(_refresh_bg_async)도
같은 이유로 기본 꺼짐이다(`PHOTO_BG_AI=1`로 켠다) — Pollen 지갑은 홍보 문구·이미지
생성과 공유하므로, 사진 합성이 조용히 축내면 정작 본 기능이 402로 죽는다.

[오려붙이기가 어색해 보였던 진짜 이유 — 원근] 사장님이 휴대폰으로 찍은 메뉴 사진은
거의 항상 **위에서 30~60도로 내려다본** 각도다. 그런데 번들 배경이 테이블 눈높이에서
찍힌 것이면 상판의 소실선과 피사체의 원근이 어긋나, 그림자를 아무리 잘 깔아도 '뭔가
이상하다'가 남는다. 그래서 번들 배경 10장을 전부 **같은 각도(내려다본 상판)** 로
다시 뽑았다. 같은 사진·같은 파이프라인으로 비교했을 때 이 교체의 효과가 가장 컸다.
배경 프롬프트(_BG_RULES)도 같은 각도를 강제한다 — 섞이면 절반이 다시 어긋난다.

[편집 경로(②)에서 조심할 것 — 둘 다 실측]
  · 메뉴가 없는 사진(매장 전경)을 주면 **없던 라떼를 만들어 낸다**. 우리 매장에 없는
    메뉴를 홍보물로 내보내는 셈이라 절대 안 된다. 그래서 누끼로 '뚜렷한 메뉴가 있는
    사진'인지 먼저 확인하고서만 이 경로를 탄다(stats["compositable"]).
  · 요청 크기를 무시하고 늘 1024²를 돌려준다 → _extend_to_ratio가 화면비를 맞춘다.

[배경(①)] 요청 경로에서는 절대 AI를 기다리지 않는다 — 캐시된 AI 배경이 있으면 그걸,
없으면 번들 배경(static/promo_bg)을 즉시 쓰고, 다음 사용자를 위한 새 AI 배경은
백그라운드 스레드가 미리 만들어 캐시에 넣는다(_refresh_bg_async). '항상 똑같은 배경'
문제는 캐시에 여러 장을 쌓고, 번들도 스타일당 여러 장을 두어 무작위로 골라 해결한다.

[자연스러움 6단계 — ① 경로] 초기 버전은 피사체를 배경 한가운데에 그냥 붙이고 눌린
실루엣 그림자를 하나 깔았다. 결과가 '공중에 뜬 스티커'였다(실측: 빙수 그릇이 카페 그림
위에 떠 있고 그림자가 기둥처럼 보였다). 지금은 실제 제품 사진이 자연스러워 보이는
이유를 하나씩 흉내 낸다:

  1. 매트 정리   — 헤일로(반투명 안개)를 곡선으로 걷고, 떨어진 잔티를 지우고,
                   경계에 남은 '원래 배경색 번짐'을 안쪽 색으로 덮는다(_decontaminate)
  2. 배치        — 배경마다 '상판이 어디인지'를 알고 그 위에 앉힌다(_STYLES의 surface).
                   화면비가 바뀌어도 상판이 잘려 나가지 않게 크롭을 아래로 붙인다
  3. 심도        — 배경을 뒤로 갈수록 흐리게(_depth_blur). 배경이 또렷하면 피사체가
                   종이처럼 뜬다. 놓일 자리에 은은한 빛웅덩이를 깔아 시선을 모은다
  4. 그림자      — 접지 그림자(좁고 진하게)와 눕힌 그림자(광원 반대쪽으로 기울여
                   멀어질수록 옅게) 두 장. 물체가 '바닥에 붙어' 보이는 건 앞의 것이,
                   '같은 조명 아래' 있어 보이는 건 뒤의 것이 만든다
  5. 빛 감싸기   — 배경빛이 피사체 가장자리를 감싸게(_light_wrap). 서로 다른 출처를
                   한 공간으로 묶는 가장 강한 단서다. 매끄러운 상판엔 반사도 깐다
  6. 통합 그레이딩 — 완성본 전체에 같은 톤 커브·블룸·비네트·미세 그레인을 덮는다

[매장 사진처럼 오려낼 게 없으면] 억지로 누끼를 뜨면 결과가 처참하다. 피사체가 화면을
거의 다 채우면(카페 내부 사진 등) 합성을 포기하고 원본을 살려 보정만 한다(_retouch).

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

# 배경 스타일.
#   label   — 앱 칩에 보이는 이름
#   prompt  — Pollinations에 넘길 장면 설명
#   surface — 피사체 바닥이 놓일 높이(0=위, 1=아래). 배경마다 상판 위치가 달라, 이걸
#             모르면 컵이 테이블 앞 허공이나 벽 한가운데에 놓인다(초기 버전의 실제 증상)
#   gloss   — 상판 반사도. 대리석·스튜디오처럼 매끈한 면만 반사를 깐다
#   scene   — 사진 편집(kontext) 경로에서 "이 위에 올려 달라"고 지시할 장면
BACKGROUND_STYLES: dict[str, dict[str, Any]] = {
    "wood": {
        "label": "우드 테이블",
        "prompt": "an empty warm oak wood cafe tabletop seen from above at an angle, filling almost "
                  "the whole frame, a hint of softly blurred cafe interior along the top edge",
        "scene": "a warm oak wood cafe table, with a softly blurred cozy cafe interior and "
                 "natural window light behind",
        "surface": 0.76,
        "gloss": 0.10,
    },
    "marble": {
        "label": "대리석",
        "prompt": "an empty polished white marble countertop seen from above at an angle, filling "
                  "almost the whole frame, a hint of bright blurred kitchen along the top edge",
        "scene": "a polished white marble countertop, with a bright airy blurred white interior "
                 "behind, clean daylight",
        "surface": 0.72,
        "gloss": 0.22,
    },
    "cozy": {
        "label": "코지 감성",
        "prompt": "an empty table with soft beige linen cloth seen from above at an angle, filling "
                  "almost the whole frame, warm afternoon sunlight raking across the cloth",
        "scene": "a table draped in soft beige linen cloth, with warm afternoon sunlight and "
                 "blurred dried flowers behind",
        "surface": 0.76,
        "gloss": 0.04,
    },
    "studio": {
        "label": "스튜디오",
        "prompt": "an empty smooth cream studio surface seen from above at an angle, filling almost "
                  "the whole frame, soft gradient shadow falling across it",
        "scene": "a seamless cream studio backdrop with soft gradient lighting, like a "
                 "professional product photo",
        "surface": 0.78,
        "gloss": 0.22,
    },
    "season": {
        "label": "시즌 감성",
        "prompt": "an empty rustic cafe tabletop seen from above at an angle, filling almost the "
                  "whole frame, warm golden bokeh string lights blurred along the top edge",
        "scene": "a rustic cafe table, with warm golden bokeh string lights blurred far behind",
        "surface": 0.78,
        "gloss": 0.12,
    },
}
# 배경에 아무것도 놓이지 않게 하는 규칙. 여기서 실패하면(잔이나 접시가 그려지면)
# 그 위에 우리 메뉴를 또 얹게 돼 합성이 곧바로 지저분해진다.
_BG_RULES = (
    ". Editorial food-photography backdrop shot from above at a 45 degree angle, looking down "
    "onto the surface. 50mm lens at f/2.8, natural soft light, realistic photo, shallow depth of "
    "field. The surface must be completely bare and empty: no cups, no mugs, no plates, no food, "
    "no drinks, no bottles, no props, no hands, no people, no text, no letters, no logos, "
    "no watermark, no lighting equipment. Nothing placed on the surface."
)

# 번들 배경 파일별 상판 높이. 스타일 기본값(BACKGROUND_STYLES의 surface)보다 우선한다 —
# 같은 스타일이어도 자산마다 테이블이 놓인 높이가 다르다. 각 파일에 가로선을 그려
# 눈으로 확인하고 넣은 값이다(코지는 둥근 테이블이라 두 장의 차이가 특히 크다).
_BUNDLED_SURFACE: dict[str, float] = {
    "wood.jpg": 0.76, "wood_b.jpg": 0.78,
    "marble.jpg": 0.70, "marble_b.jpg": 0.74,
    "cozy.jpg": 0.74, "cozy_b.jpg": 0.78,
    "studio.jpg": 0.78, "studio_b.jpg": 0.78,
    "season.jpg": 0.78, "season_b.jpg": 0.78,
}

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


# ---------------------------------------------------------------------------
# ⓪ 사진 편집(img2img) — 오려붙이지 않고 모델이 장면을 다시 그린다
# ---------------------------------------------------------------------------
# 오려붙이기는 아무리 다듬어도 한계가 있다. 사장님 사진은 위에서 내려다본 각도인데
# 배경은 눈높이에서 찍힌 식이라 원근이 어긋나고, 피사체에 남은 원래 조명이 새 장면의
# 광원과 다르다. 사람은 그걸 '뭔가 이상하다'로 느낀다.
#
# 편집 모델(FLUX Kontext)은 사진 자체를 다시 그리기 때문에 원근·조명·그림자·반사가
# 처음부터 하나로 맞는다. 실측 비교에서 차이가 컸다. 대신 두 가지를 조심해야 한다:
#   · 메뉴가 없는 사진(매장 전경)을 주면 **없던 라떼를 만들어 낸다**(실측). 그래서
#     누끼로 '뚜렷한 메뉴가 있는 사진'인지 먼저 확인하고서만 이 경로를 탄다.
#   · 요청 크기를 무시하고 늘 1024²를 돌려준다(실측) → _extend_to_ratio로 맞춘다.
_EDIT_MODEL = "kontext"     # PHOTO_EDIT_MODEL로 교체 가능
_EDIT_TIMEOUT = 45.0        # PHOTO_EDIT_TIMEOUT (실측 11~13초)
# 이 문구가 결과의 '실물 그대로'를 좌우한다. 색을 콕 집어 못박기 전에는 라떼아트를
# 다른 무늬로 새로 그리는 일이 있었다(실측 비교) — 그릇 색을 고정하라고 쓰면 무늬까지
# 원본에 붙는다. 짧게 줄이지 말 것.
_EDIT_KEEP = (
    "CRITICAL: the cup, bowl or plate must keep its EXACT original color and material - if it is "
    "grey or beige ceramic it stays grey or beige ceramic, never turn it white. Keep the food or "
    "drink itself, its latte-art or topping pattern, its shape and its size EXACTLY as in the "
    "original photo - do not redraw, restyle, move or resize it. Do not add any food, drink, cup, "
    "plate or object that is not already in the original photo. Change only what is around it: "
    "only relight the item to match the new scene and add a realistic contact shadow where it "
    "meets the surface. Photorealistic, 50mm lens at f/2. No text, no letters, no logos, "
    "no watermark."
)


def _edit_prompt(style: str) -> str:
    scene = BACKGROUND_STYLES.get(style, BACKGROUND_STYLES["wood"])["scene"]
    return f"Replace only the background of this photo: put it on {scene}. {_EDIT_KEEP}"


def _ai_edit(photo_jpeg: bytes, style: str) -> tuple[bytes, str]:
    """사진 편집 요청 — 성공하면 (이미지 바이트, 모델명). 실패는 그대로 올려 보낸다.

    실패(잔액 부족·타임아웃·모델 오류)는 호출자가 잡아 오려붙이기 경로로 되돌린다.
    이 경로가 없어도 홍보 이미지는 항상 나온다.
    """
    import os

    import httpx

    model = os.getenv("PHOTO_EDIT_MODEL", _EDIT_MODEL).strip() or _EDIT_MODEL
    timeout = float(os.getenv("PHOTO_EDIT_TIMEOUT", str(_EDIT_TIMEOUT)))
    token = os.getenv("POLLINATIONS_TOKEN", "").strip()
    if not token:
        raise PhotoPromoError("POLLINATIONS_TOKEN이 없어 사진 편집을 건너뜁니다")

    r = httpx.post(
        "https://gen.pollinations.ai/v1/images/edits",
        files={"image": ("photo.jpg", photo_jpeg, "image/jpeg")},
        data={"model": model, "prompt": _edit_prompt(style), "n": "1"},
        headers={"Authorization": f"Bearer {token}"},
        timeout=httpx.Timeout(timeout, connect=min(5.0, timeout)),
    )
    if r.status_code != 200:
        raise PhotoPromoError(f"사진 편집 실패({model}): {r.status_code} {(r.text or '')[:200]}")
    if (r.headers.get("content-type") or "").split(";")[0].startswith("image/"):
        return r.content, model
    import base64

    try:
        entry = r.json()["data"][0]
    except Exception:
        raise PhotoPromoError(f"사진 편집 응답을 해석하지 못했습니다({model})")
    if entry.get("b64_json"):
        return base64.b64decode(entry["b64_json"]), model
    if entry.get("url"):
        got = httpx.get(entry["url"], timeout=min(20.0, timeout))
        got.raise_for_status()
        return got.content, model
    raise PhotoPromoError(f"사진 편집 응답에 이미지가 없습니다({model})")


def _extend_to_ratio(raw: bytes, w: int, h: int):
    """편집 결과(정사각)를 요청 화면비로 맞춘다 — 방향에 따라 자르거나 늘린다.

    편집 모델은 요청 크기를 무시하고 늘 1024²를 돌려준다(실측).
      · 가로가 더 넓은 요청(16:9 등)은 **위아래를 자른다** — 먼저 없어지는 게 천장과
        앞쪽 빈 테이블이라 손해가 없다. 대신 세로의 55% 밑으로는 자르지 않는다.
      · 세로가 더 긴 요청(9:16 등)은 **위쪽을 늘린다** — 좌우를 자르면 메뉴가 잘린다.

    늘릴 때는 가장자리 픽셀을 그대로 밀어내고(edge) 세게 흐린다. 거울 반사(reflect)로
    늘렸더니 케이크가 화면 위쪽에 유령처럼 한 번 더 비쳤다(실측) — 반사는 알아볼 수
    있는 물건을 복제하기 때문에 이 용도에는 쓰면 안 된다.
    """
    import io as _io

    import numpy as np
    from PIL import Image, ImageFilter

    im = Image.open(_io.BytesIO(raw)).convert("RGB")

    target = w / h
    if im.width / im.height < target:  # 요청이 더 넓다 → 위아래를 자른다
        keep_h = max(int(im.height * 0.55), round(im.width / target))
        if keep_h < im.height:
            top = int((im.height - keep_h) * 0.35)  # 천장 쪽을 더 덜어낸다
            im = im.crop((0, top, im.width, top + keep_h))

    scale = min(w / im.width, h / im.height)
    core = im.resize((max(1, round(im.width * scale)), max(1, round(im.height * scale))),
                     Image.LANCZOS)
    if core.size == (w, h):
        return core

    left = (w - core.width) // 2
    top = h - core.height  # 세로 여백은 전부 위로 — 상판을 아래에 둔다
    padded = Image.fromarray(np.pad(
        np.asarray(core),
        ((top, h - core.height - top), (left, w - core.width - left), (0, 0)), mode="edge"))

    # 늘린 자리는 알아볼 수 없을 만큼 흐리게 — 밀어낸 줄무늬가 보케처럼 읽힌다
    blurred = padded.filter(ImageFilter.GaussianBlur(max(12.0, h * 0.05)))
    keep = Image.new("L", (w, h), 0)
    keep.paste(255, (left, top, left + core.width, top + core.height))
    keep = keep.filter(ImageFilter.GaussianBlur(max(6.0, h * 0.02)))  # 이음매를 녹인다
    return Image.composite(padded, blurred, keep)


# ---------------------------------------------------------------------------
# ① 누끼와 매트 정리
# ---------------------------------------------------------------------------

def _drop_specks(alpha):
    """본체와 떨어진 잔티(rembg가 흔히 남기는 점·조각)를 지운다.

    작은 축소본에서 침식해 본체 심만 남긴 뒤(잔티는 그 과정에서 사라진다) 마스크
    안쪽으로 다시 부풀려, 본체와 이어진 영역만 복원한다(형태학적 재구성). 1280²에서
    직접 라벨링하는 것보다 수십 배 싸고 scipy 없이 PIL만으로 된다.

    지워지는 양이 크면(접시 옆의 케이크처럼 진짜 두 덩어리일 수 있다) 손대지 않는다.
    """
    import numpy as np
    from PIL import Image, ImageFilter

    W, H = alpha.size
    small = alpha.resize((192, 192), Image.BILINEAR).point(lambda v: 255 if v > 128 else 0)
    core = small
    for _ in range(3):
        core = core.filter(ImageFilter.MinFilter(3))
    if core.getbbox() is None:
        return alpha  # 전부 얇다 — 판단 불가, 원본 유지

    mask = np.asarray(small, dtype=bool)
    cur = np.asarray(core, dtype=bool)
    for _ in range(80):  # 마스크 안에서만 부풀리기 = 연결된 성분 복원
        grown = np.asarray(
            Image.fromarray((cur * 255).astype(np.uint8), "L").filter(ImageFilter.MaxFilter(3)),
            dtype=bool) & mask
        if grown.sum() == cur.sum():
            break
        cur = grown

    total = int(mask.sum())
    if total == 0 or int((mask & ~cur).sum()) > total * 0.10:
        return alpha  # 떨어져 나가는 게 10%를 넘으면 잔티가 아니다 — 그대로 둔다

    gate = Image.fromarray((cur * 255).astype(np.uint8), "L").resize((W, H), Image.BILINEAR)
    gate = gate.filter(ImageFilter.GaussianBlur(2)).point(lambda v: 255 if v > 40 else 0)
    from PIL import ImageChops
    return ImageChops.multiply(alpha, gate)


def _refine_alpha(alpha):
    """rembg 알파 다듬기 — 헤일로 제거·잔티 제거·미세 페더.

    예전엔 1px 침식(MinFilter)으로 헤일로를 잘랐는데, 빨대·손잡이·포크처럼 얇은 부분이
    같이 잘려 나갔다. 대신 알파 곡선의 아래를 걷어 올리면 침식 없이 옅은 안개만
    사라진다 — 얇은 구조는 알파가 높아 그대로 남는다.
    """
    import numpy as np
    from PIL import Image, ImageFilter

    a = np.asarray(alpha, dtype=np.float32) / 255.0
    # 0.14에서 0.30으로 올렸다 — 반투명 테두리에는 찍을 때의 배경(흰 접시·조리대)이
    # 그대로 섞여 있어서, 남겨 두면 피사체 둘레에 흰 실루엣으로 떠오른다(실측).
    a = np.clip((a - 0.30) / 0.58, 0.0, 1.0)
    a = a * a * (3.0 - 2.0 * a)  # smoothstep — 계단 없이 부드럽게
    out = Image.fromarray((a * 255).astype(np.uint8), "L")
    out = _drop_specks(out)
    return out.filter(ImageFilter.GaussianBlur(0.7))


def _decontaminate(cut):
    """경계에 남은 '원래 배경색 번짐'을 안쪽 색으로 덮는다.

    누끼 경계 1~3px에는 찍을 때의 배경색이 섞여 남는다. 밝은 주방에서 오린 컵을
    어두운 배경에 얹으면 그 흰 테두리가 그대로 따라와 '오려 붙인 티'가 난다.
    침식으로 잘라내면 얇은 부분이 사라지므로, 알파 가중 블러로 안쪽 색을 바깥으로
    밀어 경계 픽셀의 '색'만 갈아 끼운다(알파는 그대로).
    """
    import numpy as np
    from PIL import Image, ImageFilter

    r = max(2.0, cut.height * 0.006)
    a8 = cut.split()[-1]
    a = np.asarray(a8, dtype=np.float32) / 255.0
    rgb = np.asarray(cut.convert("RGB"), dtype=np.float32)

    pre = Image.fromarray((rgb * a[..., None]).clip(0, 255).astype(np.uint8), "RGB")
    num = np.asarray(pre.filter(ImageFilter.GaussianBlur(r)), dtype=np.float32)
    den = np.asarray(a8.filter(ImageFilter.GaussianBlur(r)), dtype=np.float32) / 255.0
    inner = num / np.maximum(den, 1e-3)[..., None]

    w = np.clip(1.0 - a, 0.0, 1.0)[..., None]  # 불투명한 안쪽은 손대지 않는다
    out = (rgb * (1.0 - w) + inner * w).clip(0, 255).astype(np.uint8)
    return Image.fromarray(np.dstack([out, (a * 255).astype(np.uint8)]), "RGBA")


def _cutout(photo_bytes) -> tuple[Any, Any, dict[str, Any]]:
    """사진에서 피사체를 오려낸다. 반환은 (피사체 RGBA, 원본 RGB, 판정 정보)."""
    global _session
    try:
        from rembg import new_session, remove
    except Exception:
        raise PhotoPromoError("서버에 배경 제거 모듈(rembg)이 없습니다. 관리자에게 문의해 주세요.")
    import numpy as np
    from PIL import Image, ImageOps

    if _session is None:
        # u2netp: 경량(≈5MB) 모델 — Cloud Run 1Gi 메모리에서도 안전
        _session = new_session("u2netp")
    try:
        src = Image.open(io.BytesIO(photo_bytes))
        # 휴대폰 사진은 회전 정보를 EXIF로만 갖고 있다 — 이걸 반영하지 않으면 세로로
        # 찍은 사진이 눕는다. 누끼·합성이 아무리 좋아도 그 순간 결과물은 끝이다.
        src = ImageOps.exif_transpose(src).convert("RGB")
    except Exception:
        raise PhotoPromoError("사진 파일을 읽지 못했습니다. JPG/PNG 사진인지 확인해 주세요.")
    # 보정 경로(_retouch)는 이 원본을 그대로 쓰므로 출력 해상도(최대 1792)보다 여유를
    # 둬 2048까지만 줄인다. 누끼에는 따로 1280 사본을 쓴다 — 1600에서 1280으로 낮춘 건
    # 1Gi 인스턴스에서 onnx 추론 중 OOM으로 503이 나던 실측 사례 대응이고, 홍보 컷
    # 기준 매트 품질 차이는 체감되지 않는다.
    src.thumbnail((2048, 2048))
    small = src.copy()
    small.thumbnail((1280, 1280))
    cut = remove(small.convert("RGBA"), session=_session)

    alpha = _refine_alpha(cut.split()[-1])
    cut.putalpha(alpha)

    bbox = cut.getbbox()
    if bbox is None:
        raise PhotoPromoError("사진에서 메뉴(피사체)를 찾지 못했습니다. 다른 사진으로 시도해 주세요.")

    a = np.asarray(alpha, dtype=np.uint8)
    solid = a > 128
    coverage = float(solid.mean())
    # 매트가 사방 테두리에 닿아 있으면 '배경 위의 물건'이 아니라 장면 전체를 잡은 것이다
    edges = sum(1 for e in (solid[0], solid[-1], solid[:, 0], solid[:, -1]) if e.mean() > 0.5)

    cut = cut.crop(bbox)
    if cut.width < 40 or cut.height < 40:
        raise PhotoPromoError("피사체가 너무 작게 인식됐어요. 메뉴가 크게 나온 사진으로 시도해 주세요.")

    # 매장 내부 사진처럼 '배경 위의 물건'이 아닌 사진은 여기서 걸러 합성을 포기한다.
    #   · 화면을 거의 다 채우고 테두리까지 물려 있다 → 장면 전체를 잡은 것
    #   · 반대로 너무 작다 → 의자 다리 같은 파편만 잡은 것(실측: 카페 내부 사진에서
    #     의자 등받이 조각 하나가 오려져 테이블 위에 떠 있는 결과가 나왔다)
    compositable = 0.035 <= coverage and not (coverage > 0.80 and edges >= 3)
    return cut, src, {"coverage": coverage, "edges": edges, "compositable": compositable}


# ---------------------------------------------------------------------------
# ② 배경 — 캐시·번들·백그라운드 갱신
# ---------------------------------------------------------------------------

def _bg_prompt(style: str) -> str:
    return BACKGROUND_STYLES.get(style, BACKGROUND_STYLES["wood"])["prompt"] + _BG_RULES


def _cover_crop(raw: bytes, w: int, h: int, surface: float,
                anchor: float = 0.85) -> tuple[Any, float]:
    """배경 바이트를 요청 비율에 맞춰 확대 후 크롭. (이미지, 새 surface)를 돌려준다.

    세로로 자를 때 가운데를 남기면 화면비에 따라 상판이 통째로 잘려 나간다(16:9는
    위아래 22%씩을 버린다 — 상판이 0.8에 있으면 그대로 사라진다). 아래쪽에 붙여
    잘라 상판을 지키고, 잘린 만큼 surface 값을 다시 계산해 배치가 어긋나지 않게 한다.
    """
    import io as _io

    from PIL import Image

    bg = Image.open(_io.BytesIO(raw)).convert("RGB")
    scale = max(w / bg.width, h / bg.height)
    bg = bg.resize((round(bg.width * scale), round(bg.height * scale)), Image.LANCZOS)
    left = (bg.width - w) // 2
    top = int((bg.height - h) * anchor)  # 기본은 아래쪽 우선 — 상판을 지킨다
    if bg.height > h:
        surface = (surface * bg.height - top) / h
    return bg.crop((left, top, left + w, top + h)), min(0.94, max(0.55, surface))


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
    # TTL 만료로 비어 버린 키를 먼저 걷어낸다 — 아래 min()이 빈 리스트를 0점으로 골라
    # pop(0)에서 IndexError가 나면, 이 함수를 부르는 생성 스레드가 그때부터 전부 죽어
    # 캐시가 프로세스 재시작 전까지 번들 배경만 남는 상태로 굳는다 (실제 재현된 사고).
    for k in [k for k, v in _bg_cache.items() if not v]:
        del _bg_cache[k]
    # 전체 장수 제한 — 가장 오래된 것부터 버린다
    while sum(len(v) for v in _bg_cache.values()) > _BG_CACHE_MAX:
        oldest_key = min(_bg_cache, key=lambda k: _bg_cache[k][0][0])
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

    if os.getenv("PHOTO_BG_AI", "0") != "1":
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

            raw, _mime, provider, _meta = M._generate_image_bytes(_bg_prompt(style), aspect_ratio, "standard")
            with _bg_lock:
                _bg_cache_put(key, raw)
            logger.info("[사진 합성] 배경 캐시 채움: %s/%s (%s)", style, aspect_ratio, provider)
        except Exception as e:
            logger.info("[사진 합성] 배경 미리 생성 실패(무해): %s", e)
        finally:
            with _bg_lock:
                _bg_inflight.discard(key)

    threading.Thread(target=_run, daemon=True, name=f"promo-bg-{style}").start()


def _bundled_paths(style: str) -> list[str]:
    """스타일의 번들 배경 파일들 — `wood.jpg`, `wood_b.jpg` … 순서대로."""
    import glob
    import os

    root = os.path.join(os.path.dirname(__file__), "..", "..", "static", "promo_bg")
    return sorted(glob.glob(os.path.join(root, f"{style}.jpg")) +
                  glob.glob(os.path.join(root, f"{style}_*.jpg")))


def _background(style: str, aspect_ratio: str) -> tuple[Any, str, float]:
    """배경 이미지(RGB)·출처·상판 높이. 절대 네트워크를 기다리지 않는다.

    ① 캐시된 AI 배경(있으면 무작위 1장) ② 번들 배경(스타일당 여러 장 중 무작위)
    ③ 크림 그라데이션. 어느 쪽이든 즉시 끝나고, 다음 요청용 새 AI 배경은
    백그라운드가 채운다.
    (예전에는 여기서 Gemini 25초 + Pollinations 12초를 기다려 최악 37초가 그대로
     사장님 대기 시간이 됐다 — 기다렸다가 결국 번들 배경이면 순수 손해였다.)
    """
    import os
    import random

    from PIL import Image

    from app.services.ai import marketing_service as M

    w, h = M._AR_SIZES.get(aspect_ratio, (1472, 1472))
    if style not in BACKGROUND_STYLES:
        style = "wood"
    prior = float(BACKGROUND_STYLES[style]["surface"])

    cached = _bg_cache_get((style, aspect_ratio))
    _refresh_bg_async(style, aspect_ratio)
    if cached:
        try:
            bg, surface = _cover_crop(cached, w, h, prior)
            return bg, "ai-cached", surface
        except Exception as e:
            logger.warning("[사진 합성] 캐시 배경 디코드 실패 → 번들 폴백: %s", e)

    paths = _bundled_paths(style)
    for path in random.sample(paths, len(paths)):
        try:
            with open(path, "rb") as f:
                raw = f.read()
        except Exception as e:
            logger.warning("내장 배경 로드 실패(%s): %s", path, e)
            continue
        s = _BUNDLED_SURFACE.get(os.path.basename(path), prior)
        bg, surface = _cover_crop(raw, w, h, s)
        return bg, "bundled", surface

    bg = Image.new("RGB", (w, h))
    top_c, bottom_c = (250, 246, 240), (233, 223, 208)  # 크림 → 라떼 베이지
    for y in range(h):
        t = y / max(1, h - 1)
        bg.paste(tuple(round(top_c[i] + (bottom_c[i] - top_c[i]) * t) for i in range(3)),
                 (0, y, w, y + 1))
    return bg, "gradient", 0.86


# ---------------------------------------------------------------------------
# ③~⑥ 합성 — 심도·그림자·빛 감싸기·그레이딩
# ---------------------------------------------------------------------------

def _depth_blur(bg, surface: float):
    """뒤로 갈수록 흐리게 — 얕은 심도.

    상판 접지선 근처가 가장 또렷하고 위(먼 배경)로 갈수록 흐려진다. 화면 아래 앞쪽도
    살짝 풀어 준다. 배경 전체가 또렷하면 어떤 그림자를 깔아도 피사체가 종이처럼 뜬다.
    """
    import numpy as np
    from PIL import Image, ImageFilter

    W, H = bg.size
    far = np.asarray(bg.filter(ImageFilter.GaussianBlur(H * 0.016)), dtype=np.float32)
    base = np.asarray(bg, dtype=np.float32)

    y = np.linspace(0.0, 1.0, H, dtype=np.float32)
    w = np.clip((surface - y) / max(0.12, surface), 0, 1) ** 0.8          # 위쪽(먼 곳)
    w = np.maximum(w, np.clip((y - surface) / max(0.05, 1 - surface), 0, 1) * 0.5)  # 앞쪽
    out = base + (far - base) * w[:, None, None]
    return Image.fromarray(out.clip(0, 255).astype(np.uint8), "RGB")


def _light_pool(bg, cx: float, cy: float, strength: float = 0.14):
    """피사체가 놓일 자리에 은은한 빛웅덩이 — 시선을 모으고 접지 그림자를 돋보이게."""
    import numpy as np
    from PIL import Image

    W, H = bg.size
    # mgrid 대신 1차원 축을 브로드캐스트한다 — 1472²에서 mgrid는 int64 격자 두 장
    # (약 34MB)을 먼저 만들어, 메모리 1Gi 인스턴스에서 굳이 칠 필요 없는 봉우리가 된다.
    ys = (np.arange(H, dtype=np.float32)[:, None] - cy * H) / (H * 0.50)
    xs = (np.arange(W, dtype=np.float32)[None, :] - cx * W) / (W * 0.55)
    r = np.sqrt(xs * xs + ys * ys)
    glow = np.clip(1.0 - r, 0, 1) ** 2 * strength
    arr = np.asarray(bg, dtype=np.float32) * (1.0 + glow[..., None])
    return Image.fromarray(arr.clip(0, 255).astype(np.uint8), "RGB")


def _light_dir(bg) -> float:
    """배경 좌우 밝기 차로 광원 방향을 읽는다 → 그림자를 반대쪽으로 눕히기 위해.

    -1이면 그림자가 왼쪽, +1이면 오른쪽. 배경이 고른 스튜디오면 0에 가까워 그림자가
    거의 발밑에만 남는다 — 그게 실제로도 맞다.
    """
    import numpy as np

    a = np.asarray(bg.convert("L").resize((32, 32)), dtype=np.float32)
    d = (float(a[:, 20:].mean()) - float(a[:, :12].mean())) / 255.0
    v = max(-1.0, min(1.0, -d * 3.5))
    # 스튜디오처럼 좌우가 고른 배경은 0에 가까워, 그림자가 피사체 뒤에 완전히 숨어
    # 아무 그림자도 없는 것처럼 보인다. 그럴 땐 왼쪽 광원을 가정해 살짝 눕힌다.
    return float(v if abs(v) >= 0.30 else (0.30 if v >= 0 else -0.30))


def _cast_shadow(alpha, light_x: float, cut_w: int, cut_h: int):
    """눕힌 그림자 마스크 — 바닥에 눌러 붙이고 광원 반대쪽으로 기울이며, 멀수록 옅게."""
    import numpy as np
    from PIL import Image, ImageFilter

    sh_h = max(12, int(cut_h * 0.24))
    shear = light_x * 1.2 * sh_h  # 위쪽(먼 끝)이 이만큼 밀린다
    pad = int(abs(shear)) + int(cut_h * 0.12) + 6  # 블러가 잘리지 않을 만큼 여백
    m = alpha.resize((cut_w, sh_h), Image.BILINEAR)
    canvas = Image.new("L", (cut_w + 2 * pad, sh_h + pad), 0)
    canvas.paste(m, (pad, 0))
    # 출력(x,y) ← 입력(x + shear*y/sh_h - shear, y): y=0(먼 끝)은 -shear, y=sh_h는 0
    canvas = canvas.transform(canvas.size, Image.AFFINE,
                              (1, shear / sh_h, -shear, 0, 1, 0), Image.BILINEAR)
    arr = np.asarray(canvas, dtype=np.float32)
    # 먼 끝(위)일수록 옅게 — 실루엣이 있는 sh_h 구간에서만 0.12 → 1.0으로 오른다
    fade = np.clip(0.12 + 0.88 * np.arange(canvas.height, dtype=np.float32) / sh_h, 0, 1)[:, None]
    out = Image.fromarray((arr * fade).clip(0, 255).astype(np.uint8), "L")
    # 넉넉히 흐리게 — 덜 흐리면 실루엣이 읽혀서 '컵이 두 개'로 보인다(실측)
    return out.filter(ImageFilter.GaussianBlur(max(8.0, cut_h * 0.085))), pad


def _contact_shadow(alpha, cut_w: int, cut_h: int):
    """접지 그림자 — 물체가 '바닥에 붙어' 보이게 하는 좁고 진한 그늘.

    바닥으로 갈수록 세지는 램프를 실루엣에 곱한 뒤 통째로 눌러 만든다. 예전에는
    알파의 아래 15%를 '잘라' 썼는데, 자른 자리에 딱딱한 가로선이 생겨 접시 밑에
    회색 사각형이 깔렸다(실측 — 합성이 가장 어색해 보이던 원인).
    """
    import numpy as np
    from PIL import Image, ImageFilter

    a = np.asarray(alpha, dtype=np.float32)
    t = np.linspace(0.0, 1.0, a.shape[0], dtype=np.float32)
    ramp = np.clip((t - 0.78) / 0.22, 0, 1) ** 2  # 위쪽은 0에서 부드럽게 올라온다
    m = Image.fromarray((a * ramp[:, None]).clip(0, 255).astype(np.uint8), "L")
    fh = max(10, int(cut_h * 0.075))
    m = m.resize((max(1, int(cut_w * 0.96)), fh), Image.BILINEAR)
    # 블러를 세로로만 크게 주고 싶지만 PIL은 등방성이라, 바닥에 딱 붙는 느낌을 위해
    # 살짝만 흐린다 — 넓게 퍼뜨리면 '먼지 얼룩'이 되고 접지감이 되레 사라진다.
    return m.filter(ImageFilter.GaussianBlur(max(3.0, fh * 0.32)))


def _draw_shadows(canvas, cut, x: int, y: int, light_x: float) -> None:
    """접지 그림자 + 눕힌 그림자. 순수 검정 대신 살짝 따뜻한 흑갈색을 쓴다(CG 티 방지)."""
    from PIL import Image

    alpha = cut.split()[-1]
    cw, ch = cut.size
    ink = (28, 22, 18)

    # 눕힌 그림자 — 같은 조명 아래 있다는 신호
    mask, pad = _cast_shadow(alpha, light_x, cw, ch)
    lay = Image.new("RGBA", mask.size, ink + (0,))
    lay.putalpha(mask.point(lambda v: int(v * 0.22)))
    canvas.alpha_composite(lay, (x - pad + int(light_x * cw * 0.10), y + ch - mask.height + pad))

    # 접지 그림자 — 좁고 진하게. '붙어 있다'는 느낌은 이게 만든다
    foot = _contact_shadow(alpha, cw, ch)
    lay2 = Image.new("RGBA", foot.size, ink + (0,))
    lay2.putalpha(foot.point(lambda v: int(v * 0.78)))
    # 그림자 중심을 바닥선보다 살짝 위로 올려, 물체 밑에서 시작하게 한다
    canvas.alpha_composite(lay2, (x + (cw - foot.width) // 2, y + ch - int(foot.height * 0.62)))


def _draw_reflection(canvas, cut, x: int, y: int, gloss: float) -> None:
    """매끈한 상판(대리석·스튜디오)에 옅은 반사 — 제품 사진의 전형적인 문법."""
    if gloss < 0.05:
        return
    import numpy as np
    from PIL import Image, ImageChops, ImageFilter

    cw, ch = cut.size
    rh = max(8, int(ch * 0.26))
    ref = cut.transpose(Image.FLIP_TOP_BOTTOM).crop((0, 0, cw, rh))  # 물체의 아랫부분
    ref = ref.resize((cw, max(4, int(rh * 0.45))), Image.BILINEAR)  # 원근으로 눌린 모양
    grad = np.linspace(gloss * 0.40, 0.0, ref.height, dtype=np.float32)[:, None]
    grad = np.repeat(grad, ref.width, axis=1)
    fade = Image.fromarray((grad * 255).clip(0, 255).astype(np.uint8), "L")
    ref.putalpha(ImageChops.multiply(ref.split()[-1], fade))
    ref = ref.filter(ImageFilter.GaussianBlur(max(4.0, ch * 0.020)))
    canvas.alpha_composite(ref, (x, y + ch))


def _light_wrap(cut, bg_region, amount: float = 0.25):
    """배경빛이 피사체 가장자리를 감싸게 — 서로 다른 출처를 한 공간으로 묶는 단서.

    가장자리 안쪽에만 배경의 흐린 색을 스크린 합성해, 밝은 창가 배경이면 컵 테두리도
    같이 밝아지게 한다. 실제 사진에서 늘 일어나는 일이라, 이게 없으면 아무리 그림자를
    잘 깔아도 '따로 노는' 느낌이 남는다.
    """
    import numpy as np
    from PIL import Image, ImageChops, ImageFilter

    a = cut.split()[-1]
    r = max(3.0, cut.height * 0.02)
    band = ImageChops.subtract(a, a.filter(ImageFilter.GaussianBlur(r)))  # 경계 안쪽 띠
    w = np.asarray(band, dtype=np.float32) / 255.0 * amount

    sub = np.asarray(cut.convert("RGB"), dtype=np.float32)
    env = np.asarray(bg_region.convert("RGB").filter(ImageFilter.GaussianBlur(r * 2)),
                     dtype=np.float32)
    screen = 255.0 - (255.0 - sub) * (255.0 - env) / 255.0  # 어두운 배경은 어둡게 만들지 않음
    out = (sub + (screen - sub) * w[..., None]).clip(0, 255).astype(np.uint8)
    return Image.fromarray(np.dstack([out, np.asarray(a, dtype=np.uint8)]), "RGBA")


def _harmonize_color(cut, bg_region, strength: float = 0.35, cap: float = 14.0):
    """색 조화 — 피사체의 화이트밸런스·노출을 '놓일 자리'의 배경 톤 쪽으로 살짝 당긴다.

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


def _relight(cut, light_x: float, strength: float = 0.13):
    """피사체에 새 장면의 광원 방향을 입힌다 — 밝은 쪽과 그늘 쪽을 만들어 준다.

    사장님 사진은 대개 천장 형광등 평면광이라 좌우 명암차가 없다. 배경은 창가 측광인데
    피사체만 평평하면 사람은 그걸 '조명이 다른 사진 두 장'으로 읽는다. 그림자가 눕는
    방향(light_x)의 반대쪽이 광원이므로 그쪽을 밝히고 반대쪽을 누른다.

    [주의] 여기서 림라이트(가장자리 밝히기)를 따로 넣지 않는다. 배경빛을 가장자리에
    입히는 일은 _light_wrap이 이미 하고 있어서, 둘을 같이 걸면 피사체 둘레에 흰 테두리가
    생겨 오히려 오려 붙인 티가 난다(실측 — 케이크 둘레가 흰 실루엣으로 떴다).
    """
    import numpy as np
    from PIL import Image

    w = cut.width
    lit = -1.0 if light_x >= 0 else 1.0  # +1이면 오른쪽이 밝다
    g = np.linspace(-1.0, 1.0, w, dtype=np.float32)[None, :] * lit
    rgb = np.asarray(cut.convert("RGB"), dtype=np.float32) * (1.0 + g[..., None] * strength)

    out = Image.fromarray(rgb.clip(0, 255).astype(np.uint8), "RGB").convert("RGBA")
    out.putalpha(cut.split()[-1])
    return out


def _detail(im) -> float:
    """대략의 선명도 — 원본에서 흐린 판을 뺀 고주파 성분의 표준편차."""
    import numpy as np
    from PIL import ImageFilter

    g = im.convert("L")
    hi = np.asarray(g, dtype=np.float32) - np.asarray(g.filter(ImageFilter.GaussianBlur(1.4)),
                                                      dtype=np.float32)
    return float(hi.std())


def _match_sharpness(cut, bg_region):
    """피사체를 배경의 선명도 쪽으로 당긴다.

    배경은 얕은 심도로 녹아 있는데 피사체만 칼같이 선명하면, 그림자를 아무리 잘 깔아도
    '나중에 얹은 것'으로 보인다. 반대로 흐린 사진을 억지로 선명하게 만들지는 않는다 —
    없는 디테일은 만들어 낼 수 없고, 만들려 하면 윤곽에 흰 테두리만 생긴다.
    """
    from PIL import Image, ImageFilter

    sub, bg = _detail(cut), _detail(bg_region)
    if bg <= 0.1 or sub <= bg * 1.9:
        return cut
    # 배경의 1.9배까지만 허용하고 초과분만큼 아주 약하게 푼다 (최대 1.2px)
    radius = min(1.2, 0.35 * (sub / (bg * 1.9) - 1.0) + 0.25)
    a = cut.split()[-1]
    out = cut.convert("RGB").filter(ImageFilter.GaussianBlur(radius)).convert("RGBA")
    out.putalpha(a)  # 알파는 그대로 — 실루엣까지 흐려지면 안 된다
    return out


def _finish_subject(cut):
    """메뉴가 먹음직해 보이도록 — 약한 언샵·채도. 과하면 곧바로 '보정 티'가 난다."""
    from PIL import Image, ImageEnhance, ImageFilter

    rgb = cut.convert("RGB").filter(ImageFilter.UnsharpMask(radius=2, percent=32, threshold=4))
    rgb = ImageEnhance.Color(rgb).enhance(1.08)
    out = ImageEnhance.Contrast(rgb).enhance(1.03).convert("RGBA")
    out.putalpha(cut.split()[-1])
    return out


def _unify_grade(im, cx: float = 0.5, cy: float = 0.55):
    """완성본 전체에 공통 레이어를 한 번 덮어 하나처럼 묶는다.

    피사체와 배경이 같은 톤 커브·블룸·비네트·그레인을 공유하면 서로 다른 출처(실물
    사진 vs AI 배경)의 이질감이 크게 줄어든다. 비네트는 피사체 위치를 중심으로 건다.
    """
    import numpy as np
    from PIL import Image, ImageFilter

    im = im.convert("RGB")
    W, H = im.size
    arr = np.asarray(im, dtype=np.float32)

    # ⓐ 아주 옅은 따뜻한 틴트 — 같은 광원 아래 있는 느낌
    arr[..., 0] *= 1.015  # R ↑
    arr[..., 2] *= 0.985  # B ↓

    # ⓑ 하이라이트 블룸 — 밝은 부분이 살짝 번지면 '카페에서 찍은 사진'의 공기감이 산다
    hi = np.clip(arr.max(axis=2) - 205.0, 0, 50) / 50.0
    bloom = np.asarray(
        Image.fromarray((hi * 255).astype(np.uint8), "L").filter(ImageFilter.GaussianBlur(H * 0.02)),
        dtype=np.float32) / 255.0
    arr += bloom[..., None] * 26.0

    # ⓒ 부드러운 S 커브 — 붙인 요소들을 같은 톤 커브 위에 올린다
    n = arr / 255.0
    arr = (n + 0.06 * n * (1.0 - n) * (2.0 * n - 1.0) * 2.0) * 255.0

    # ⓓ 비네트 — 가장자리를 눌러 피사체로 시선을 모으고 프레임을 하나로
    ys = (np.arange(H, dtype=np.float32)[:, None] - cy * H) / (H * 0.78)
    xs = (np.arange(W, dtype=np.float32)[None, :] - cx * W) / (W * 0.78)
    r = np.sqrt(xs * xs + ys * ys)
    arr *= np.clip(1.0 - (r - 0.65) * 0.30, 0.84, 1.0)[..., None]

    # ⓔ 미세 그레인 — 실물/AI의 노이즈 특성 차이를 덮어 경계감을 흐린다
    arr += np.random.default_rng().standard_normal((H, W, 1), dtype=np.float32) * 1.8
    return Image.fromarray(arr.clip(0, 255).astype(np.uint8), "RGB")


def _composite(cut, bg, surface: float, gloss: float):
    """피사체를 배경 상판 위에 앉힌다 — 심도·배치·그림자·빛 감싸기·그레이딩."""
    from PIL import Image

    W, H = bg.size

    # 배치: 상판 위에 앉히고, 상판까지의 공간과 화면 폭에 맞춰 크기를 정한다.
    # (화면의 62%·72%까지 키웠더니 배경이 안 보여 '왜 이 배경을 골랐는지'가 사라졌다.
    #  여백이 있어야 광고 컷처럼 보인다)
    foot_y = int(H * surface)
    scale = min(min(H * 0.52, foot_y * 0.72) / cut.height, (W * 0.62) / cut.width)
    cut = cut.resize((max(1, round(cut.width * scale)), max(1, round(cut.height * scale))),
                     Image.LANCZOS)
    x = (W - cut.width) // 2
    y = max(0, foot_y - cut.height)

    cx, cy = 0.5, (y + cut.height * 0.55) / H
    bg = _depth_blur(bg, surface)
    bg = _light_pool(bg, cx, cy)
    light_x = _light_dir(bg)

    # 피사체: 경계 색 정리 → 배경 톤 매칭 → 빛 감싸기 → 광원 방향 입히기 → 마무리 →
    # 배경 선명도에 맞추기 (마지막이어야 앞 단계가 만든 대비까지 같이 눌린다)
    cut = _decontaminate(cut)
    region = bg.crop((x, y, x + cut.width, y + cut.height))
    cut = _harmonize_color(cut, region)
    cut = _light_wrap(cut, region)
    cut = _relight(cut, light_x)
    cut = _finish_subject(cut)
    cut = _match_sharpness(cut, region)

    canvas = bg.convert("RGBA")
    _draw_reflection(canvas, cut, x, y, gloss)
    _draw_shadows(canvas, cut, x, y, light_x)
    canvas.alpha_composite(cut, (x, y))
    return _unify_grade(canvas.convert("RGB"), cx, cy)


def _retouch(src, w: int, h: int):
    """합성을 포기하고 원본을 살린다 — 비율 크롭 + 감성 보정.

    매장 내부 사진처럼 '오려낼 물건'이 없는 사진에 억지로 누끼를 뜨면, 벽 한 조각이
    테이블 위에 떠 있는 결과가 나온다. 그럴 바엔 원본 그대로가 훨씬 낫다.
    """
    import io as _io

    buf = _io.BytesIO()
    src.convert("RGB").save(buf, "JPEG", quality=95)
    # 지킬 상판이 없으니 가운데를 남긴다 (합성 경로의 아래쪽 우선 크롭과 다른 점)
    im, _s = _cover_crop(buf.getvalue(), w, h, 0.8, anchor=0.5)
    return _unify_grade(_finish_subject(im.convert("RGBA")).convert("RGB"))


def _finish(final, store_id: str, aspect_ratio: str, style: str, provider: str,
            note: str, doc: Optional[dict[str, Any]], doc_id: str) -> dict[str, Any]:
    """완성 이미지를 저장하고 기존 이미지 엔트리와 같은 형태로 돌려준다.

    JPEG로 저장한다 — 같은 합성본이 PNG 3.1MB vs JPEG q92 0.5MB(실측)로, 사장님이
    체감하는 지연의 대부분이 이 다운로드였다. 사진 합성물이라 화질 차이는 안 보인다.
    """
    from app.services.ai import document_service
    from app.services.ai import marketing_service as M

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
        "provider": provider,  # 사진 편집 / 누끼+배경 합성 / 보정만
        "prompt": "",
        "note": note,
    }
    if doc:
        images = list(doc["content"].get("images") or [])
        images.append(entry)
        doc["content"]["images"] = images
        doc = document_service.update_document(store_id, doc_id, doc["content"])
    return {**entry, "doc": doc}


def compose_from_photo(store_id: str, photo_bytes: bytes, style: str = "wood",
                       aspect_ratio: str = "1:1", doc_id: str = "") -> dict[str, Any]:
    """실물 메뉴 사진 → 홍보 이미지 → 저장. 반환은 기존 이미지 엔트리와 같은 형태.

    경로:
      ① 누끼 + 배경 합성  — 기본값. 무료·3초
      ② 사진 편집(kontext) — PHOTO_EDIT_AI=1일 때만. 품질 최상·유료(0.04/장)·14초.
                            실패하면 조용히 ①로 되돌아간다
      ③ 보정만            — 오려낼 메뉴가 뚜렷하지 않은 사진(매장 전경 등)

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

    if style not in BACKGROUND_STYLES:
        style = "wood"

    import os

    w, h = M._AR_SIZES.get(aspect_ratio, (1472, 1472))
    cut, src, stats = _cutout(photo_bytes)

    if stats["compositable"] and os.getenv("PHOTO_EDIT_AI", "0") == "1":
        # 사진 편집 경로 — 원근·조명·그림자가 처음부터 하나로 맞는다. 여기서만
        # 사장님 사진이 '원래 그 자리에 있던 사진'처럼 나온다.
        try:
            buf = io.BytesIO()
            src.save(buf, "JPEG", quality=90)  # EXIF 반영·2048 축소본을 보낸다
            raw, model = _ai_edit(buf.getvalue(), style)
            final = _extend_to_ratio(raw, w, h)
            return _finish(final, store_id, aspect_ratio, style,
                           f"photo_ai_edit({model})", "", doc, doc_id)
        except Exception as e:
            # 잔액 부족·타임아웃·모델 오류 — 아래 오려붙이기 경로로 되돌린다.
            # 이 경로가 죽어도 홍보 이미지는 항상 나온다.
            logger.warning("[사진 합성] 편집 경로 실패 → 오려붙이기로 폴백: %s", e)

    if not stats["compositable"]:
        # 배경 캐시는 계속 데워 둔다 — 다음 사진은 합성될 수 있다
        _refresh_bg_async(style, aspect_ratio)
        final = _retouch(src, w, h)
        provider = "photo_retouch"
        note = "메뉴 하나만 담긴 사진이 아니라, 배경을 바꾸지 않고 사진만 예쁘게 다듬었어요."
        logger.info("[사진 합성] 오려낼 피사체가 뚜렷하지 않음(coverage=%.3f, edges=%d) → 보정만",
                    stats["coverage"], stats["edges"])
    else:
        bg, bg_provider, surface = _background(style, aspect_ratio)
        final = _composite(cut, bg, surface, float(BACKGROUND_STYLES[style]["gloss"]))
        provider, note = f"photo_composite({bg_provider})", ""

    return _finish(final, store_id, aspect_ratio, style, provider, note, doc, doc_id)


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
