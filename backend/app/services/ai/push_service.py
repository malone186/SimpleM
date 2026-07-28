"""FCM 푸시 발송 (백엔드 B) — 전송 계층만 담당

무엇을 언제 보낼지는 notification_service가 정하고, 이 파일은 "받은 문구를 기기로 보내고
죽은 토큰을 정리하는" 일만 한다.

인증은 FCM HTTP v1 + 서비스 계정 OAuth2다. 예전 서버 키(레거시 HTTP API)는 폐기됐다.
액세스 토큰은 1시간마다 만료되지만 google-auth가 알아서 갱신하므로 만료 관리 코드는 없다 —
credentials.valid를 보고 필요할 때만 refresh를 부르는 게 전부다.

자격증명은 둘 중 하나로 준다:
  FCM_SERVICE_ACCOUNT_JSON : 서비스 계정 JSON '내용' 전체 (Cloud Run 환경변수용)
  GOOGLE_APPLICATION_CREDENTIALS : 서비스 계정 JSON '파일 경로' (로컬 개발용)
둘 다 없으면 발송은 조용히 건너뛴다 — 푸시 미설정이 서버 기동이나 리포트 생성을 막으면 안 된다.
"""

import json
import logging
import os
import threading
from typing import Any, Optional

logger = logging.getLogger(__name__)

FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging"
FCM_ENDPOINT = "https://fcm.googleapis.com/v1/projects/{project_id}/messages:send"

# 안드로이드 알림 채널 — 프론트(pushRegistration.ts)가 같은 id로 채널을 만들어 둔다.
# 긴급 채널만 따로 두는 이유: 냉장고 온도 이탈은 방해금지도 뚫어야 하는데,
# 안드로이드는 채널 단위로 중요도·DND 우회를 정하므로 채널이 분리돼 있어야 한다.
CHANNEL_DEFAULT = "brewnote-default"
CHANNEL_URGENT = "brewnote-urgent"

_credentials = None
_project_id: Optional[str] = None
_lock = threading.Lock()  # 토큰 갱신이 동시에 여러 번 돌지 않게


class PushError(RuntimeError):
    """푸시 발송 실패 (설정 오류 등)"""


def _load_credentials():
    """서비스 계정 자격증명을 한 번만 만들어 재사용한다. 미설정이면 (None, None)."""
    global _credentials, _project_id
    if _credentials is not None:
        return _credentials, _project_id

    with _lock:
        if _credentials is not None:  # 다른 스레드가 먼저 만들었으면 그걸 쓴다
            return _credentials, _project_id

        raw = os.getenv("FCM_SERVICE_ACCOUNT_JSON", "").strip()
        path = os.getenv("GOOGLE_APPLICATION_CREDENTIALS", "").strip()
        if not raw and not path:
            return None, None

        try:
            from google.oauth2 import service_account
        except ImportError:
            logger.warning("google-auth 미설치 — 푸시 발송 불가 (pip install google-auth)")
            return None, None

        try:
            if raw:
                info = json.loads(raw)
                creds = service_account.Credentials.from_service_account_info(info, scopes=[FCM_SCOPE])
            else:
                with open(path, encoding="utf-8") as f:
                    info = json.load(f)
                creds = service_account.Credentials.from_service_account_file(path, scopes=[FCM_SCOPE])
        except Exception as e:
            logger.error("FCM 서비스 계정 자격증명 로드 실패: %s", e)
            return None, None

        # 프로젝트 id는 서비스 계정 JSON 안에 들어 있다 — 인증 대상과 발송 대상이
        # 어긋나면 403이 나므로 env보다 JSON을 우선한다.
        _project_id = info.get("project_id") or os.getenv("FIREBASE_PROJECT_ID") or None
        _credentials = creds
        logger.info("FCM 자격증명 로드 완료 (project=%s)", _project_id)
        return _credentials, _project_id


def is_configured() -> bool:
    """푸시를 실제로 보낼 수 있는 상태인지 (설정 화면·헬스체크용)."""
    creds, project_id = _load_credentials()
    return creds is not None and bool(project_id)


def _access_token() -> Optional[str]:
    """유효한 OAuth2 액세스 토큰. 만료됐으면 google-auth가 갱신한다."""
    creds, _ = _load_credentials()
    if creds is None:
        return None
    from google.auth.transport.requests import Request

    with _lock:
        if not creds.valid:  # 최초 1회 + 1시간마다 여기서만 갱신된다
            creds.refresh(Request())
    return creds.token


# ---------------------------------------------------------------------------
# 토큰 등록 · 정리
# ---------------------------------------------------------------------------

def register_token(db, store_id: str, token: str, platform: str = "android",
                   device_name: Optional[str] = None) -> None:
    """기기 토큰을 등록/갱신한다 (upsert).

    같은 토큰이 다른 매장에 남아 있을 수 있다 — 한 기기에서 로그아웃 후 다른 계정으로
    로그인한 경우다. 이때 행을 새로 만들면 이전 사장님 알림이 이 기기로 계속 가므로
    소유자를 옮긴다.
    """
    from app.models.ai import DeviceToken

    row = db.query(DeviceToken).filter(DeviceToken.token == token).first()
    if row is None:
        db.add(DeviceToken(store_id=store_id, token=token, platform=platform, device_name=device_name))
    else:
        row.store_id = store_id
        row.platform = platform
        if device_name:
            row.device_name = device_name
        from sqlalchemy import func as _f
        row.last_seen_at = _f.now()  # onupdate는 다른 컬럼이 안 바뀌면 안 걸린다
    db.commit()


def unregister_token(db, token: str, store_id: Optional[str] = None) -> None:
    """로그아웃 시 호출 — 이 기기로 더는 알림이 가지 않게 한다.

    store_id를 주면 그 매장 소유의 토큰만 지운다. API에서는 반드시 넘겨야 한다 —
    안 넘기면 토큰 문자열만 아는 사람이 남의 기기 등록을 해제할 수 있다.
    """
    from app.models.ai import DeviceToken

    q = db.query(DeviceToken).filter(DeviceToken.token == token)
    if store_id is not None:
        q = q.filter(DeviceToken.store_id == store_id)
    q.delete()
    db.commit()


def _drop_token(db, token: str, reason: str) -> None:
    from app.models.ai import DeviceToken

    db.query(DeviceToken).filter(DeviceToken.token == token).delete()
    db.commit()
    logger.info("무효 토큰 삭제 (%s): ...%s", reason, token[-12:])


def list_tokens(db, store_id: str) -> list[str]:
    from app.models.ai import DeviceToken

    return [r.token for r in db.query(DeviceToken).filter(DeviceToken.store_id == store_id).all()]


# 이 기간 넘게 앱이 한 번도 안 열린 기기는 등록을 지운다. FCM 토큰은 장기 미사용만으로도
# 무효화되므로, 남겨봐야 발송 실패만 늘고 성공률 지표가 망가진다.
STALE_TOKEN_DAYS = 90


def purge_stale_tokens(db, days: int = STALE_TOKEN_DAYS) -> int:
    """오래 갱신되지 않은 기기 토큰을 지우고 지운 개수를 돌려준다."""
    from datetime import datetime, timedelta, timezone

    from app.models.ai import DeviceToken

    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    n = db.query(DeviceToken).filter(DeviceToken.last_seen_at < cutoff).delete()
    db.commit()
    if n:
        logger.info("오래된 기기 토큰 %d건 정리 (%d일 미갱신)", n, days)
    return n


# ---------------------------------------------------------------------------
# 발송
# ---------------------------------------------------------------------------

def _send_one(access_token: str, project_id: str, token: str, title: str, body: str,
              data: dict[str, str], urgent: bool) -> tuple[bool, Optional[str]]:
    """토큰 하나로 발송. (성공여부, 무효사유) — 무효사유가 있으면 호출자가 토큰을 지운다."""
    import httpx

    message: dict[str, Any] = {
        "token": token,
        "notification": {"title": title, "body": body},
        # data 값은 반드시 문자열이어야 한다 — 숫자를 넣으면 FCM이 400으로 거절한다
        "data": {k: str(v) for k, v in data.items()},
        "android": {
            "priority": "high" if urgent else "normal",
            "notification": {
                "channel_id": CHANNEL_URGENT if urgent else CHANNEL_DEFAULT,
                "sound": "default",
                # 같은 종류 알림이 여러 개 쌓이지 않고 최신 것으로 덮이게 한다
                "tag": data.get("category", "general"),
            },
        },
    }
    try:
        resp = httpx.post(
            FCM_ENDPOINT.format(project_id=project_id),
            json={"message": message},
            headers={"Authorization": f"Bearer {access_token}"},
            timeout=10.0,
        )
    except Exception as e:
        logger.warning("FCM 전송 실패 (네트워크): %s", e)
        return False, None

    if resp.status_code == 200:
        return True, None

    # 무효 토큰: 404 UNREGISTERED(앱 삭제·재설치) / 400 INVALID_ARGUMENT(형식 오류)
    detail = resp.text[:300]
    if resp.status_code == 404:
        return False, "UNREGISTERED"
    if resp.status_code == 400 and "INVALID_ARGUMENT" in detail:
        return False, "INVALID_ARGUMENT"
    logger.warning("FCM 전송 실패 (%s): %s", resp.status_code, detail)
    return False, None


def send_to_store(db, store_id: str, title: str, body: str,
                  data: Optional[dict[str, Any]] = None, urgent: bool = False) -> int:
    """매장에 등록된 모든 기기로 발송하고 성공 건수를 돌려준다.

    data에는 탭했을 때 열 화면을 담는다 (screen·params) — 프론트 pushRegistration이 읽는다.
    """
    creds, project_id = _load_credentials()
    if creds is None or not project_id:
        logger.info("FCM 미설정 — 발송 건너뜀 (%s: %s)", store_id, title)
        return 0

    tokens = list_tokens(db, store_id)
    if not tokens:
        return 0

    access_token = _access_token()
    if not access_token:
        return 0

    payload = {k: str(v) for k, v in (data or {}).items()}
    sent = 0
    for token in tokens:
        ok, invalid = _send_one(access_token, project_id, token, title, body, payload, urgent)
        if ok:
            sent += 1
        elif invalid:
            _drop_token(db, token, invalid)
    return sent
