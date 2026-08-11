"""음성 합성 (백엔드 B) — Gemini TTS로 '진짜 다른' 목소리 4종을 만든다

왜 서버 TTS인가: 기기 내장 TTS(expo-speech·speechSynthesis)는 한국어 보이스가
보통 1개뿐이라, 설정의 목소리 4종을 피치·속도 변형으로만 흉내 냈다 — 극단 피치는
기계음처럼 들리고 "여러 목소리"도 사실상 안 됐다(사장님 실사용 불만).
Gemini TTS는 성별·톤이 실제로 다른 내장 보이스 30여 종을 제공하고, 한국어를
자연스럽게 읽으며, 무료 티어에서 동작함을 실측 확인했다(2026-07-31).

응답은 raw PCM(L16, 24kHz)이라 그대로는 <audio>·expo-audio가 못 읽는다 —
WAV 헤더를 붙여 audio/wav로 돌려준다.

쿼터 절약: 같은 (목소리, 문장)은 uploads/tts/에 WAV로 캐시한다. 설정 화면의
샘플 문장과 반복되는 알림 문구("~ 근무가 완료되었습니다")가 대부분이라 적중률이 높다.

분당 한도: Gemini 무료 티어 TTS는 분당 3회(RPM 3)까지만 합성해 준다. 4번째부터는
구글이 429를 주는데, 그걸 그대로 기다리면 응답이 늦고 팀 공유 키의 쿼터만 축낸다.
그래서 서버가 먼저 세어서 한도를 넘으면 즉시 TtsRateLimited로 끊고, 프론트는 그
신호를 받아 기기 기본 목소리로 읽는다 — 알림 자체가 끊기는 일은 없다.
"""

import base64
import hashlib
import logging
import os
import re
import struct
import threading
import time
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger(__name__)

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "") or os.getenv("GOOGLE_API_KEY", "")
# 실측(2026-07-31): 2.5-flash-preview-tts·3.1-flash-tts-preview 둘 다 무료 티어 200 OK
TTS_MODEL = os.getenv("TTS_GEMINI_MODEL", "gemini-2.5-flash-preview-tts")
TTS_TIMEOUT = float(os.getenv("TTS_TIMEOUT", "45"))
MAX_TEXT_LEN = 600  # 알림 문구는 한두 문장 — 장문 남용으로 쿼터가 새지 않게

CACHE_DIR = Path(os.getenv("TTS_CACHE_DIR",
                           Path(__file__).resolve().parents[3] / "uploads" / "tts"))
_CACHE_MAX_FILES = 500  # 디스크가 무한히 자라지 않게 — 초과 시 오래된 것부터 정리

# 설정 화면의 목소리 4종 → Gemini 내장 보이스 + 스타일 지시.
# 보이스 자체가 성별·톤이 다른 실제 음색이고, 스타일 문장은 억양·분위기를 잡아준다.
VOICE_MAP: dict[str, dict[str, str]] = {
    "warm_female": {
        "voice": "Sulafat",  # Warm — 따뜻한 여성 톤
        "style": "다정하고 부드러운 아나운서처럼 또박또박 자연스럽게 읽어줘",
    },
    "friendly_male": {
        "voice": "Puck",  # Upbeat — 활기찬 남성 톤
        "style": "친근한 동네 아저씨처럼 편안하고 활기차게 읽어줘",
    },
    "calm_male": {
        "voice": "Charon",  # Informative — 낮고 안정적인 남성 톤
        "style": "차분하고 낮은 목소리로 안정감 있게 천천히 읽어줘",
    },
    "cute_child": {
        "voice": "Leda",  # Youthful — 어리고 발랄한 톤
        "style": "귀엽고 발랄한 아이처럼 밝고 통통 튀게 읽어줘",
    },
}
DEFAULT_VOICE_TYPE = "warm_female"


# ── 분당 호출 한도 ──────────────────────────────────────────────────────────
# 무료 티어 TTS는 RPM 3. 캐시 적중은 구글을 부르지 않으므로 세지 않는다.
RPM_LIMIT = int(os.getenv("TTS_RPM_LIMIT", "3"))
_WINDOW_SEC = 60.0

_rate_lock = threading.Lock()
_recent_calls: list[float] = []   # 최근 60초 안에 실제로 구글을 부른 시각
_cooldown_until = 0.0             # 구글이 429를 준 뒤 쉬어가는 시각


class TtsError(RuntimeError):
    """음성 합성 실패 — 호출부(프론트)는 이걸 받으면 기기 로컬 TTS로 폴백한다"""


class TtsRateLimited(TtsError):
    """분당 한도 초과 — 실패가 아니라 '지금은 기기 목소리로 읽어라'는 신호다.

    retry_after(초) 뒤에는 다시 AI 목소리를 쓸 수 있다.
    """

    def __init__(self, retry_after: float, message: str | None = None) -> None:
        self.retry_after = max(1, int(round(retry_after)))
        super().__init__(
            message
            or f"AI 목소리는 분당 {RPM_LIMIT}회까지예요 — "
               f"{self.retry_after}초 동안은 기기 기본 목소리로 읽어드립니다"
        )


def _reserve_slot() -> None:
    """이번 합성이 분당 한도 안인지 확인하고 자리를 잡는다.

    한도를 넘었거나 구글 429 직후 쿨다운 중이면 TtsRateLimited를 던진다 —
    호출부는 이걸 받아 기기 기본 목소리로 폴백한다.
    """
    now = time.monotonic()
    with _rate_lock:
        if now < _cooldown_until:
            raise TtsRateLimited(_cooldown_until - now)
        # 60초 창 밖으로 나간 호출은 잊는다 (슬라이딩 윈도우)
        _recent_calls[:] = [t for t in _recent_calls if now - t < _WINDOW_SEC]
        if len(_recent_calls) >= RPM_LIMIT:
            raise TtsRateLimited(_WINDOW_SEC - (now - _recent_calls[0]))
        _recent_calls.append(now)


def _start_cooldown(seconds: float = _WINDOW_SEC) -> None:
    """구글이 직접 429를 준 경우 — 남은 창 동안은 아예 호출하지 않는다."""
    global _cooldown_until
    with _rate_lock:
        _cooldown_until = max(_cooldown_until, time.monotonic() + seconds)


def rate_limit_state() -> dict[str, Any]:
    """현재 분당 한도 여유 (안내·디버깅용)."""
    now = time.monotonic()
    with _rate_lock:
        alive = [t for t in _recent_calls if now - t < _WINDOW_SEC]
        cooling = max(0.0, _cooldown_until - now)
    if cooling:
        retry_after = cooling
    elif len(alive) >= RPM_LIMIT:
        retry_after = _WINDOW_SEC - (now - alive[0])
    else:
        retry_after = 0.0
    return {
        "limit_per_minute": RPM_LIMIT,
        "used": len(alive),
        "remaining": 0 if cooling else max(0, RPM_LIMIT - len(alive)),
        "retry_after": int(round(retry_after)),
    }


def _pcm_to_wav(pcm: bytes, sample_rate: int = 24000, channels: int = 1,
                bits_per_sample: int = 16) -> bytes:
    """raw PCM(L16)에 표준 44바이트 WAV 헤더를 붙인다 — 외부 라이브러리 불필요."""
    byte_rate = sample_rate * channels * bits_per_sample // 8
    block_align = channels * bits_per_sample // 8
    header = struct.pack(
        "<4sI4s4sIHHIIHH4sI",
        b"RIFF", 36 + len(pcm), b"WAVE",
        b"fmt ", 16, 1, channels, sample_rate, byte_rate, block_align, bits_per_sample,
        b"data", len(pcm),
    )
    return header + pcm


def _parse_rate(mime: str) -> int:
    """'audio/L16;codec=pcm;rate=24000' 류의 mime에서 샘플레이트를 꺼낸다."""
    m = re.search(r"rate=(\d+)", mime or "")
    return int(m.group(1)) if m else 24000


def _retry_after_sec(resp: Any) -> float:
    """구글 429 응답의 Retry-After를 읽는다 (없으면 남은 창 전체를 쉰다)."""
    raw = ""
    try:
        raw = resp.headers.get("retry-after", "") or ""
    except Exception:
        pass
    try:
        return max(1.0, min(_WINDOW_SEC, float(raw)))
    except (TypeError, ValueError):
        return _WINDOW_SEC


def _cache_path(voice_type: str, text: str) -> Path:
    digest = hashlib.sha1(f"{TTS_MODEL}|{voice_type}|{text}".encode()).hexdigest()[:20]
    return CACHE_DIR / f"{voice_type}_{digest}.wav"


def _prune_cache() -> None:
    """캐시 파일이 상한을 넘으면 오래된 것부터 지운다 (실패해도 합성은 계속)."""
    try:
        files = sorted(CACHE_DIR.glob("*.wav"), key=lambda p: p.stat().st_mtime)
        for stale in files[:-_CACHE_MAX_FILES]:
            stale.unlink(missing_ok=True)
    except Exception:
        pass


def synthesize(text: str, voice_type: str = DEFAULT_VOICE_TYPE) -> bytes:
    """텍스트를 WAV 바이트로 합성한다 (캐시 여부가 필요 없을 때 쓰는 간편 버전)."""
    return synthesize_ex(text, voice_type)[0]


def synthesize_ex(text: str, voice_type: str = DEFAULT_VOICE_TYPE) -> tuple[bytes, bool]:
    """(WAV 바이트, 캐시에서 왔는지)를 돌려준다. 같은 입력은 디스크 캐시에서 즉시 반환.

    캐시 적중은 구글을 부르지 않으므로 분당 한도(RPM 3)에 세지 않는다 — 반복되는 알림
    문구와 설정 화면 샘플은 한도가 차 있어도 계속 AI 목소리로 나간다. 호출부는 이
    구분을 프론트에 알려, '진짜로 합성됐다'는 응답에서만 대기 표시를 푼다.

    실패는 모두 TtsError로 — 프론트는 이를 받으면 기기 로컬 TTS로 폴백하므로
    알림 자체가 끊기는 일은 없다. 분당 한도 초과는 TtsRateLimited(하위 클래스)다.
    """
    text = (text or "").strip()
    if not text:
        raise TtsError("읽을 텍스트가 비어 있습니다")
    if len(text) > MAX_TEXT_LEN:
        text = text[:MAX_TEXT_LEN]

    if voice_type not in VOICE_MAP:
        voice_type = DEFAULT_VOICE_TYPE

    cached = _cache_path(voice_type, text)
    if cached.is_file():
        try:
            return cached.read_bytes(), True
        except OSError:
            pass  # 읽기 실패 시 새로 합성

    key = GEMINI_API_KEY or os.getenv("GEMINI_API_KEY", "") or os.getenv("GOOGLE_API_KEY", "")
    if not key:
        raise TtsError("GEMINI_API_KEY가 없어 서버 음성 합성을 사용할 수 없습니다")

    # 캐시에 없어 진짜로 구글을 불러야 하는 시점 — 여기서만 분당 한도를 센다
    _reserve_slot()

    import httpx

    spec = VOICE_MAP[voice_type]
    payload: dict[str, Any] = {
        # TTS 모델은 프롬프트 안의 자연어 지시로 말투를 잡는다
        "contents": [{"parts": [{"text": f"{spec['style']}: {text}"}]}],
        "generationConfig": {
            "responseModalities": ["AUDIO"],
            "speechConfig": {
                "voiceConfig": {"prebuiltVoiceConfig": {"voiceName": spec["voice"]}}
            },
        },
    }

    last_error: Exception | None = None
    for attempt in (1, 2):
        try:
            resp = httpx.post(
                f"https://generativelanguage.googleapis.com/v1beta/models/{TTS_MODEL}:generateContent?key={key}",
                json=payload,
                timeout=TTS_TIMEOUT,
            )
            if resp.status_code == 429:
                # 우리 카운터보다 구글이 먼저 막은 경우(다른 인스턴스·다른 팀원과 키 공유).
                # 기다려도 이 요청 안에서는 안 풀리니, 남은 창 동안 쉬고 프론트 폴백에 맡긴다.
                _start_cooldown(_retry_after_sec(resp))
                raise TtsRateLimited(
                    _retry_after_sec(resp),
                    "AI 음성 사용량이 잠시 소진되었습니다 (기기 기본 목소리로 읽어드려요)",
                )
            if resp.status_code >= 500:
                last_error = TtsError(f"Gemini TTS HTTP {resp.status_code}")
                if attempt == 1:
                    time.sleep(1.5)
                continue
            resp.raise_for_status()
            parts = resp.json()["candidates"][0]["content"]["parts"]
            inline = next((p.get("inlineData") or p.get("inline_data")
                           for p in parts if p.get("inlineData") or p.get("inline_data")), None)
            if not inline or not inline.get("data"):
                raise TtsError("합성 응답에 오디오가 없습니다")
            mime = inline.get("mimeType") or inline.get("mime_type") or ""
            pcm = base64.b64decode(inline["data"])
            wav = _pcm_to_wav(pcm, sample_rate=_parse_rate(mime))

            try:
                CACHE_DIR.mkdir(parents=True, exist_ok=True)
                cached.write_bytes(wav)
                _prune_cache()
            except OSError:
                pass  # 캐시 실패는 치명적이지 않다
            return wav, False
        except TtsError:
            raise
        except (httpx.HTTPError, KeyError, IndexError, ValueError) as e:
            last_error = e
            if attempt == 1:
                time.sleep(1.5)
    raise TtsError(f"음성 합성에 실패했습니다: {last_error}")
