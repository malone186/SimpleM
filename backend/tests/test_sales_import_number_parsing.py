"""POS 매출 파일의 금액·수량 칸을 정수로 읽는 규칙 (_to_int) 회귀 테스트.

예전엔 숫자가 아닌 문자를 전부 지워서 "3,500.00"이 350000(100배)으로 들어갔다.
매출이 통째로 100배가 되는 사고라 소수점·천 단위 구분자를 케이스별로 못박아 둔다.
"""
import os

import pytest

os.environ.setdefault("DATABASE_URL", "sqlite:///./_test_sales_import_numbers.db")
os.environ.setdefault("ALLOW_SQLITE_FALLBACK", "1")

from app.services.ai.sales_import_service import _to_int  # noqa: E402


@pytest.mark.parametrize(
    "raw, expected",
    [
        # 소수점이 붙은 금액 — 이게 100배로 들어가던 사고 지점
        ("3,500.00", 3500),
        ("3500.00", 3500),
        ("12.34", 12),
        # 천 단위 구분자만 있는 흔한 형태
        ("3,500", 3500),
        ("3500", 3500),
        ("1,234,567", 1234567),
        # 유럽식 표기 (마침표가 천 단위, 쉼표가 소수점)
        ("1.234.567", 1234567),
        ("3.500,00", 3500),
        # 통화 기호·단위가 섞인 칸
        ("₩3,500", 3500),
        ("3,500원", 3500),
        # 음수(취소 전표)와 0
        ("-1,200", -1200),
        ("0", 0),
        # 수량 칸의 소수 — 반올림해서 정수 잔 수로
        ("1.5", 2),
        # 값이 없거나 숫자가 아닌 칸
        ("", None),
        ("-", None),
        (None, None),
        ("abc", None),
    ],
)
def test_to_int(raw, expected):
    assert _to_int(raw) == expected
