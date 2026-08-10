"""AdMob 보상형 광고 서버 사이드 검증(SSV) — 서명 확인만 담당 (백엔드 B)

왜 있는가
---------
챗봇 턴 충전은 원래 앱이 "광고 다 봤어요"라고 보고하면 그대로 믿었다. 앱을 뜯으면
광고 없이 충전 엔드포인트만 반복해 때릴 수 있고, 그 턴은 실제 Gemini 호출 비용이다.
(MAX_ADS_PER_DAY가 피해 상한 역할을 했을 뿐 검증은 없었다.)

구글은 이 문제를 위해 SSV를 제공한다 — 사용자가 광고를 끝까지 본 사실을 구글 서버가
우리 서버로 직접 알려주고, 그 요청에 ECDSA 서명이 붙는다. 앱을 거치지 않으므로 앱을
어떻게 뜯어도 위조할 수 없다.

검증 규칙 (구글 문서)
--------------------
- 콜백 URL의 쿼리스트링에서 `&signature=` **앞부분 전체**가 서명 대상 원문이다.
  파라미터를 재정렬하거나 다시 인코딩하면 안 된다 — 받은 문자열 그대로 써야 한다.
- `signature`는 base64 웹세이프(URL-safe) 인코딩된 DER ECDSA 서명, 해시는 SHA-256.
- 공개키는 gstatic의 키 목록에서 `key_id`로 찾는다. 키는 주기적으로 교체되므로
  캐시해 두되, 모르는 key_id가 오면 한 번 다시 받아 본다(교체 직후 대응).

여기서는 서명만 본다. 누구에게 몇 턴을 줄지는 chat_quota_service의 몫이다.
"""

import base64
import logging
import os
import time
from typing import Any
from urllib.parse import parse_qsl

logger = logging.getLogger(__name__)

# 구글이 공개하는 SSV 검증용 공개키 목록
KEYS_URL = os.getenv(
    "ADMOB_SSV_KEYS_URL", "https://gstatic.com/admob/reward/verifier-keys.json"
)

# 키는 자주 바뀌지 않는다 — 콜백마다 받아오면 충전이 구글 응답 속도에 묶인다.
_KEYS_TTL_SEC = 12 * 3600

# 아무리 늦게 도착한 콜백이라도 이보다 오래된 건 받지 않는다. 재생 공격은 거래 id
# 유니크로 이미 막히지만, 원장을 오래 뒤에 정리하더라도 그 틈이 다시 열리지 않게 한다.
_MAX_AGE_SEC = 24 * 3600

# 키 목록을 다시 받으러 나가는 최소 간격.
#
# 이 엔드포인트는 인증이 없다(구글이 부르므로). 모르는 key_id를 넣은 요청을 초당 수백 개
# 던지면, 그때마다 gstatic으로 나가는 요청이 따라 붙어 우리 서버가 증폭기가 된다.
# 진짜 키 교체는 몇 달에 한 번이라 1분 간격이면 충분하다.
_MIN_REFETCH_SEC = 60

_cache: dict[str, Any] = {"fetched_at": 0.0, "attempted_at": 0.0, "keys": {}}


class SsvInvalid(ValueError):
    """서명이 없거나, 키를 못 찾거나, 검증에 실패했다 — 충전하지 않는다"""


def _fetch_keys() -> dict[str, str]:
    """키 목록을 받아 {key_id: pem} 으로 돌려준다. 실패하면 빈 dict."""
    import httpx

    try:
        res = httpx.get(KEYS_URL, timeout=3.0)
        res.raise_for_status()
        payload = res.json()
    except Exception as e:  # 네트워크 장애 — 기존 캐시를 계속 쓴다
        logger.warning("AdMob SSV 키 목록을 받지 못했습니다: %s", e)
        return {}

    keys: dict[str, str] = {}
    for item in payload.get("keys", []):
        key_id = str(item.get("keyId", "")).strip()
        pem = item.get("pem")
        if not key_id or not pem:
            continue
        keys[key_id] = pem
    return keys


def _public_key_pem(key_id: str) -> str | None:
    """key_id에 해당하는 공개키 PEM. 캐시에 없으면 (간격을 두고) 다시 받아 본다."""
    now = time.time()
    stale = now - float(_cache["fetched_at"]) > _KEYS_TTL_SEC
    cached: dict[str, str] = _cache["keys"]

    if key_id in cached and not stale:
        return cached[key_id]

    # 캐시에 없는 key_id = 키 교체 직후일 수 있다. 다만 위조 요청도 같은 모양이라,
    # 재조회는 _MIN_REFETCH_SEC 간격으로만 나간다 (증폭 방지).
    if now - float(_cache["attempted_at"]) < _MIN_REFETCH_SEC:
        return cached.get(key_id)

    _cache["attempted_at"] = now
    fresh = _fetch_keys()
    if fresh:
        _cache["keys"] = fresh
        _cache["fetched_at"] = now
        cached = fresh
    return cached.get(key_id)


def _b64url_decode(raw: str) -> bytes:
    """웹세이프 base64 디코드 — 구글은 패딩(=)을 떼고 보낸다."""
    padded = raw + "=" * (-len(raw) % 4)
    return base64.urlsafe_b64decode(padded)


def _age_seconds(timestamp: str) -> float | None:
    """콜백의 timestamp가 얼마나 오래됐는지(초). 해석 불가면 None.

    구글 문서와 실제 트래픽에서 이 값의 단위가 밀리초/마이크로초로 엇갈린다 —
    자릿수로 판별한다 (10자리=초, 13자리=밀리초, 16자리=마이크로초).
    """
    try:
        value = int(timestamp)
    except (TypeError, ValueError):
        return None
    for divisor in (1, 1_000, 1_000_000):
        seconds = value / divisor
        # 2001-09-09 ~ 2286년 사이면 초 단위로 그럴듯한 값
        if 1_000_000_000 < seconds < 10_000_000_000:
            return time.time() - seconds
    return None


def verify(query_string: str) -> dict[str, str]:
    """콜백 쿼리스트링을 검증하고 파라미터를 돌려준다. 실패하면 SsvInvalid.

    query_string은 서버가 받은 **원문 그대로**여야 한다. FastAPI에서는
    `request.url.query`가 그 값이다 (request.query_params는 파싱된 사본이라 못 쓴다).
    """
    if not query_string:
        raise SsvInvalid("쿼리스트링이 비어 있습니다")

    marker = "&signature="
    idx = query_string.find(marker)
    if idx < 0:
        raise SsvInvalid("signature 파라미터가 없습니다")

    # 서명 대상은 signature 앞부분 전체 — 파싱하지 않은 원문을 그대로 쓴다
    signed_content = query_string[:idx]
    params = dict(parse_qsl(query_string, keep_blank_values=True))

    signature_raw = params.get("signature", "")
    key_id = params.get("key_id", "")
    if not signature_raw or not key_id:
        raise SsvInvalid("signature 또는 key_id가 비어 있습니다")

    pem = _public_key_pem(key_id)
    if not pem:
        raise SsvInvalid(f"key_id={key_id}에 해당하는 공개키를 찾지 못했습니다")

    # 지연 import — 서명 검증은 콜백이 올 때만 필요하다 (기동 시간에 영향 없게)
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives.serialization import load_pem_public_key

    try:
        signature = _b64url_decode(signature_raw)
        public_key = load_pem_public_key(pem.encode("utf-8"))
        public_key.verify(signature, signed_content.encode("utf-8"), ec.ECDSA(hashes.SHA256()))
    except Exception as e:
        raise SsvInvalid(f"서명 검증 실패: {type(e).__name__}") from e

    age = _age_seconds(params.get("timestamp", ""))
    if age is not None and age > _MAX_AGE_SEC:
        raise SsvInvalid(f"너무 오래된 콜백입니다 ({int(age)}초 전)")

    return params
