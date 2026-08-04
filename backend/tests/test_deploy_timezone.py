"""배포 컨테이너의 시간대가 KST인지 검증 (백엔드 B)

배경(운영에서만 터지는 사고): 코드 상당수가 date.today()/datetime.now()로 '오늘'을
구한다 — 로컬 시간대가 한국이어야 맞는 코드다(insight_service._now의 "현지 시간대",
_aware의 "naive는 현지 시간대로 간주"). 그런데 컨테이너 기본 시간대는 UTC라서,
자정~오전 9시(KST)에는 '오늘'이 어제로 계산된다.

하필 그 시간대에 도는 것들이다: 아침 브리핑(기본 8시), 리포트, 정산 입금 예정일,
내일 수요 예측. 전부 조용히 하루씩 밀리고 에러는 나지 않는다.

팀원 PC와 이 테스트 환경은 KST라 로컬에서는 절대 재현되지 않는다 — 그래서
'런타임이 KST인가'가 아니라 '배포 이미지가 KST를 보장하는가'를 본다.
"""
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

import app.main as main_module

DOCKERFILE = Path(__file__).resolve().parents[1] / "Dockerfile"


def test_dockerfile_sets_kst():
    """배포 이미지가 TZ=Asia/Seoul을 지정해야 한다."""
    text = DOCKERFILE.read_text(encoding="utf-8")
    assert re.search(r"TZ\s*=\s*Asia/Seoul", text), (
        "Dockerfile에 TZ=Asia/Seoul이 없다 — 컨테이너가 UTC로 떠서 "
        "자정~오전 9시(KST)에 '오늘'이 어제가 된다"
    )


def test_dockerfile_installs_tzdata():
    """zoneinfo가 없으면 TZ 설정은 조용히 무시되고 UTC로 남는다.

    '고쳤다고 믿는 채로 안 고쳐진 상태'가 가장 위험하므로 tzdata 설치를 못 박는다.
    """
    text = DOCKERFILE.read_text(encoding="utf-8")
    assert "tzdata" in text, (
        "Dockerfile이 tzdata를 설치하지 않는다 — TZ=Asia/Seoul이 무시될 수 있다"
    )


def test_timezone_guard_warns_when_not_kst(caplog):
    """UTC로 뜬 서버는 기동 로그에 경고를 남겨야 한다 (조용한 실패 방지)."""

    class UTCDatetime(datetime):
        @classmethod
        def now(cls, tz=None):
            base = cls(2026, 8, 3, 23, 0)  # 한국은 8/4 08:00 — 아침 브리핑이 나가는 시각
            return base if tz is None else base.replace(tzinfo=timezone.utc).astimezone(tz)

        def astimezone(self, tz=None):
            if tz is None:
                return self.replace(tzinfo=timezone.utc)
            return datetime.astimezone(self, tz)

    import datetime as datetime_module

    with patch.object(datetime_module, "datetime", UTCDatetime):
        with caplog.at_level("ERROR"):
            main_module._check_timezone()

    assert any("시간대 경고" in r.message for r in caplog.records), (
        "KST가 아닌데도 기동 경고가 없다 — 날짜가 밀려도 아무도 모르게 된다"
    )


def test_timezone_guard_silent_on_kst(caplog):
    """정상(KST)일 때는 ERROR를 남기지 않는다 — 경고가 늘 떠 있으면 무시하게 된다."""
    offset = datetime.now().astimezone().utcoffset()
    if offset != timedelta(hours=9):
        import pytest

        pytest.skip("이 실행 환경이 KST가 아니라 검증할 수 없다")

    with caplog.at_level("ERROR"):
        main_module._check_timezone()
    assert not [r for r in caplog.records if "시간대 경고" in r.message]
