"""시각 표기 유틸 — 저장은 UTC, 화면 표시는 KST(Asia/Seoul).

관리자 페이지의 '접수 일시'가 실제 접수 시각보다 9시간 이르게 찍히던 원인이 여기였다.
문의는 `datetime.utcnow()`로 저장되는데(= UTC), 화면에 내보낼 때 변환 없이 그대로
strftime을 불렀다. 낮 12시 40분에 들어온 문의가 03:40으로 보였다.
자정 근처 접수는 날짜까지 하루 앞으로 밀렸다.

저장 형식은 건드리지 않는다. 지금 DB에 쌓인 값이 전부 UTC라서, 내보내는 순간에만
KST로 옮기면 과거 문의까지 한 번에 맞는다. (저장을 KST로 바꾸면 새 행만 맞고 과거
행은 9시간 어긋난 채 남아, 목록에서 두 시간대가 섞인다.)

컬럼 형식이 테이블마다 다르지만 to_kst()가 둘 다 받는다:
- inquiries.created_at / answered_at   : `timestamp without time zone`에 naive UTC
- users·admin_notifications·tracking_events.created_at : `timestamptz`(aware UTC)
naive 값은 UTC로 간주한다 — 위 테이블들의 유일한 기록자가 utcnow()이기 때문이다.
(로컬 DB 시절의 naive=KST 데이터를 다루는 forecast_service 쪽 규칙과는 반대다.)
"""
from datetime import datetime, timedelta, timezone
from typing import Optional

KST = timezone(timedelta(hours=9))
UTC = timezone.utc


def utc_now() -> datetime:
    """DB에 넣을 현재 UTC 시각 (naive — 기존 컬럼에 쌓인 값과 같은 형식).

    `datetime.utcnow()`와 같은 값이지만 3.12에서 deprecated가 아니다.
    """
    return datetime.now(UTC).replace(tzinfo=None)


def now_kst() -> datetime:
    """지금(KST). DB에 못 넣고 메모리 폴백에 표시용 문자열만 남길 때 쓴다."""
    return datetime.now(KST)


def to_kst(dt: Optional[datetime]) -> Optional[datetime]:
    """DB에서 읽은 시각을 KST로 옮긴다. naive면 UTC로 저장된 값으로 본다."""
    if dt is None:
        return None
    return (dt if dt.tzinfo else dt.replace(tzinfo=UTC)).astimezone(KST)


def fmt_kst(dt: Optional[datetime], fmt: str = "%Y-%m-%d %H:%M", default: str = "") -> str:
    """화면에 내보낼 KST 문자열. 값이 없으면 default를 준다."""
    kst = to_kst(dt)
    return kst.strftime(fmt) if kst else default
