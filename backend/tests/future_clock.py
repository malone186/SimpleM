"""시계를 미래로 돌려 테스트를 돌리는 pytest 플러그인 — '시한폭탄 테스트' 탐지용.

왜 필요한가
----------
날짜를 코드에 박아 둔 테스트는 시간이 지나면 저 혼자 깨진다. 코드는 그대로인데
어느 날 갑자기 CI가 빨간불이 되고, 원인을 그날 들어온 커밋에서 찾게 된다.

실제 사고 (2026-08-18): tests/test_nearby_watch.py가 날짜를 2026-08-01~04로 박아
뒀는데, pending_changes는 '실제 오늘' 기준 14일 안의 변화만 알린다. 8/17까지는
통과하다 8/18에 창 밖으로 밀려 3건이 한꺼번에 실패했다. 마침 그날 들어온 팀원
커밋을 의심하느라 시간을 썼다 — 커밋은 죄가 없었다.

쓰는 법
------
    PYTHONPATH=tests python -m pytest tests/ -q -p future_clock          # 기본 60일 뒤
    FUTURE_DAYS=180 PYTHONPATH=tests python -m pytest tests/ -q -p future_clock

여기서 깨지는 테스트가 '언젠가 저절로 깨질 테스트'다. 고치는 방법은 박아 둔 날짜를
오늘 기준 상대값으로 바꾸는 것이다 (test_nearby_watch.py 상단 참고).

읽는 법 — 오탐 주의
-----------------
이 플러그인은 **서비스가 보는 오늘만** 민다. 테스트가 date.today()로 진짜 오늘을
쓰고 있으면 둘이 어긋나 실패하는데, 그건 시한폭탄이 아니라 이 도구의 부작용이다.
실제로는 둘이 함께 움직이기 때문이다. 실패를 보면 먼저 이 경우인지 가려야 한다.
"""
import datetime
import os
import sys

import pytest

SHIFT_DAYS = int(os.getenv("FUTURE_DAYS", "60"))


@pytest.fixture(autouse=True)
def _shift_today(monkeypatch):
    import app.utils.datetime_kst as dk

    real_today = dk.today_kst

    def fake_today() -> datetime.date:
        return real_today() + datetime.timedelta(days=SHIFT_DAYS)

    # 서비스들이 `from app.utils.datetime_kst import today_kst` 로 자기 이름공간에
    # 직접 들여온 참조까지 전부 바꿔야 한다 — 원본 모듈만 바꾸면 안 먹는다.
    for mod in list(sys.modules.values()):
        name = getattr(mod, "__name__", "")
        if mod is not None and name.startswith("app.") and hasattr(mod, "today_kst"):
            monkeypatch.setattr(mod, "today_kst", fake_today, raising=False)
    monkeypatch.setattr(dk, "today_kst", fake_today)
