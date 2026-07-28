"""할 일 목록 단위 테스트 (백엔드 B) — sqlite 인메모리 DB 사용

챗봇이 직접 항목을 추가하는 기능이라, '중복이 쌓이지 않는지'와
'남의 할 일을 건드리지 못하는지'를 특히 본다.
"""
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

import app.core.database as core_db
import app.models  # noqa: F401 — 모든 모델을 Base.metadata에 등록
from app.core.database import Base
from app.models.ai import TodoItem
from app.schemas.ai import TodoCreate, TodoUpdate
from app.services.ai import todo_service as ts

STORE = "owner@test.com"
OTHER = "other@test.com"


@pytest.fixture()
def db(monkeypatch):
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    TestSession = sessionmaker(bind=engine, expire_on_commit=False)
    monkeypatch.setattr(core_db, "SessionLocal", TestSession)
    session = TestSession()
    yield session
    session.close()
    engine.dispose()


# ---------------------------------------------------------------------------
# 추가
# ---------------------------------------------------------------------------

def test_add_and_list(db):
    ts.add_todo(STORE, TodoCreate(title="원두 발주"), source="ai")
    ts.add_todo(STORE, TodoCreate(title="냅킨 주문", note="1층 창고 비었음"))

    todos = ts.list_todos(STORE)
    assert {t["title"] for t in todos} == {"원두 발주", "냅킨 주문"}
    assert next(t for t in todos if t["title"] == "원두 발주")["source"] == "ai"
    assert next(t for t in todos if t["title"] == "냅킨 주문")["source"] == "owner"


def test_duplicate_title_returns_existing(db):
    """모델이 도구를 두 번 부르거나 사장님이 같은 말을 반복해도 줄이 두 개 쌓이면 안 된다."""
    first = ts.add_todo(STORE, TodoCreate(title="원두 발주"), source="ai")
    second = ts.add_todo(STORE, TodoCreate(title="원두 발주"), source="ai")

    assert first["id"] == second["id"]
    assert db.query(TodoItem).count() == 1


def test_duplicate_allowed_after_completion(db):
    """지난주에 끝낸 '원두 발주'가 이번 주 추가를 막으면 안 된다."""
    first = ts.add_todo(STORE, TodoCreate(title="원두 발주"))
    ts.complete_todo(STORE, first["id"])

    second = ts.add_todo(STORE, TodoCreate(title="원두 발주"))
    assert second["id"] != first["id"]


def test_title_is_trimmed_and_required(db):
    assert ts.add_todo(STORE, TodoCreate(title="  원두 발주  "))["title"] == "원두 발주"
    with pytest.raises(ts.TodoError):
        ts.add_todo(STORE, TodoCreate(title="   "))


def test_bad_due_date_rejected(db):
    with pytest.raises(ts.TodoError):
        ts.add_todo(STORE, TodoCreate(title="원두 발주", due_date="2026-13-45"))


# ---------------------------------------------------------------------------
# 정렬 — 미완료 먼저, 기한 임박 순
# ---------------------------------------------------------------------------

def test_ordering(db):
    ts.add_todo(STORE, TodoCreate(title="기한 없음"))
    ts.add_todo(STORE, TodoCreate(title="다음주", due_date="2026-08-10"))
    ts.add_todo(STORE, TodoCreate(title="내일", due_date="2026-07-29"))
    done = ts.add_todo(STORE, TodoCreate(title="끝난 일"))
    ts.complete_todo(STORE, done["id"])

    titles = [t["title"] for t in ts.list_todos(STORE)]
    assert titles == ["내일", "다음주", "기한 없음", "끝난 일"]


def test_completed_items_fade_out_after_a_while(db):
    """체크 직후엔 남아 있어야 되돌릴 수 있고, 오래된 건 목록에서 빠져야 한다."""
    fresh = ts.add_todo(STORE, TodoCreate(title="방금 끝낸 일"))
    old = ts.add_todo(STORE, TodoCreate(title="어제 끝낸 일"))
    ts.complete_todo(STORE, fresh["id"])
    ts.complete_todo(STORE, old["id"])

    stale = db.get(TodoItem, old["id"])
    stale.done_at = datetime.now(timezone.utc) - timedelta(hours=ts.DONE_VISIBLE_HOURS + 1)
    db.commit()

    titles = [t["title"] for t in ts.list_todos(STORE)]
    assert "방금 끝낸 일" in titles
    assert "어제 끝낸 일" not in titles


# ---------------------------------------------------------------------------
# 수정 · 완료 · 삭제
# ---------------------------------------------------------------------------

def test_partial_update_leaves_other_fields(db):
    t = ts.add_todo(STORE, TodoCreate(title="원두 발주", note="원래 메모"))
    updated = ts.update_todo(STORE, t["id"], TodoUpdate(done=True))

    assert updated["done"] is True
    assert updated["note"] == "원래 메모"      # 안 보낸 필드는 그대로
    assert updated["title"] == "원두 발주"


def test_uncomplete_clears_done_at(db):
    """잘못 체크했을 때 되돌리면 '언제 완료됐는지'도 지워져야 목록에서 안 사라진다."""
    t = ts.add_todo(STORE, TodoCreate(title="원두 발주"))
    ts.complete_todo(STORE, t["id"])
    ts.update_todo(STORE, t["id"], TodoUpdate(done=False))

    assert db.get(TodoItem, t["id"]).done_at is None


def test_delete(db):
    t = ts.add_todo(STORE, TodoCreate(title="원두 발주"))
    ts.delete_todo(STORE, t["id"])
    assert ts.list_todos(STORE) == []


# ---------------------------------------------------------------------------
# 매장 격리 — id만 알면 남의 할 일을 건드릴 수 있으면 안 된다
# ---------------------------------------------------------------------------

def test_cannot_touch_other_stores_todo(db):
    mine = ts.add_todo(STORE, TodoCreate(title="내 할 일"))
    theirs = ts.add_todo(OTHER, TodoCreate(title="남의 할 일"))

    assert [t["title"] for t in ts.list_todos(STORE)] == ["내 할 일"]

    for op in (
        lambda: ts.update_todo(STORE, theirs["id"], TodoUpdate(done=True)),
        lambda: ts.complete_todo(STORE, theirs["id"]),
        lambda: ts.delete_todo(STORE, theirs["id"]),
    ):
        with pytest.raises(ts.TodoError):
            op()

    assert db.get(TodoItem, theirs["id"]) is not None
    assert db.get(TodoItem, theirs["id"]).done is False
    assert db.get(TodoItem, mine["id"]) is not None


# ---------------------------------------------------------------------------
# 제목으로 찾기 — 챗봇이 id를 모른 채 "그거 했어"라고 할 때
# ---------------------------------------------------------------------------

def test_find_by_title_exact_and_partial(db):
    ts.add_todo(STORE, TodoCreate(title="원두 발주"))

    assert ts.find_by_title(STORE, "원두 발주")["title"] == "원두 발주"
    assert ts.find_by_title(STORE, "원두 발주하기")["title"] == "원두 발주"   # 부분 일치
    assert ts.find_by_title(STORE, "냅킨") is None


def test_find_by_title_gives_up_when_ambiguous(db):
    """후보가 여럿이면 임의로 고르지 말고 포기해야 한다 — 챗봇이 되물어야 하므로."""
    ts.add_todo(STORE, TodoCreate(title="원두 발주"))
    ts.add_todo(STORE, TodoCreate(title="원두 발주서 확인"))

    assert ts.find_by_title(STORE, "원두 발주") is not None   # 정확히 일치하는 게 있으면 그것
    assert ts.find_by_title(STORE, "원두") is None            # 둘 다 걸리면 포기


def test_find_by_title_ignores_completed(db):
    t = ts.add_todo(STORE, TodoCreate(title="원두 발주"))
    ts.complete_todo(STORE, t["id"])
    assert ts.find_by_title(STORE, "원두 발주") is None


# ---------------------------------------------------------------------------
# 챗봇 도구 — 에이전트가 받는 응답 형태
# ---------------------------------------------------------------------------

def test_chatbot_tool_adds_with_ai_source(db):
    import json

    from app.services.ai import todo_tools

    out = json.loads(todo_tools.add_todo.invoke({"store_id": STORE, "title": "원두 발주"}))
    assert out["source"] == "ai"
    assert out["note"] == "브루가 추가함"     # 대시보드에 누가 넣었는지 보이게


def test_chatbot_tool_reports_failure_instead_of_guessing(db):
    """못 찾았을 때 도구가 조용히 성공하면 챗봇이 '완료했다'고 거짓 보고를 한다."""
    import json

    from app.services.ai import todo_tools

    ts.add_todo(STORE, TodoCreate(title="원두 발주"))
    ts.add_todo(STORE, TodoCreate(title="원두 발주서 확인"))

    out = json.loads(todo_tools.complete_todo.invoke({"store_id": STORE, "title": "원두"}))
    assert out["ok"] is False
    assert len(out["todos"]) == 2            # 되물을 수 있게 후보를 함께 준다
