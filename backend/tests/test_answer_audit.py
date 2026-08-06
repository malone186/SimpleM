"""답변 자동 감사 검증 (백엔드 B)

운영 대화에서 사고를 스스로 잡아 두는 계층이다. 여기가 조용히 고장 나면 증상이 없다 —
사고 후보가 안 쌓이고, 골든 세트는 그대로이며, 아무 에러도 안 난다. 그래서 '무엇을
잡아야 하는가'와 '무엇을 잡으면 안 되는가'를 양쪽 다 고정해 둔다.

특히 오탐(정상 대화가 사고로 쌓이는 것)이 위험하다. 후보가 쓰레기로 차면 재현 검증에
무료 한도를 태우고, 골든 세트도 같이 오염된다.
"""
import pytest

from app.services.ai import answer_audit

STORE = "audit-test@example.com"


@pytest.fixture(autouse=True)
def clean():
    """이 테스트가 만든 후보만 지운다 (공유 DB — 남의 매장 행은 건드리지 않는다)."""
    def _wipe():
        import app.models  # noqa: F401
        from app.core.database import SessionLocal
        from app.models.ai import ChatIncident

        db = SessionLocal()
        try:
            db.query(ChatIncident).filter(ChatIncident.store_id == STORE).delete()
            db.commit()
        finally:
            db.close()

    _wipe()
    yield
    _wipe()


# ---------------------------------------------------------------------------
# 부정 반응 감지 — 감시 규칙이 못 잡는 오답의 유일한 실전 신호
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("text", [
    "아니야 어제 팔았잖아",
    "그게 아니라 어제 말이야",
    "틀렸어",
    "왜 없다고 해?",
    "다시 확인해줘",
    "이상해 말이 안 되는데",
])
def test_dissatisfaction_detected(text):
    assert answer_audit.looks_dissatisfied(text), f"{text!r}를 부정으로 못 읽었다"


@pytest.mark.parametrize("text", [
    "고마워",
    "아니 근데 그건 어떻게 해?",   # 감탄사로 쓰인 '아니'는 불만이 아니다
    "매출 얼마야?",
    "",
])
def test_normal_message_is_not_dissatisfaction(text):
    assert not answer_audit.looks_dissatisfied(text)


def test_followup_records_previous_turn():
    history = [
        {"role": "user", "text": "어제 매출 얼마야?"},
        {"role": "model", "text": "어제는 판매 내역이 없습니다."},
    ]
    assert answer_audit.check_followup(STORE, "아니야 어제 팔았잖아", history)

    rows = answer_audit.list_incidents(store_id=STORE)
    assert len(rows) == 1
    assert rows[0]["rule"] == "사장님부정"
    # 부정한 발화가 아니라 '틀린 답을 부른 질문'이 문항이 되어야 한다
    assert rows[0]["question"] == "어제 매출 얼마야?"


def test_followup_ignores_normal_message():
    history = [
        {"role": "user", "text": "어제 매출 얼마야?"},
        {"role": "model", "text": "어제는 159,000원입니다."},
    ]
    assert not answer_audit.check_followup(STORE, "고마워", history)
    assert answer_audit.list_incidents(store_id=STORE) == []


# ---------------------------------------------------------------------------
# 턴 감사 — 규칙을 어긴 턴만 쌓인다
# ---------------------------------------------------------------------------

def test_clean_turn_records_nothing():
    """정상 턴은 DB를 건드리지 않는다 — 여기가 무너지면 후보가 정상 대화로 뒤덮인다."""
    hits = answer_audit.audit_turn(
        STORE, "어제 매출 얼마야?", "어제는 159,000원입니다.",
        tools=["get_sales_history"], experts=["data_expert"], ms=3000)
    assert hits == []
    assert answer_audit.list_incidents(store_id=STORE) == []


def test_hallucinated_number_is_recorded():
    hits = answer_audit.audit_turn(
        STORE, "어제 매출 얼마야?", "어제는 159,000원입니다.",
        tools=[], experts=[], ms=1000)
    assert "무근거숫자" in hits
    rows = answer_audit.list_incidents(store_id=STORE)
    assert rows and rows[0]["rule"] == "무근거숫자"


def test_general_knowledge_question_is_not_flagged():
    """"원두 1kg 얼마야?"에 시세를 답한 건 조회 없이 답해도 정상이다 (오탐 방지)."""
    assert not answer_audit.looks_like_store_question("원두 1kg 보통 얼마야?")
    hits = answer_audit.audit_turn(
        STORE, "원두 1kg 보통 얼마야?", "보통 20,000원 안팎입니다.",
        tools=[], experts=[],
        expects_data=answer_audit.looks_like_store_question("원두 1kg 보통 얼마야?"))
    assert hits == []


def test_store_question_is_recognized():
    assert answer_audit.looks_like_store_question("우리 매장 어제 매출 얼마야?")
    assert answer_audit.looks_like_store_question("재고 부족한 거 뭐야?")


def test_same_question_increments_hits_not_rows():
    """같은 사장님이 같은 질문을 반복해도 문항이 여러 개 생기면 안 된다."""
    for _ in range(3):
        answer_audit.audit_turn(STORE, "어제 매출 얼마야?", "어제는 159,000원입니다.",
                                tools=[], experts=[])
    rows = [r for r in answer_audit.list_incidents(store_id=STORE) if r["rule"] == "무근거숫자"]
    assert len(rows) == 1
    assert rows[0]["hits"] == 3


def test_registered_incident_is_not_reopened():
    """이미 등록·기각된 건이 다시 pending으로 돌아가면 harvest가 무한히 재등록한다."""
    answer_audit.audit_turn(STORE, "어제 매출 얼마야?", "어제는 159,000원입니다.",
                            tools=[], experts=[])
    incident_id = answer_audit.list_incidents(store_id=STORE)[0]["id"]
    answer_audit.set_status(incident_id, "registered")

    answer_audit.audit_turn(STORE, "어제 매출 얼마야?", "어제는 159,000원입니다.",
                            tools=[], experts=[])
    assert answer_audit.list_incidents(store_id=STORE)[0]["status"] == "registered"


# ---------------------------------------------------------------------------
# 저장 전 마스킹 — 후보는 나중에 저장소에 커밋되는 파일로 올라갈 수 있다
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("raw,gone", [
    ("owner@cafe.com으로 보내줘", "owner@cafe.com"),
    ("010-1234-5678로 연락해", "010-1234-5678"),
])
def test_contacts_are_masked_before_storage(raw, gone):
    answer_audit.audit_turn(STORE, raw, "**처리했습니다**", tools=["x"], experts=["y"])
    rows = answer_audit.list_incidents(store_id=STORE)
    assert rows, "마크다운 노출이 잡혀야 한다"
    assert gone not in rows[0]["question"]
