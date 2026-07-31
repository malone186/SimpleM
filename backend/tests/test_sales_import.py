"""POS 매출 파일 임포트 파이프라인 테스트 (결정론 부분 — LLM 없이 휴리스틱 경로).

parse_grid → 휴리스틱 매핑 → build_preview(메뉴 매칭) → save_import(매칭 행만 저장).
"""
import os

import pytest

pd = pytest.importorskip("pandas")  # pandas 없으면 스킵

os.environ.setdefault("DATABASE_URL", "sqlite:///./_test_sales_import.db")
os.environ.setdefault("ALLOW_SQLITE_FALLBACK", "1")
os.environ.pop("GEMINI_API_KEY", None)
os.environ.pop("GOOGLE_API_KEY", None)

from app.core.database import Base, engine  # noqa: E402
import app.models  # noqa: E402,F401
from app.services.ai import sales_import_service as S  # noqa: E402
from app.services.ai.document_service import _session  # noqa: E402
from app.models.inventory import Menu, Sale  # noqa: E402

STORE = "cafe_import@test.com"

CSV = (
    "○○카페 매출내역,,,\n"
    "기간: 2026-07-30,,,\n"
    "판매일시,상품명,판매수량,판매금액\n"
    "2026-07-30 09:12,아메리카노,2,8000\n"
    "2026-07-30 10:05,카페라떼,1,5000\n"
    ",,,\n"
)


@pytest.fixture(scope="module", autouse=True)
def _setup():
    Base.metadata.create_all(bind=engine)
    with _session() as db:
        if not db.query(Menu).filter(Menu.store_id == STORE, Menu.name == "아메리카노").first():
            db.add(Menu(name="아메리카노", selling_price=4000, store_id=STORE))
            db.commit()
    yield


def test_parse_and_map():
    grid = S.parse_grid(CSV.encode("utf-8"), "sales.csv")
    assert len(grid) == 5  # 잡정보 2 + 헤더 1 + 데이터 2 (빈 합계행 제거됨)
    mp = S._heuristic_mapping(grid)
    assert mp["header_row"] == 2
    assert (mp["date_col"], mp["item_col"], mp["qty_col"], mp["amount_col"]) == (0, 1, 2, 3)


def test_preview_matches_menu_and_flags_unknown():
    grid = S.parse_grid(CSV.encode("utf-8"), "sales.csv")
    pv = S.build_preview(STORE, grid, S._heuristic_mapping(grid))
    assert pv["summary"]["total_rows"] == 2
    assert pv["summary"]["matched"] == 1  # 아메리카노만 매칭
    americano = next(r for r in pv["rows"] if r["menu_name"] == "아메리카노")
    assert americano["menu_id"] is not None and americano["total_price"] == 8000
    latte = next(r for r in pv["rows"] if r["menu_name"] == "카페라떼")
    assert latte["menu_id"] is None and "메뉴 매칭 안 됨" in latte["warnings"]


def test_save_only_matched_rows():
    grid = S.parse_grid(CSV.encode("utf-8"), "sales.csv")
    pv = S.build_preview(STORE, grid, S._heuristic_mapping(grid))
    before = None
    with _session() as db:
        before = db.query(Sale).filter(Sale.store_id == STORE).count()
    result = S.save_import(STORE, pv["rows"])
    assert result["created"] == 1 and result["total"] == 8000  # 미매칭 카페라떼 제외
    with _session() as db:
        assert db.query(Sale).filter(Sale.store_id == STORE).count() == before + 1
