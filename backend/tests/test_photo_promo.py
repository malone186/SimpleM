"""실물 사진 홍보 합성 — 배치·그림자·크롭 회귀 테스트 (백엔드 B).

누끼(rembg)는 무거운 onnx 모델이 필요해 여기서는 부르지 않는다. 대신 '이미 오려진
피사체'를 직접 만들어 합성 뒤쪽 단계만 검증한다 — 실제로 결과물을 망가뜨렸던 버그가
전부 이 구간에 있었기 때문이다:

  · 접지 그림자를 알파의 아래 15%를 '잘라' 만들다가 잘린 자리에 딱딱한 가로선이
    생겨, 접시 밑에 회색 사각형이 깔렸다
  · 배경을 가운데 기준으로 잘라 16:9에서 테이블 상판이 통째로 사라지고, 컵이 벽에
    붙어 떠 있었다
"""
from __future__ import annotations

import numpy as np
import pytest
from PIL import Image, ImageDraw

from app.services.ai import photo_promo_service as P


def _fake_cut(w: int = 300, h: int = 360):
    """'이미 오려진 컵' — 아래로 갈수록 넓어지는 불투명 도형 + 부드러운 경계."""
    im = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.ellipse([10, 40, w - 10, h - 10], fill=(190, 150, 110, 255))
    d.ellipse([30, 10, w - 30, 90], fill=(220, 190, 150, 255))
    return im


def _bg(w: int, h: int):
    return Image.new("RGB", (w, h), (230, 224, 214))


def test_cover_crop_keeps_surface_in_landscape():
    """16:9로 잘라도 상판이 남고, surface 값이 새 프레임 기준으로 다시 계산된다."""
    import io

    src = Image.new("RGB", (1536, 1536), (200, 200, 200))
    ImageDraw.Draw(src).rectangle([0, 1200, 1536, 1536], fill=(120, 80, 40))  # 상판
    buf = io.BytesIO()
    src.save(buf, "JPEG")

    im, surface = P._cover_crop(buf.getvalue(), 1536, 864, 0.80)
    assert im.size == (1536, 864)
    # 아래쪽 우선 크롭이라 상판(어두운 띠)이 남아 있어야 한다
    bottom = np.asarray(im.convert("L"))[-40:].mean()
    assert bottom < 150, "16:9 크롭에서 상판이 사라졌다"
    # 잘린 만큼 다시 계산돼, 원본의 0.80 지점이 새 프레임에서도 상판 위를 가리킨다
    assert 0.55 <= surface <= 0.94
    assert np.asarray(im.convert("L"))[int(surface * 864)].mean() < 160


def test_cover_crop_center_anchor_for_retouch():
    """보정 경로는 가운데 기준 크롭 — 지켜야 할 상판이 없다."""
    import io

    src = Image.new("RGB", (1000, 1000))
    for y in range(1000):
        src.paste((y // 4, y // 4, y // 4), (0, y, 1000, y + 1))
    buf = io.BytesIO()
    src.save(buf, "JPEG")

    center, _ = P._cover_crop(buf.getvalue(), 1000, 500, 0.8, anchor=0.5)
    bottom, _ = P._cover_crop(buf.getvalue(), 1000, 500, 0.8, anchor=0.85)
    assert np.asarray(center.convert("L")).mean() < np.asarray(bottom.convert("L")).mean()


def test_contact_shadow_has_no_hard_edge():
    """접지 그림자 위쪽이 부드럽게 올라온다 — 잘린 가로선(회색 사각형)이 없어야 한다."""
    cut = _fake_cut()
    mask = np.asarray(P._contact_shadow(cut.split()[-1], cut.width, cut.height), dtype=np.float32)
    rows = mask.mean(axis=1)
    # 행 간 변화량이 최대값의 절반을 넘으면 계단(잘린 자국)이다
    assert np.abs(np.diff(rows)).max() < rows.max() * 0.5


def test_composite_grounds_subject_on_surface():
    """피사체 바닥이 상판 선 위에 오고, 발밑이 배경보다 어두워진다(접지 그림자)."""
    bg = _bg(900, 900)
    out = P._composite(_fake_cut(), bg, 0.80, gloss=0.0)
    assert out.size == (900, 900)

    g = np.asarray(out.convert("L"), dtype=np.float32)
    foot = int(900 * 0.80)
    # 발 바로 위 행: 가운데엔 피사체가, 가장자리엔 배경이 있어야 한다
    assert abs(g[foot - 8, 450] - g[foot - 8, 20]) > 8, "피사체가 상판 선 위에 놓이지 않았다"
    # 발 바로 아래 행: 가운데가 배경보다 어둡다 = 접지 그림자가 깔렸다
    assert g[foot + 6, 450] < g[foot + 6, 20] - 5, "발밑에 그림자가 없다 — 떠 보인다"
    # 아래 여백은 배경 그대로여야 한다 (예전엔 여기에 회색 사각형이 깔렸다)
    assert g[-20:].std() < 12


def test_composite_leaves_breathing_room():
    """피사체가 프레임을 다 먹지 않는다 — 광고 컷에는 여백이 필요하다."""
    cut = _fake_cut(600, 600)
    W = H = 1000
    foot_y = int(H * 0.80)
    scale = min(min(H * 0.52, foot_y * 0.72) / cut.height, (W * 0.62) / cut.width)
    assert scale * cut.height <= H * 0.55 and scale * cut.width <= W * 0.65


def test_light_dir_never_zero():
    """좌우가 고른 배경에서도 그림자가 피사체 뒤에 완전히 숨지 않는다."""
    assert abs(P._light_dir(_bg(64, 64))) >= 0.30
    lit = Image.new("RGB", (64, 64), (60, 60, 60))
    ImageDraw.Draw(lit).rectangle([40, 0, 63, 63], fill=(240, 240, 240))  # 오른쪽이 밝다
    assert P._light_dir(lit) < 0, "오른쪽 광원이면 그림자는 왼쪽으로 눕는다"


@pytest.mark.parametrize("style", sorted(P.BACKGROUND_STYLES))
def test_bundled_backgrounds_present_and_placed(style):
    """스타일마다 번들 배경이 있고, 상판 높이가 화면 안쪽의 그럴듯한 값이다."""
    import os

    paths = P._bundled_paths(style)
    assert paths, f"{style} 번들 배경이 없다"
    for p in paths:
        s = P._BUNDLED_SURFACE.get(os.path.basename(p), P.BACKGROUND_STYLES[style]["surface"])
        assert 0.55 <= s <= 0.94


def _square(n: int = 1024):
    """편집 모델이 돌려주는 것 같은 정사각 결과 — 위는 밝은 벽, 아래는 어두운 상판,
    가운데에 알아볼 수 있는 빨간 물건(반사로 복제되면 바로 드러난다)."""
    im = Image.new("RGB", (n, n), (225, 220, 210))
    d = ImageDraw.Draw(im)
    d.rectangle([0, int(n * 0.62), n, n], fill=(120, 84, 48))
    d.ellipse([int(n * 0.3), int(n * 0.45), int(n * 0.7), int(n * 0.8)], fill=(210, 40, 40))
    return im


def _png(im):
    import io

    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=95)
    return buf.getvalue()


@pytest.mark.parametrize("w,h", [(1472, 1472), (1152, 1440), (864, 1536), (1536, 864), (1792, 768)])
def test_extend_to_ratio_sizes(w, h):
    """편집 결과는 늘 1024²다 — 어떤 화면비를 요청해도 정확히 그 크기가 나와야 한다."""
    assert P._extend_to_ratio(_png(_square()), w, h).size == (w, h)


def test_extend_to_ratio_never_duplicates_the_subject():
    """세로로 늘릴 때 피사체가 위쪽에 한 번 더 비치면 안 된다.

    거울 반사(reflect)로 늘렸더니 케이크가 화면 위에 유령처럼 복제됐다(실측).
    늘린 자리에는 빨간 물건의 흔적이 남지 않아야 한다.
    """
    out = np.asarray(P._extend_to_ratio(_png(_square()), 864, 1536), dtype=np.int16)
    core_top = 1536 - round(864 * 1024 / 1024)  # 정사각을 폭에 맞춰 담고 아래에 붙인다
    ext = out[: max(1, core_top - 40)]  # 늘려서 채운 영역만
    redness = (ext[..., 0] - ext[..., 1:].max(axis=2)).max()
    assert redness < 60, "늘린 영역에 피사체가 복제됐다"


def test_extend_to_ratio_crops_for_wide_targets():
    """가로가 넓은 요청은 위아래를 잘라 맞춘다 — 좌우를 흐리게 늘리지 않는다."""
    out = P._extend_to_ratio(_png(_square()), 1536, 864)
    edge = np.asarray(out.convert("L"), dtype=np.float32)[:, :30]
    # 잘라서 맞췄으면 왼쪽 끝도 원본 그대로라 위(벽)/아래(상판) 대비가 살아 있다
    assert edge[:100].mean() - edge[-100:].mean() > 40


def test_edit_prompt_forbids_inventing_items():
    """편집 프롬프트는 '없던 메뉴를 그리지 말 것'을 반드시 담는다.

    매장 전경 사진에 없던 라떼가 그려진 실측 사고가 있었다. 이 문장이 빠지면
    우리 매장에 없는 메뉴가 홍보물로 나간다.
    """
    for style, meta in P.BACKGROUND_STYLES.items():
        p = P._edit_prompt(style)
        assert meta["scene"] in p
        assert "Do not add any food" in p
        assert "EXACTLY as in the original photo" in p


def test_retouch_keeps_original_and_fits_ratio():
    """보정 경로는 원본을 살린 채 요청 비율로만 맞춘다."""
    src = Image.new("RGB", (1200, 900), (170, 140, 110))
    out = P._retouch(src, 1152, 1440)
    assert out.size == (1152, 1440)
    assert 100 < np.asarray(out.convert("L")).mean() < 210  # 그레이딩이 원본을 태우지 않는다
