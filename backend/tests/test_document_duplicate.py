"""서류 중복 생성 방지 테스트 (백엔드 B) — ERP-12

생성은 1~2초 걸리는데 그동안 버튼은 그대로 눌린다. 한 번 더 누르거나 재시도가 겹치면
내용이 똑같은 발주서가 나란히 쌓였고, 임금명세서는 삭제도 막혀 있어 지우지도 못했다.
앱에서도 연타를 막지만(DocumentScreen) 챗봇·재시도 등 다른 경로가 있어 서버가 마지막
방어선이다 — 짧은 시간 안에 들어온 '완전히 같은 문서'는 새로 만들지 않고 방금 것을 준다.
"""
import pytest

import app.models  # noqa: F401 — 모든 모델을 Base.metadata에 등록
from app.schemas.ai import ComplianceItemCreate
from app.services.ai import document_service as D

STORE = "doc-dup@test.com"


def _cleanup():
    from app.models.ai import ComplianceItem, GeneratedDocument

    with D._session() as db:
        db.query(GeneratedDocument).filter(GeneratedDocument.store_id == STORE).delete()
        db.query(ComplianceItem).filter(ComplianceItem.store_id == STORE).delete()
        db.commit()


@pytest.fixture(autouse=True)
def clean():
    _cleanup()
    yield
    _cleanup()


def test_same_document_twice_reuses_the_first(monkeypatch):
    """연타로 같은 문서가 두 번 저장되면 두 번째는 방금 만든 문서를 그대로 돌려준다."""
    content = {"items": [{"name": "우유", "quantity": 5}], "note": "초안"}

    first = D._save_document(STORE, "purchase_order", "발주서 초안 (2026-08-13)", content, period="2026-08-13")
    second = D._save_document(STORE, "purchase_order", "발주서 초안 (2026-08-13)", content, period="2026-08-13")

    assert second["id"] == first["id"]
    assert len(D.list_documents(STORE)) == 1


def test_different_content_still_creates_a_new_document():
    """내용이 달라졌으면 다른 문서다 — 재고가 바뀐 뒤 다시 뽑는 정상 흐름을 막지 않는다."""
    D._save_document(STORE, "purchase_order", "발주서 초안 (2026-08-13)", {"items": [{"name": "우유"}]})
    D._save_document(STORE, "purchase_order", "발주서 초안 (2026-08-13)", {"items": [{"name": "원두"}]})

    assert len(D.list_documents(STORE)) == 2


def test_window_expires_so_regeneration_is_possible(monkeypatch):
    """시간 창을 벗어나면 같은 내용이라도 새로 만든다 (일부러 다시 뽑는 경우)."""
    content = {"items": []}
    first = D._save_document(STORE, "stocktake_sheet", "재고실사표 (2026-08-13)", content)

    monkeypatch.setattr(D, "_DUPLICATE_WINDOW_SEC", 0)
    second = D._save_document(STORE, "stocktake_sheet", "재고실사표 (2026-08-13)", content)

    assert second["id"] != first["id"]
    assert len(D.list_documents(STORE)) == 2


def test_same_document_for_other_store_is_untouched():
    """중복 판정은 매장 안에서만 — 남의 매장 문서를 돌려주면 큰일 난다."""
    other = "doc-dup-other@test.com"
    content = {"items": []}
    try:
        mine = D._save_document(STORE, "stocktake_sheet", "재고실사표 (2026-08-13)", content)
        theirs = D._save_document(other, "stocktake_sheet", "재고실사표 (2026-08-13)", content)
        assert mine["id"] != theirs["id"]
    finally:
        from app.models.ai import GeneratedDocument

        with D._session() as db:
            db.query(GeneratedDocument).filter(GeneratedDocument.store_id == other).delete()
            db.commit()


def test_compliance_item_is_not_registered_twice():
    """갱신 서류도 이름·만료일이 같으면 같은 서류 — 등록 연타로 두 줄이 되지 않는다."""
    req = ComplianceItemCreate(name="보건증-홍길동", expiry_date="2026-12-31")

    first = D.add_compliance_item(STORE, req)
    second = D.add_compliance_item(STORE, req)

    assert second["id"] == first["id"]
    assert len(D.list_compliance_items(STORE)) == 1

    # 만료일이 다르면 갱신된 새 서류다 — 이건 따로 등록돼야 한다
    D.add_compliance_item(STORE, ComplianceItemCreate(name="보건증-홍길동", expiry_date="2027-12-31"))
    assert len(D.list_compliance_items(STORE)) == 2
