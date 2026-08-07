"""홍보 이미지 생성 — 공급자 구성과 대기 시간 상한

사장님이 버튼을 누르고 실제로 기다리는 시간이라, '공급자당 몇 초'가 아니라
'전부 합쳐 몇 초'가 지켜져야 한다. 90초를 주면 느린 날엔 정말 90초를 기다리다
앱을 닫는다 — 넘기면 끊고 다시 누르게 하는 편이 대개 더 빠르다.
"""
import time

import pytest

from app.services.ai import marketing_service as M


def test_gemini_is_not_in_the_default_chain():
    """무료 키에서 이미지 모델 한도가 0이라 반드시 실패하던 왕복을 뺐다."""
    assert M.IMAGE_PROVIDERS == ["pollinations"]


def test_default_timeout_is_15_seconds():
    assert M.IMAGE_TIMEOUT == 15.0


def test_whole_chain_stops_at_the_deadline(monkeypatch):
    """공급자를 여러 개 걸어도 합계가 상한을 넘지 않는다."""
    monkeypatch.setattr(M, "IMAGE_PROVIDERS", ["pollinations", "gemini"])
    monkeypatch.setattr(M, "IMAGE_TIMEOUT", 2.0)

    def slow(*a, **kw):
        # 넘겨받은 남은 시간만큼만 쓰고 실패하는 공급자
        time.sleep(kw.get("timeout", 2.0))
        raise M.MarketingError("느림")

    monkeypatch.setattr(M, "_pollinations_generate", slow)
    monkeypatch.setattr(M, "_gemini_image", slow)

    started = time.monotonic()
    _image, _mime, provider, _meta = M._generate_image_bytes("prompt", "1:1", "standard")
    elapsed = time.monotonic() - started

    # 예전처럼 공급자마다 2초씩이면 4초가 걸린다 — 합계 상한이라 2초 안에서 끝나야 한다
    assert provider == "local-bundled"
    assert elapsed <= 2.0, f"{elapsed:.1f}초 걸림 — 합계 상한이 안 지켜진다"


def test_remaining_budget_is_passed_down(monkeypatch):
    """두 번째 공급자는 '남은 시간'을 받는다 — 상한을 새로 받아 가면 두 배가 된다."""
    monkeypatch.setattr(M, "IMAGE_PROVIDERS", ["pollinations", "gemini"])
    monkeypatch.setattr(M, "IMAGE_TIMEOUT", 10.0)
    seen = []

    def first(*a, **kw):
        seen.append(kw["timeout"])
        time.sleep(0.4)
        raise M.MarketingError("실패")

    def second(*a, **kw):
        seen.append(kw["timeout"])
        return b"img", "image/png", {"model": "x"}

    monkeypatch.setattr(M, "_pollinations_generate", first)
    monkeypatch.setattr(M, "_gemini_image", second)

    image, mime, provider, meta = M._generate_image_bytes("prompt", "1:1", "standard")

    assert provider == "gemini" and image == b"img"
    # 로컬 폴백 몫(_LOCAL_FALLBACK_RESERVE)을 뺀 나머지가 첫 공급자에게 간다
    assert seen[0] == pytest.approx(10.0 - M._LOCAL_FALLBACK_RESERVE, abs=0.2)
    assert seen[1] < seen[0], "두 번째 공급자가 남은 시간이 아니라 상한을 새로 받았다"


def test_provider_is_skipped_when_no_time_left(monkeypatch):
    """시간이 거의 없으면 다음 공급자를 아예 부르지 않는다 — 왕복만 낭비된다."""
    monkeypatch.setattr(M, "IMAGE_PROVIDERS", ["pollinations", "gemini"])
    monkeypatch.setattr(M, "IMAGE_TIMEOUT", 2.5)
    called = []

    def burn(*a, **kw):
        time.sleep(1.2)
        raise M.MarketingError("실패")

    def should_not_run(*a, **kw):
        called.append(True)
        return b"x", "image/png", {"model": "x"}

    monkeypatch.setattr(M, "_pollinations_generate", burn)
    monkeypatch.setattr(M, "_gemini_image", should_not_run)

    _image, _mime, provider, _meta = M._generate_image_bytes("prompt", "1:1", "standard")

    assert not called, "남은 시간이 1초 미만인데 다음 공급자를 불렀다"
    assert provider == "local-bundled"


# ---------------------------------------------------------------------------
# 15초 장담 — 공급자가 어떻게 죽든 상한 안에 이미지가 나온다
#
# 생성 공급자는 남의 서버라 응답 시간을 우리가 정할 수 없다. 그래서 마지막에
# 네트워크를 타지 않는 로컬 배경을 둔다. 아래가 그 약속을 잠근다.
# ---------------------------------------------------------------------------

def _hangs(*a, **kw):
    """상한을 통째로 먹어치우는 공급자 — 실제 지연을 흉내낸다."""
    time.sleep(kw.get("timeout", 99))
    raise M.MarketingError("응답 없음")


@pytest.mark.parametrize("aspect_ratio", ["1:1", "9:16", "16:9"])
def test_image_always_returned_within_the_cap(monkeypatch, aspect_ratio):
    """공급자가 끝까지 안 돌아와도 상한 안에 이미지가 나온다."""
    monkeypatch.setattr(M, "IMAGE_TIMEOUT", 4.0)
    monkeypatch.setattr(M, "_pollinations_generate", _hangs)

    started = time.monotonic()
    image, mime, provider, meta = M._generate_image_bytes("prompt", aspect_ratio, "high")
    elapsed = time.monotonic() - started

    assert image and len(image) > 1000        # 진짜 이미지 바이트다
    assert mime == "image/jpeg"
    assert provider == "local-bundled"        # AI 생성물이 아님이 드러난다
    assert elapsed <= 4.0, f"{elapsed:.1f}초 — 상한을 넘겼다"


def test_provider_crash_also_yields_an_image(monkeypatch):
    """지연이 아니라 예외로 죽어도 마찬가지다 (키 거부·402 등)."""
    def boom(*a, **kw):
        raise M.MarketingError("Pollinations API 키가 거부됐습니다")

    monkeypatch.setattr(M, "_pollinations_generate", boom)

    image, _mime, provider, _meta = M._generate_image_bytes("prompt", "1:1", "standard")

    assert image and provider == "local-bundled"


def test_local_fallback_can_be_turned_off(monkeypatch):
    """끄면 예전처럼 에러를 던진다 — 폴백을 원치 않는 배포를 위해 남긴다."""
    monkeypatch.setattr(M, "LOCAL_IMAGE_FALLBACK", False)
    monkeypatch.setattr(M, "_pollinations_generate",
                        lambda *a, **kw: (_ for _ in ()).throw(M.MarketingError("실패")))

    with pytest.raises(M.ImageCapacityError):
        M._generate_image_bytes("prompt", "1:1", "standard")


def test_local_background_survives_missing_assets(monkeypatch):
    """번들 파일이 하나도 없어도 그라데이션으로 이미지를 만든다 — 여기서 실패하면 약속이 깨진다."""
    monkeypatch.setattr(M, "_LOCAL_BG_DIR", "/definitely/not/here")

    image, mime = M._local_background("1:1", "standard")

    assert image and len(image) > 1000 and mime == "image/jpeg"


def test_successful_provider_is_not_replaced_by_fallback(monkeypatch):
    """공급자가 성공하면 그 이미지를 그대로 쓴다 — 폴백이 끼어들면 안 된다."""
    monkeypatch.setattr(M, "_pollinations_generate", lambda *a, **kw: (b"real-ai-bytes", "image/png", {"model": "zimage", "seed": 1}))

    image, mime, provider, meta = M._generate_image_bytes("prompt", "1:1", "standard")

    assert (image, mime, provider) == (b"real-ai-bytes", "image/png", "pollinations")
    assert meta["model"] == "zimage"   # 팀원이 넣은 모델·seed 추적이 그대로 흐른다


# ---------------------------------------------------------------------------
# 모델 폴백(zimage → klein)도 같은 예산 안에서 돈다
#
# 팀원이 넣은 모델 교체가 실질적인 폴백이다(gemini는 유료 키가 없으면 안 돈다).
# 모델마다 상한을 새로 주면 15초가 30초가 되므로, 남은 예산을 나눠 쓰는지 잠근다.
# ---------------------------------------------------------------------------

def test_model_fallback_shares_one_budget(monkeypatch):
    monkeypatch.setattr(M, "POLLINATIONS_MODEL", "zimage")
    monkeypatch.setattr(M, "POLLINATIONS_FALLBACK_MODEL", "klein")
    seen = []

    def once(prompt, model, w, h, token, budget=None):
        seen.append((model, budget))
        time.sleep(0.3)
        raise M.MarketingError(f"{model} 실패")

    monkeypatch.setattr(M, "_pollinations_once", once)

    with pytest.raises(M.MarketingError):
        M._pollinations_generate("prompt", "1:1", "standard", timeout=5.0)

    assert [m for m, _ in seen] == ["zimage", "klein"]
    assert seen[0][1] == pytest.approx(5.0, abs=0.2)
    assert seen[1][1] < seen[0][1], "두 번째 모델이 남은 예산이 아니라 상한을 새로 받았다"


def test_model_fallback_stops_when_budget_is_gone(monkeypatch):
    """예산이 바닥나면 대체 모델을 아예 부르지 않는다."""
    monkeypatch.setattr(M, "POLLINATIONS_MODEL", "zimage")
    monkeypatch.setattr(M, "POLLINATIONS_FALLBACK_MODEL", "klein")
    seen = []

    def once(prompt, model, w, h, token, budget=None):
        seen.append(model)
        time.sleep(1.3)
        raise M.MarketingError("느림")

    monkeypatch.setattr(M, "_pollinations_once", once)

    with pytest.raises(M.MarketingError):
        M._pollinations_generate("prompt", "1:1", "standard", timeout=1.6)

    assert seen == ["zimage"], f"예산이 없는데 대체 모델을 불렀다: {seen}"


def test_hard_fail_skips_model_fallback(monkeypatch):
    """잔액·키 문제는 모델을 바꿔도 똑같다 — 팀원이 넣은 즉시 실패가 유지된다."""
    monkeypatch.setattr(M, "POLLINATIONS_MODEL", "zimage")
    monkeypatch.setattr(M, "POLLINATIONS_FALLBACK_MODEL", "klein")
    seen = []

    def once(prompt, model, w, h, token, budget=None):
        seen.append(model)
        raise M._PollinationsHardFail("키가 거부됐습니다")

    monkeypatch.setattr(M, "_pollinations_once", once)

    with pytest.raises(M._PollinationsHardFail):
        M._pollinations_generate("prompt", "1:1", "standard", timeout=10.0)

    assert seen == ["zimage"]


# ---------------------------------------------------------------------------
# 정교화도 벽시계 상한 안에서 돈다
#
# REFINE_TIMEOUT은 HTTP 한 번의 제한이라 재시도·폴백이 겹치면 생성 시작 전에
# 수십 초가 샌다. 사장님 대기는 '정교화 + 생성' 합계다 — 여기서 잠근다.
# ---------------------------------------------------------------------------

def test_refine_respects_wall_clock_budget(monkeypatch):
    """정교화가 안 끝나면 상한에서 끊고 원본 아이디어로 진행한다."""
    monkeypatch.setattr(M, "REFINE_BUDGET", 0.5)

    def slow_refine(idea, style, aspect_ratio, layout):
        time.sleep(5)
        return "너무 늦게 온 답"

    monkeypatch.setattr(M, "_refine_image_prompt", slow_refine)

    started = time.monotonic()
    result = M._refine_with_budget("라떼 클로즈업", "", "1:1", "bottom")
    elapsed = time.monotonic() - started

    assert result == "라떼 클로즈업", "상한을 넘겼으면 원본 아이디어를 써야 한다"
    assert elapsed < 1.5, f"{elapsed:.1f}초 — 정교화 상한이 안 지켜진다"


def test_refine_result_is_used_when_fast(monkeypatch):
    """상한 안에 끝나면 정교화 결과를 그대로 쓴다."""
    monkeypatch.setattr(M, "_refine_image_prompt",
                        lambda *a: "a refined english art direction prompt")

    assert M._refine_with_budget("라떼", "", "1:1", "bottom") == \
        "a refined english art direction prompt"


def test_refine_budget_skips_when_disabled(monkeypatch):
    """PROMPT_REFINE=0이면 스레드도 띄우지 않고 원본을 돌려준다."""
    monkeypatch.setattr(M, "PROMPT_REFINE", False)
    monkeypatch.setattr(M, "_refine_image_prompt",
                        lambda *a: (_ for _ in ()).throw(AssertionError("불리면 안 된다")))

    assert M._refine_with_budget("라떼", "", "1:1", "bottom") == "라떼"


# ---------------------------------------------------------------------------
# 화면비 강제 — 공급자가 요청 해상도를 무시해도 비율이 맞은 이미지가 나간다
#
# 실측: flux는 width/height를 무시하고 1024×1088 근처만 돌려준다. 그대로 내보내면
# 4:5 피드·16:9 배너 자리에서 잘리거나 찌그러진다.
# ---------------------------------------------------------------------------

def _png(w, h):
    from io import BytesIO

    from PIL import Image

    buf = BytesIO()
    Image.new("RGB", (w, h), (120, 90, 60)).save(buf, "PNG")
    return buf.getvalue()


def test_wrong_aspect_is_center_cropped():
    """16:9를 시켰는데 정방형이 오면 16:9로 잘라 돌려준다."""
    from io import BytesIO

    from PIL import Image

    fixed, mime = M._enforce_aspect(_png(1024, 1088), "image/png", "16:9")

    im = Image.open(BytesIO(fixed))
    assert mime == "image/jpeg"
    assert abs(im.width / im.height - 16 / 9) / (16 / 9) <= 0.02, \
        f"{im.width}×{im.height} — 화면비가 안 맞는다"


def test_correct_aspect_passes_through_untouched():
    """비율이 이미 맞으면(2% 이내) 재인코딩 없이 원본 바이트 그대로다."""
    original = _png(1472, 1472)

    fixed, mime = M._enforce_aspect(original, "image/png", "1:1")

    assert fixed is original and mime == "image/png"


def test_undecodable_bytes_pass_through():
    """디코드가 안 되는 바이트는 원본을 그대로 돌려준다 — 여기서 죽으면 안 된다."""
    fixed, mime = M._enforce_aspect(b"not-an-image", "image/png", "4:5")

    assert (fixed, mime) == (b"not-an-image", "image/png")


def test_provider_chain_applies_aspect_enforcement(monkeypatch):
    """공급자 성공 경로에서 화면비 보정이 실제로 걸린다."""
    from io import BytesIO

    from PIL import Image

    monkeypatch.setattr(M, "_pollinations_generate",
                        lambda *a, **kw: (_png(1024, 1088), "image/png",
                                          {"model": "flux", "seed": 7}))

    image, _mime, provider, meta = M._generate_image_bytes("prompt", "16:9", "high")

    im = Image.open(BytesIO(image))
    assert provider == "pollinations" and meta["seed"] == 7
    assert abs(im.width / im.height - 16 / 9) / (16 / 9) <= 0.02
