"""인스턴스가 바뀌어도 살아남는 캐시(ai_warm_cache) 검증.

이 캐시의 목적은 하나다 — Cloud Run이 인스턴스를 내렸다 올려도 사장님이 인사이트 7초·
예측 7초를 처음부터 다시 기다리지 않게 하는 것. 그래서 검증할 것도 그 목적에 맞춘다:

  1) 프로세스 메모리를 비워도(=새 인스턴스) 저장한 값이 돌아오는가
  2) 너무 낡은 값은 스스로 안 쓰는가
  3) 판매가 바뀌어 무효화하면 DB에 남은 값까지 사라지는가
     — 여기가 무너지면 "매출을 입력했는데 예측이 그대로"가 된다.
  4) 캐시가 깨져 있어도 기능이 죽지 않는가 (캐시는 없어도 되는 물건이다)
"""

import json
import time

import pytest

from app.core.database import SessionLocal
from app.models.ai import AiWarmCache
from app.services.ai import forecast_service, warm_cache

KEY = "test:warm-cache:round-trip"


def _delete(prefix: str) -> None:
    db = SessionLocal()
    try:
        db.query(AiWarmCache).filter(AiWarmCache.key.like(f"{prefix}%")).delete(
            synchronize_session=False
        )
        db.commit()
    finally:
        db.close()


@pytest.fixture(autouse=True)
def _clean():
    _delete("test:warm-cache:")
    yield
    _delete("test:warm-cache:")


def test_저장한_값을_되찾는다():
    warm_cache.save(KEY, {"insights": [{"key": "a", "severity": "high"}], "failed": []})

    hit = warm_cache.load(KEY, max_age_seconds=3600)
    assert hit is not None, "방금 저장한 값을 못 읽으면 새 인스턴스는 늘 7초를 다시 쓴다"
    data, age = hit
    assert data["insights"][0]["key"] == "a"
    assert age < 60


def test_없는_키는_None():
    assert warm_cache.load("test:warm-cache:없음", max_age_seconds=3600) is None


def test_너무_낡으면_안_쓴다():
    warm_cache.save(KEY, {"x": 1})
    time.sleep(1.1)
    # 1초보다 낡은 값은 거절 → 부른 쪽이 새로 계산한다
    assert warm_cache.load(KEY, max_age_seconds=1) is None


def test_같은_키는_덮어쓴다():
    warm_cache.save(KEY, {"v": 1})
    warm_cache.save(KEY, {"v": 2})
    hit = warm_cache.load(KEY, max_age_seconds=3600)
    assert hit is not None and hit[0]["v"] == 2

    db = SessionLocal()
    try:
        assert db.query(AiWarmCache).filter(AiWarmCache.key == KEY).count() == 1
    finally:
        db.close()


def test_접두어로_한꺼번에_지운다():
    warm_cache.save("test:warm-cache:a", {"v": 1})
    warm_cache.save("test:warm-cache:b", {"v": 2})
    warm_cache.drop_prefix("test:warm-cache:")
    assert warm_cache.load("test:warm-cache:a", 3600) is None
    assert warm_cache.load("test:warm-cache:b", 3600) is None


def test_깨진_값은_조용히_버린다():
    db = SessionLocal()
    try:
        db.add(AiWarmCache(key=KEY, payload="{이건 JSON이 아니다"))
        db.commit()
    finally:
        db.close()
    # 예외를 던지면 인사이트 화면이 통째로 500이 된다 — 캐시 미스로 취급해야 한다
    assert warm_cache.load(KEY, max_age_seconds=3600) is None


def test_예측_무효화는_DB에_남은_값까지_지운다():
    """판매를 입력했는데 다음 인스턴스가 옛 예측을 집어 오면 안 된다."""
    store = "test-warm-cache-store@example.com"
    key = forecast_service._warm_key((store, 37.566, 126.978, 7))
    other = forecast_service._warm_key(("test-warm-cache-other@example.com", 37.566, 126.978, 7))
    try:
        warm_cache.save(key, {"made_on": "2026-08-05", "result": {"week": []}})
        warm_cache.save(other, {"made_on": "2026-08-05", "result": {"week": []}})

        forecast_service.invalidate_forecast_cache(store)

        assert warm_cache.load(key, 86_400) is None, "무효화한 매장의 DB 캐시가 남아 있다"
        assert warm_cache.load(other, 86_400) is not None, "다른 매장 캐시까지 지우면 안 된다"
    finally:
        warm_cache.drop(key)
        warm_cache.drop(other)


def test_예측_peek는_다른_날_캐시를_거절한다():
    """자정을 넘긴 예측은 '내일' 날짜가 밀려 있어 그대로 쓰면 틀린 날짜를 보여 준다."""
    store = "test-warm-cache-yesterday@example.com"
    key = forecast_service._warm_key((store, 37.566, 126.978, 7))
    try:
        warm_cache.save(key, {"made_on": "2000-01-01", "result": {"tomorrow": {"cups": 1}}})
        assert forecast_service.peek_forecast_cache(store, 37.566, 126.978, 7) is None
    finally:
        warm_cache.drop(key)


def test_예측_peek는_DB값을_낡음으로_돌려준다():
    """DB에서 집어 온 값은 fresh=False여야 엔드포인트가 백그라운드 재계산을 건다."""
    from datetime import datetime

    store = "test-warm-cache-today@example.com"
    key = forecast_service._warm_key((store, 37.566, 126.978, 7))
    today = datetime.now(forecast_service.KST).date().isoformat()
    try:
        warm_cache.save(key, {"made_on": today, "result": {"tomorrow": {"cups": 42}}})
        hit = forecast_service.peek_forecast_cache(store, 37.566, 126.978, 7)
        assert hit is not None, "DB에 오늘 만든 예측이 있으면 새 인스턴스도 즉시 응답해야 한다"
        result, fresh = hit
        assert result["tomorrow"]["cups"] == 42
        assert fresh is False
    finally:
        warm_cache.drop(key)
        forecast_service._forecast_cache.pop(
            forecast_service._forecast_key(store, 37.566, 126.978, 7), None
        )


def test_저장_실패해도_예외가_새지_않는다(monkeypatch):
    """캐시는 없어도 되는 물건 — 저장이 실패했다고 계산 결과를 못 돌려주면 본말전도다."""
    def boom(*a, **k):
        raise RuntimeError("DB가 잠깐 흔들림")

    monkeypatch.setattr("app.services.ai.warm_cache.SessionLocal", boom)
    warm_cache.save(KEY, {"v": 1})          # 예외 없이 넘어가야 한다
    assert warm_cache.load(KEY, 3600) is None
    warm_cache.drop(KEY)
    warm_cache.drop_prefix("test:warm-cache:")


def test_직렬화_못하는_값은_저장을_건너뛴다():
    class NotJson:
        __slots__ = ()

    # default=str 로 문자열이 되므로 저장은 성공하고, 읽을 때 문자열로 돌아온다.
    # 중요한 건 예외가 새지 않는 것.
    warm_cache.save(KEY, {"obj": NotJson()})
    hit = warm_cache.load(KEY, 3600)
    assert hit is not None
    assert isinstance(hit[0]["obj"], str)
    assert json.dumps(hit[0])  # 되읽은 값은 다시 직렬화 가능해야 한다
