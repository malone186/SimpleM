"""행사 이름 정리 (백엔드 B)

행사는 네이버 뉴스·블로그 글 '제목'에서 뽑아 오므로, 사람이 읽을 이름이 아니라
게시물 제목 모양으로 들어온다. 그대로 두면 푸시 제목과 지도 카드에 그대로 나간다.
실제로 받은 알림 제목이 이랬다:

    🎪 D-1 · [마포구립서강도서관] 8월/청년 Book Cx클래스 [떠나고, 쓰다 - (0.9km)
"""
import pytest

from app.services.ai.forecast_service import _cut_title
from app.services.ai.nearby_event_service import DISPLAY_LIMIT, clean_event_name


@pytest.mark.parametrize("raw,expected_name,expected_host", [
    # 주최기관 대괄호 + 월 표기 + 잘려서 안 닫힌 대괄호 (실제 수집 사례)
    ("[마포구립서강도서관] 8월/청년 Book Cx클래스 [떠나고, 쓰다 -",
     "청년 Book Cx클래스", "마포구립서강도서관"),
    ("[미래한강본부] 2026 한강페스티벌-여름 [Hangang River",
     "2026 한강페스티벌-여름", "미래한강본부"),
    ("(서울시) 8월 야시장", "야시장", "서울시"),
    # 손댈 필요가 없는 이름은 그대로 둔다
    ("2026 한강 여름축제", "2026 한강 여름축제", ""),
    ("홍대 프리마켓 (8/9~8/10)", "홍대 프리마켓 (8/9~8/10)", ""),
    # 뒤쪽 괄호는 이름의 일부다 — 건드리지 않는다
    ("차슬아 개인전 [동굴로]", "차슬아 개인전 [동굴로]", ""),
])
def test_clean_event_name(raw, expected_name, expected_host):
    name, host = clean_event_name(raw)
    assert name == expected_name
    assert host == expected_host


def test_bracket_only_name_survives():
    """대괄호가 이름 전부인 경우 — 떼어내면 남는 게 없으므로 그대로 둔다.

    앞뒤를 함께 깎던 시절엔 여는 괄호만 사라져 '동굴로]'라는 이름이 나왔다.
    """
    assert clean_event_name("[동굴로]")[0] == "[동굴로]"


def test_empty_input():
    assert clean_event_name("") == ("", "")
    assert clean_event_name(None) == ("", "")


def test_long_name_drops_trailing_subtitle_before_ellipsis():
    """긴 이름은 말줄임보다 뒤쪽 부제 괄호를 먼저 뗀다 — 그쪽이 읽힌다."""
    name, host = clean_event_name(
        "[마포구립서강도서관] 8월/청년 Book Cx클래스 [떠나고, 쓰다 - 여행 에세이 쓰기]")
    assert name == "청년 Book Cx클래스"
    assert host == "마포구립서강도서관"
    # 짧은 이름의 괄호는 이름의 일부다 — 떼면 안 된다
    assert clean_event_name("차슬아 개인전 [동굴로]")[0] == "차슬아 개인전 [동굴로]"


def test_long_name_is_cut_at_word_boundary():
    raw = "서울특별시 마포구 합정동 여름 문화 축제 한마당 프로그램 종합 안내문"
    name, _ = clean_event_name(raw)
    assert name.endswith("…")
    assert len(name) <= DISPLAY_LIMIT + 1
    assert not name.rstrip("…").endswith(" ")


def test_source_truncation_keeps_whole_words():
    """수집 단계에서 40자로 뚝 자르던 것이 '두 번째 일요' 같은 꼬리를 만들었다."""
    raw = "[마포구립서강도서관] 8월/어린이메이킹 [행복맘껏time] 두 번째 일요일 프로그램"
    cut = _cut_title(raw)
    assert len(cut) <= 50
    assert not cut.endswith(" ")
    # 잘렸다면 단어 중간이 아니라 공백 자리에서 잘려야 한다
    assert cut == raw or raw[len(cut)] == " "
