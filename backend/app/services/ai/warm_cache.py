"""인스턴스가 바뀌어도 살아남는 계산 결과 캐시 (백엔드 B).

인사이트 스캔·판매 예측은 각자 프로세스 메모리에 캐시를 들고 있다. 그 캐시는 빠르지만
Cloud Run이 인스턴스를 내리면 같이 사라진다 — 사장님이 아침에 앱을 처음 켤 때가 정확히
그 순간이라, 늘 7초짜리 계산을 처음부터 기다리게 됐다(2026-08-05 실측: 인사이트 7.1초,
예측 7.0초 / 데워진 뒤에는 둘 다 0.6초).

여기서는 같은 결과를 DB(ai_warm_cache)에 한 벌 더 써 둔다. 새 인스턴스는 쿼리 한 번으로
지난 결과를 집어 바로 응답하고, 진짜 계산은 백그라운드에서 돌려 다음 조회부터 최신이 된다.

**이 모듈은 절대 예외를 밖으로 내보내지 않는다.** 캐시는 없어도 되는 물건이고,
캐시 조회가 실패했다고 인사이트 화면이 500이 나면 손해가 훨씬 크다. 모든 실패는
None(=캐시 없음)으로 바뀌고 로그만 남는다.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import Any, Optional

from app.core.database import SessionLocal

logger = logging.getLogger(__name__)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def load(key: str, max_age_seconds: float) -> Optional[tuple[Any, float]]:
    """(저장된 값, 나이 초)를 돌려준다. 없거나 너무 낡았으면 None.

    max_age_seconds를 넉넉히 잡아도 된다 — 부른 쪽이 이 값을 화면에 먼저 보여 주고
    백그라운드로 다시 계산하는 구조라, 조금 낡은 값이 빈 화면보다 낫다.
    """
    from app.models.ai import AiWarmCache

    try:
        db = SessionLocal()
        try:
            row = db.query(AiWarmCache).filter(AiWarmCache.key == key).first()
            if row is None:
                return None
            updated = row.updated_at
            payload = row.payload
        finally:
            db.close()
    except Exception:
        # 테이블이 아직 없거나(첫 배포) DB가 잠깐 흔들린 경우 — 캐시 없음으로 취급
        logger.debug("warm_cache 조회 실패 (key=%s)", key, exc_info=True)
        return None

    # DB 설정에 따라 tz 정보가 없는 값이 올 수 있다 — UTC로 간주해 나이를 잰다
    if updated is None:
        return None
    if updated.tzinfo is None:
        updated = updated.replace(tzinfo=timezone.utc)

    age = (_now() - updated).total_seconds()
    if age < 0:
        age = 0.0  # 서버 시계 차이 — 방금 쓴 값으로 본다
    if age > max_age_seconds:
        return None

    try:
        return json.loads(payload), age
    except Exception:
        logger.warning("warm_cache 값이 깨져 있어 버립니다 (key=%s)", key)
        return None


def save(key: str, payload: Any) -> None:
    """계산 결과를 남긴다. 같은 key가 있으면 덮어쓴다.

    payload는 JSON으로 직렬화된다 — date 같은 값은 문자열이 된다(API 응답과 같은 모양).
    """
    from app.models.ai import AiWarmCache

    try:
        text = json.dumps(payload, ensure_ascii=False, default=str)
    except Exception:
        logger.warning("warm_cache 직렬화 실패 — 저장을 건너뜁니다 (key=%s)", key, exc_info=True)
        return

    try:
        db = SessionLocal()
        try:
            row = db.query(AiWarmCache).filter(AiWarmCache.key == key).first()
            if row is None:
                db.add(AiWarmCache(key=key, payload=text, updated_at=_now()))
            else:
                row.payload = text
                row.updated_at = _now()
            db.commit()
        finally:
            db.close()
    except Exception:
        # 여러 인스턴스가 같은 key를 동시에 쓰면 충돌할 수 있다 — 어느 쪽이 이겨도 값은 같다
        logger.debug("warm_cache 저장 실패 (key=%s)", key, exc_info=True)


def drop(key: str) -> None:
    """저장된 값을 지운다 — 원천 데이터가 바뀌어 캐시가 틀려진 경우."""
    from app.models.ai import AiWarmCache

    try:
        db = SessionLocal()
        try:
            db.query(AiWarmCache).filter(AiWarmCache.key == key).delete()
            db.commit()
        finally:
            db.close()
    except Exception:
        logger.debug("warm_cache 삭제 실패 (key=%s)", key, exc_info=True)


def drop_prefix(prefix: str) -> None:
    """앞부분이 같은 값들을 한꺼번에 지운다 — 예: 한 매장의 예측 전체."""
    from app.models.ai import AiWarmCache

    try:
        db = SessionLocal()
        try:
            db.query(AiWarmCache).filter(AiWarmCache.key.like(f"{prefix}%")).delete(
                synchronize_session=False
            )
            db.commit()
        finally:
            db.close()
    except Exception:
        logger.debug("warm_cache 접두어 삭제 실패 (prefix=%s)", prefix, exc_info=True)
