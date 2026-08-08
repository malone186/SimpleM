"""챗봇 무료 사용량 (백엔드 B) — 하루 N턴 무료, 광고를 보면 충전

왜 서버에서 세는가: 클라이언트(AsyncStorage)에 두면 앱을 재설치하거나 저장값을 고쳐
무한히 쓸 수 있다. 챗봇 한 턴은 Gemini 호출이라 실제 비용이 나가므로 강제는 서버 몫이다.

왜 '광고를 봐야만 쓸 수 있게'가 아니라 '무료 할당량 + 광고 충전'인가: AdMob 보상형 정책이
"광고를 건너뛰거나 거절하는 것이 앱의 정상적인 사용을 방해해서는 안 된다"고 못박고 있다.
무료 할당량이 정상 사용 구간이 되고, 그 위를 광고로 늘리는 구조라야 정책을 통과한다.
"""

import logging
import os
from datetime import datetime, timedelta, timezone
from typing import Any

logger = logging.getLogger(__name__)

KST = timezone(timedelta(hours=9))

# 하루에 공짜로 쓸 수 있는 턴 수.
#
# 환경변수로 뺀 이유가 두 가지다.
# 1) 킬 스위치 — 앱 업데이트가 퍼지기 전에 백엔드만 배포되면, 구버전 앱은 429를 해석하지
#    못해 광고 유도 없이 오류만 띄운다. 그럴 때 아주 큰 값을 넣어 제한을 사실상 끈다.
# 2) 테스트 — 광고 흐름을 확인할 때마다 5턴을 채우는 건 번거롭다. 1로 낮춰 바로 확인한다.
FREE_DAILY_TURNS = int(os.getenv("CHAT_FREE_DAILY_TURNS", "5"))

# 광고 1회 시청으로 늘어나는 턴 수
TURNS_PER_AD = int(os.getenv("CHAT_TURNS_PER_AD", "5"))

# 하루 광고 시청 상한. 없으면 광고를 계속 돌려 사실상 무제한이 되고,
# 짧은 시간에 같은 사용자가 광고를 과다 노출받아 AdMob 쪽에서도 문제가 된다.
MAX_ADS_PER_DAY = int(os.getenv("CHAT_MAX_ADS_PER_DAY", "6"))


class QuotaExhausted(RuntimeError):
    """남은 턴이 없다 — 광고를 보면 충전할 수 있다"""


class AdLimitReached(RuntimeError):
    """오늘 광고 시청 상한에 도달했다 — 내일까지 충전 불가"""


def _session():
    import app.models  # noqa: F401 — 모든 모델을 Base.metadata에 등록

    from app.core.database import SessionLocal

    return SessionLocal()


def _today() -> str:
    return datetime.now(KST).strftime("%Y-%m-%d")


def _snapshot(row) -> dict[str, Any]:
    """행 → 프론트가 쓰는 모양. 남은 턴은 항상 0 이상으로 잘라 돌려준다."""
    limit = FREE_DAILY_TURNS + row.granted
    return {
        "date": row.date,
        "used": row.used,
        "granted": row.granted,
        "free_daily": FREE_DAILY_TURNS,
        "remaining": max(0, limit - row.used),
        "ads_watched": row.ads_watched,
        "turns_per_ad": TURNS_PER_AD,
        # 남은 턴이 없어도 광고 상한에 걸렸으면 광고를 권하지 않아야 한다
        "can_watch_ad": row.ads_watched < MAX_ADS_PER_DAY,
    }


def _get_or_create(db, store_id: str, *, lock: bool = False, day: str | None = None):
    """오늘(또는 지정한 날) 행을 가져오거나 만든다.

    lock=True면 SELECT ... FOR UPDATE로 잠근다. 같은 사용자가 메시지를 연달아 보내면
    used 증가가 겹쳐 한도를 넘길 수 있어서다 (Postgres에서만 실효, sqlite는 무시).
    day는 환불이 '차감했던 그 날' 행을 짚을 때 쓴다 (자정 직전 소비 → 직후 환불 케이스).
    """
    from sqlalchemy.exc import IntegrityError

    from app.models.ai import ChatQuota

    today = day or _today()
    q = db.query(ChatQuota).filter(ChatQuota.store_id == store_id, ChatQuota.date == today)
    if lock:
        q = q.with_for_update()
    row = q.one_or_none()

    if row is None:
        row = ChatQuota(store_id=store_id, date=today, used=0, granted=0, ads_watched=0)
        db.add(row)
        try:
            db.flush()
        except IntegrityError:
            # 같은 매장의 오늘 첫 요청 두 개가 동시에 들어오면 둘 다 '행 없음'을 보고
            # 만들려 한다 — (store_id, date) PK에 진 쪽은 롤백하고 이긴 행을 다시 읽는다.
            # 안 잡으면 사장님의 오늘 첫 챗봇 턴이 500으로 터진다.
            db.rollback()
            row = q.one()
    return row


def get_quota(store_id: str) -> dict[str, Any]:
    """현재 사용량 조회. 조회만으로 소비되지 않는다."""
    with _session() as db:
        row = _get_or_create(db, store_id)
        snap = _snapshot(row)
        db.commit()
        return snap


def consume(store_id: str) -> dict[str, Any]:
    """한 턴을 소비한다. 남은 턴이 없으면 QuotaExhausted를 던진다.

    실제 Gemini 호출 '전에' 부른다 — 호출 후에 세면 응답이 실패했을 때 소비 여부가
    애매해지고, 무엇보다 한도를 넘긴 요청이 이미 비용을 발생시킨 뒤가 된다.
    """
    with _session() as db:
        row = _get_or_create(db, store_id, lock=True)
        if FREE_DAILY_TURNS + row.granted - row.used <= 0:
            snap = _snapshot(row)
            db.commit()
            raise QuotaExhausted(snap)

        row.used += 1
        snap = _snapshot(row)
        db.commit()
        return snap


def refund(store_id: str, day: str | None = None) -> None:
    """소비를 되돌린다 — 챗봇이 장애로 답을 못 준 턴까지 차감하면 부당하다.

    day: 차감이 일어난 날짜(consume 반환값의 date). 자정 직전에 차감된 턴이 자정을
    넘겨 실패하면, day 없이 되돌릴 때 '오늘'(used=0) 행에서 무의미하게 빼려다
    어제의 실패 턴이 영영 차감된 채 남는다.
    """
    with _session() as db:
        row = _get_or_create(db, store_id, lock=True, day=day)
        if row.used > 0:
            row.used -= 1
        db.commit()


def grant_from_ad(store_id: str) -> dict[str, Any]:
    """광고 시청 완료 → 턴을 충전한다. 하루 상한을 넘으면 AdLimitReached."""
    with _session() as db:
        row = _get_or_create(db, store_id, lock=True)
        if row.ads_watched >= MAX_ADS_PER_DAY:
            snap = _snapshot(row)
            db.commit()
            raise AdLimitReached(snap)

        row.granted += TURNS_PER_AD
        row.ads_watched += 1
        snap = _snapshot(row)
        db.commit()
        logger.info(
            "챗봇 광고 충전 — %s: +%d턴 (오늘 %d회째)", store_id, TURNS_PER_AD, row.ads_watched
        )
        return snap
