"""답변 자동 감사 (백엔드 B) — 운영 대화에서 사고를 스스로 찾아낸다

[왜 필요한가] 골든 회귀 테스트(evals/)는 '적어 둔 질문'만 지킨다. 그런데 사고가 났을 때
사람이 그 질문을 파일에 추가해 줄 거라는 전제는 현실적이지 않다 — 바쁜 와중에 기억해서
적는 일은 결국 안 일어나고, 세트는 처음 만든 20문항에서 영영 자라지 않는다.

그래서 운영 대화 매 턴에 감시 규칙을 돌려 사고를 자동으로 잡아 둔다. 여기 쌓인 후보는
evals/harvest.py가 재현 검증한 뒤 골든 세트에 자동 등록한다.

[비용] 정상 턴에서는 정규식·집합 연산만 돌고 끝난다 — LLM 호출도, DB 접근도 없다.
규칙을 어긴 턴에서만 한 번 기록한다. 그래서 대화 응답 시간에 실질적인 영향이 없다.

[판정 등급]
  fail — 확실한 버그. 사고 후보로 기록한다.
  warn — 사람이 봐야 하는 신호. 오탐이 섞이므로 기록하지 않는다(쌓이면 쓰레기가 된다).

이 모듈의 어떤 함수도 예외를 밖으로 내보내지 않는다. 감사가 대화를 죽이면 본말전도다.
"""

from __future__ import annotations

import logging
import re
from typing import Any, Callable, Optional

logger = logging.getLogger(__name__)

# 금액·수량으로 볼 하한. 이보다 작은 수는 날짜·개수·순위라 근거 대조가 무의미하다.
NUMERIC_FLOOR = 1000
# 연도로 보이는 값은 근거 대조에서 뺀다 (2026년 등)
YEAR_RANGE = (1900, 2100)

_EOK = re.compile(r"(\d+)억(?:\s*(\d+)만)?(?:\s*(\d+))?")
_MAN = re.compile(r"(\d+)만(?:\s*(\d+))?")
_PLAIN = re.compile(r"\d+")

# 채팅 화면은 일반 텍스트만 그린다 — 이 기호들이 답변에 남으면 그대로 보인다
_MARKDOWN = re.compile(r"\*\*|^\s*[*#]\s|\|\s*-{2,}\s*\||`{1,3}[^`]")
# 도구 결과의 영문 키를 한글로 안 바꾸고 그대로 옮긴 흔적
_ENGLISH_KEYS = (
    "total_revenue", "total_cups", "change_pct", "ai_advice", "by_menu", "by_category",
    "store_id", "period_days", "created_at", "highlights", "selling_price", "cost_ratio",
)
_JSON_SHAPE = re.compile(r'\{\s*"[a-z_]+"\s*:')
_EMAIL = re.compile(r"[\w.+-]+@[\w-]+\.[\w.]+")
# 도구가 있는데도 못 한다고 답하는 라우팅 실패의 흔적
_REFUSAL = (
    "지원하지 않는", "지원하지 않아", "처리할 수 없", "제 담당 도구로는",
    "기능이 없습니다", "도와드릴 수 없",
)

# 사장님이 답을 받고 곧바로 내는 부정 신호 — 이보다 정확한 오답 라벨은 없다.
# 판정은 정규식으로 끝낸다(LLM을 한 번 더 부르면 턴마다 무료 한도를 갉아먹는다).
_DISSATISFIED = re.compile(
    r"(아니(야|요|잖|라|다)|틀렸|틀린|그게\s*아니|잘못\s*(됐|알|말)|왜\s*없다고|"
    r"없다니|다시\s*(해|알아|확인)|이상해|말이\s*안|엉뚱)"
)
# "아니 근데", "아니 그거 말고 이거" 처럼 감탄사로 쓰인 '아니'는 불만이 아니다
_FILLER_START = re.compile(r"^\s*아니\s*[,\s]*(근데|그럼|그러면|저기|참)")


# ---------------------------------------------------------------------------
# 숫자 읽기 — 채점과 감시가 같이 쓴다
# ---------------------------------------------------------------------------

def extract_numbers(text: str) -> set[int]:
    """답변에서 숫자를 뽑는다. "2만 4,600원"과 "24600원"을 같은 값으로 본다.

    모델은 같은 금액을 여러 표기로 쓴다 — 표기를 통일하지 않으면 맞는 답도 오답이 된다.
    """
    t = (text or "").replace(",", "")
    found: set[int] = set()

    def _eat(pattern: re.Pattern, scale: tuple[int, ...]) -> None:
        nonlocal t
        out = []
        last = 0
        for m in pattern.finditer(t):
            value = 0
            for group, unit in zip(m.groups(), scale):
                if group:
                    value += int(group) * unit
            found.add(value)
            out.append(t[last:m.start()])
            last = m.end()
        out.append(t[last:])
        t = " ".join(out)

    _eat(_EOK, (100_000_000, 10_000, 1))
    _eat(_MAN, (10_000, 1))
    for m in _PLAIN.finditer(t):
        found.add(int(m.group()))
    return found


def contains_number(text: str, target: int, tolerance: float = 0.005) -> bool:
    """답변이 target을 말하고 있는가. 반올림 표기를 허용하려고 0.5% 오차를 준다."""
    numbers = extract_numbers(text)
    if target in numbers:
        return True
    if target == 0:
        return False
    return any(abs(n - target) / abs(target) <= tolerance for n in numbers)


def contains_text(text: str, target: str) -> bool:
    """문자열 정답(메뉴 이름 등) 포함 여부 — 공백만 무시하고 비교한다."""
    def norm(s: str) -> str:
        return re.sub(r"\s+", "", s or "")
    return norm(target) in norm(text)


def big_numbers(text: str) -> set[int]:
    """금액으로 볼 만한 숫자만 (날짜·연도·작은 개수 제외)."""
    return {n for n in extract_numbers(text)
            if n >= NUMERIC_FLOOR and not (YEAR_RANGE[0] <= n <= YEAR_RANGE[1])}


# ---------------------------------------------------------------------------
# 감시 규칙 — 정답을 몰라도 적용된다
#
# turn 형태: {"question", "answer", "tools":[이름], "experts":[이름],
#             "tool_output": 합친 문자열, "ms": 소요 시간, "expects_data": bool}
# ---------------------------------------------------------------------------

Watcher = Callable[[dict[str, Any]], Optional[tuple[str, str]]]


def w_empty(turn: dict[str, Any]) -> Optional[tuple[str, str]]:
    """빈 답이거나 한 문장도 안 되는 답."""
    answer = (turn.get("answer") or "").strip()
    if not answer:
        return ("fail", "답변이 비어 있음")
    if len(answer) < 10:
        return ("fail", f"답변이 너무 짧음: {answer!r}")
    return None


def w_markdown(turn: dict[str, Any]) -> Optional[tuple[str, str]]:
    """마크다운 기호 노출 — 채팅 화면에 별표·백틱이 그대로 보인다."""
    m = _MARKDOWN.search(turn.get("answer") or "")
    if m:
        return ("fail", f"마크다운 기호가 답변에 남음: {m.group()!r}")
    return None


def w_internal_leak(turn: dict[str, Any]) -> Optional[tuple[str, str]]:
    """도구 결과의 영문 키·JSON 조각·매장 식별자(이메일)가 그대로 노출됐는가."""
    answer = turn.get("answer") or ""
    for key in _ENGLISH_KEYS:
        if key in answer:
            return ("fail", f"영문 키 '{key}'가 답변에 그대로 노출됨")
    if _JSON_SHAPE.search(answer):
        return ("fail", "JSON 조각이 답변에 그대로 노출됨")
    if _EMAIL.search(answer):
        return ("fail", "매장 식별자(이메일)가 답변에 노출됨")
    return None


def w_refusal(turn: dict[str, Any]) -> Optional[tuple[str, str]]:
    """'지원하지 않는 기능'이라는 답 — 전문가가 여럿 편성된 시스템에서는 대개 라우팅 실패다.

    진짜로 못 하는 요청도 있으므로 warn이다. 다만 도구를 한 번도 안 부르고 거절했다면
    아예 시도조차 안 한 것이라 등급을 올린다.
    """
    answer = turn.get("answer") or ""
    hit = next((p for p in _REFUSAL if p in answer), None)
    if not hit:
        return None
    if not turn.get("tools"):
        return ("fail", f"도구를 한 번도 부르지 않고 거절함 ('{hit}') — 라우팅 실패 의심")
    return ("warn", f"거절 문구 '{hit}' 포함 — 담당 전문가가 있는 요청인지 확인 필요")


def w_no_tool_but_numeric(turn: dict[str, Any]) -> Optional[tuple[str, str]]:
    """매장 데이터를 물었는데 조회 없이 금액을 말했다 — 가장 강한 환각 신호."""
    if not turn.get("expects_data") or turn.get("tools"):
        return None
    big = big_numbers(turn.get("answer") or "")
    if big:
        return ("fail", f"도구를 하나도 안 부르고 숫자를 답함: {sorted(big)[:5]}")
    return None


def w_unsupported_number(turn: dict[str, Any]) -> Optional[tuple[str, str]]:
    """답변의 금액이 도구 출력 어디에도 없다 — 지어냈거나 잘못 계산했다.

    모델이 합계·차이를 스스로 계산하는 정상적인 경우도 걸리므로 warn이다. 그래도 가치가
    있는 이유: 8/4 사고처럼 '그럴듯한데 근거가 없는 숫자'는 사람이 답변만 읽어서는
    절대 못 알아채고, 이 규칙은 질문이 무엇이든 자동으로 걸러 준다.
    """
    output = turn.get("tool_output") or ""
    if not output:
        return None
    haystack = output.replace(",", "")
    ghosts = [n for n in big_numbers(turn.get("answer") or "") if str(n) not in haystack]
    if ghosts:
        return ("warn", f"도구 결과에 없는 숫자: {sorted(ghosts)[:5]} (계산값일 수 있음)")
    return None


def w_slow(turn: dict[str, Any]) -> Optional[tuple[str, str]]:
    """너무 느린 턴 — 사장님이 기다리다 창을 닫는다."""
    ms = float(turn.get("ms") or 0)
    if ms > 40_000:
        return ("fail", f"응답에 {ms / 1000:.1f}초 — 40초 상한 초과")
    if ms > 20_000:
        return ("warn", f"응답에 {ms / 1000:.1f}초")
    return None


WATCHERS: list[tuple[str, Watcher]] = [
    ("빈답", w_empty),
    ("마크다운노출", w_markdown),
    ("내부값노출", w_internal_leak),
    ("거절", w_refusal),
    ("무근거숫자", w_no_tool_but_numeric),
    ("근거없는금액", w_unsupported_number),
    ("지연", w_slow),
]


def run_watchers(turn: dict[str, Any]) -> list[tuple[str, str, str]]:
    """모든 감시 규칙을 돌려 (규칙명, 등급, 설명) 목록을 준다. 규칙 자체의 예외는 삼킨다."""
    results = []
    for name, watcher in WATCHERS:
        try:
            hit = watcher(turn)
        except Exception as e:  # 감시 규칙 버그가 대화나 평가를 멈추면 안 된다
            results.append((name, "warn", f"규칙 실행 실패: {type(e).__name__}: {e}"))
            continue
        if hit:
            results.append((name, hit[0], hit[1]))
    return results


def paraphrase_disagreement(answers: list[str]) -> Optional[str]:
    """같은 뜻의 여러 표현이 서로 다른 금액을 답했는가.

    정답을 몰라도 버그를 확정할 수 있는 유일한 규칙이다 — 같은 질문에 두 답이 다르면
    적어도 하나는 틀렸다. 표현 하나만 우연히 맞는 경우도 이걸로 드러난다.
    """
    sets = [s for s in (big_numbers(a or "") for a in answers) if s]
    if len(sets) < 2:
        return None
    if not set.intersection(*sets):
        return f"표현마다 다른 금액을 답함: {[sorted(s)[:3] for s in sets]}"
    return None


# 매장 데이터를 묻는 질문인가 — '무근거숫자' 규칙을 적용할지 가르는 기준.
# 이게 없으면 "원두 1kg 보통 얼마야?" 같은 일반 지식 질문에 모델이 시세를 답한 것도
# 조회 없이 숫자를 답했다며 사고로 잡힌다(운영에서는 이런 질문이 흔하다).
_STORE_HINT = re.compile(
    r"(우리|저희|매장|가게|어제|오늘|이번\s*(주|달)|지난|최근|재고|매출|매상|지출|"
    r"발주|직원|알바|급여|월급|인건비|정산|카드|판매|팔았|남았|손님|단골|메뉴판)"
)


def looks_like_store_question(question: str) -> bool:
    """이 질문이 우리 매장 데이터에 대한 것인가 (일반 지식 질문과 구분)."""
    return bool(_STORE_HINT.search(question or ""))


def looks_dissatisfied(user_message: str) -> bool:
    """사장님의 다음 발화가 '방금 답이 틀렸다'는 신호인가.

    감시 규칙이 못 잡는 오답(숫자가 그럴듯하게 틀린 경우)을 잡는 유일한 실전 신호다.
    8/4 사고도 사장님이 "아니 어제 팔았잖아"라고 되받은 대화에서 드러났다.
    """
    text = (user_message or "").strip()
    if not text or _FILLER_START.match(text):
        return False
    return bool(_DISSATISFIED.search(text))


# ---------------------------------------------------------------------------
# 사고 후보 적재 — 규칙을 어긴 턴에서만 DB를 만진다
# ---------------------------------------------------------------------------

MAX_QUESTION = 300
# 한 매장에서 같은 질문이 반복돼도 행은 하나만 늘린다(hits 증가)
# \b는 쓰지 않는다 — 파이썬 정규식에서 한글도 단어 문자라, "010-1234-5678로"처럼 조사가
# 붙으면 끝의 \b가 성립하지 않아 마스킹이 통째로 빗나간다. 숫자 경계로 직접 잡는다.
_MASK_PATTERNS = (
    (re.compile(r"[\w.+-]+@[\w-]+\.[\w.]+"), "[메일]"),
    (re.compile(r"(?<!\d)01[016-9][-\s]?\d{3,4}[-\s]?\d{4}(?!\d)"), "[전화]"),
    (re.compile(r"(?<!\d)\d{6}[-\s]?\d{7}(?!\d)"), "[주민번호]"),
)


def mask_personal(text: str) -> str:
    """저장·등록되는 질문에서 연락처류를 가린다.

    사고 후보는 나중에 골든 세트(저장소에 커밋되는 파일)로 올라갈 수 있다. 사장님이
    질문에 적은 메일·전화번호가 그대로 팀 저장소에 남지 않도록 여기서 먼저 지운다.
    (사람 이름까지는 못 가린다 — README에 한계로 적어 두었다)
    """
    out = text or ""
    for pattern, replacement in _MASK_PATTERNS:
        out = pattern.sub(replacement, out)
    return out


def _norm_question(text: str) -> str:
    return re.sub(r"[\s.,!?~·\-—'\"()\[\]]+", "", (text or "")).lower()[:MAX_QUESTION]


def _session():
    import app.models  # noqa: F401 — 모든 모델을 Base.metadata에 등록
    from app.core.database import SessionLocal

    return SessionLocal()


def record_incident(store_id: str, question: str, answer: str, rule: str, detail: str,
                    tools: Optional[list[str]] = None,
                    experts: Optional[list[str]] = None) -> None:
    """사고 후보 한 건을 적재한다. 같은 매장의 같은 질문이면 횟수만 올린다."""
    from app.models.ai import ChatIncident

    question = mask_personal((question or "").strip())[:MAX_QUESTION]
    if not question:
        return
    key = _norm_question(question)
    try:
        db = _session()
        try:
            row = (
                db.query(ChatIncident)
                .filter(ChatIncident.store_id == store_id,
                        ChatIncident.norm_key == key,
                        ChatIncident.rule == rule)
                .first()
            )
            if row is None:
                row = ChatIncident(store_id=store_id, norm_key=key, question=question,
                                   rule=rule, hits=0, status="pending")
                db.add(row)
            row.hits = int(row.hits or 0) + 1
            row.detail = (detail or "")[:300]
            row.answer_excerpt = mask_personal(answer or "")[:500]
            row.tools = ",".join(tools or [])[:300]
            row.experts = ",".join(experts or [])[:200]
            # 이미 등록·기각 판정이 난 건은 상태를 되돌리지 않는다 (재등록 루프 방지)
            if row.status not in ("registered", "rejected"):
                row.status = "pending"
            db.commit()
        finally:
            db.close()
    except Exception:
        logger.exception("사고 후보 적재 실패 — 대화는 계속: %s / %s", store_id, rule)


def audit_turn(store_id: str, question: str, answer: str, tools: list[str],
               experts: list[str], expects_data: bool = True,
               ms: float = 0.0, tool_output: str = "") -> list[str]:
    """대화 한 턴을 감시 규칙으로 훑고, 어긴 규칙만 사고 후보로 남긴다.

    정상 턴이면 정규식만 돌고 끝난다 — DB도 LLM도 건드리지 않는다.
    반환: 걸린 규칙 이름 목록 (호출부 로깅용).
    """
    try:
        turn = {"question": question, "answer": answer, "tools": tools or [],
                "experts": experts or [], "expects_data": expects_data,
                "ms": ms, "tool_output": tool_output}
        hits = [(name, detail) for name, level, detail in run_watchers(turn) if level == "fail"]
        for name, detail in hits:
            record_incident(store_id, question, answer, name, detail, tools, experts)
        return [name for name, _ in hits]
    except Exception:
        logger.exception("턴 감사 실패 — 대화는 계속: %s", store_id)
        return []


def check_followup(store_id: str, user_message: str,
                   history: Optional[list[dict[str, Any]]]) -> bool:
    """이번 발화가 직전 답변에 대한 부정이면 그 턴을 사고 후보로 올린다.

    감시 규칙은 '형식이 잘못된 답'을 잡지만, 숫자가 그럴듯하게 틀린 답은 못 잡는다.
    그걸 아는 사람은 사장님뿐이고, 사장님은 별점을 누르는 대신 그냥 "아니 어제 팔았잖아"
    라고 되받는다 — 8/4 사고도 그 대화에서 드러났다. 그 반응을 라벨로 쓴다.

    반환: 사고 후보로 올렸으면 True.
    """
    try:
        if not looks_dissatisfied(user_message) or not history:
            return False

        def _text(item: dict[str, Any]) -> str:
            return (item.get("text") or item.get("content") or "").strip()

        # 뒤에서부터 '직전 답변'과 '그 답을 부른 질문'을 찾는다
        answer, question = "", ""
        for idx in range(len(history) - 1, -1, -1):
            if history[idx].get("role") in ("model", "assistant"):
                answer = _text(history[idx])
                for j in range(idx - 1, -1, -1):
                    if history[j].get("role") not in ("model", "assistant"):
                        question = _text(history[j])
                        break
                break
        if not question or not answer:
            return False

        record_incident(store_id, question, answer, "사장님부정",
                        f"다음 발화에서 답이 틀렸다는 취지로 반응함: {user_message.strip()[:80]}")
        return True
    except Exception:
        logger.exception("부정 반응 감지 실패 — 대화는 계속: %s", store_id)
        return False


# ---------------------------------------------------------------------------
# 조회·상태 변경 — 관리자 콘솔과 harvest가 쓴다
# ---------------------------------------------------------------------------

def list_incidents(status: str = "", store_id: str = "", limit: int = 100) -> list[dict[str, Any]]:
    from app.models.ai import ChatIncident

    db = _session()
    try:
        q = db.query(ChatIncident)
        if status:
            q = q.filter(ChatIncident.status == status)
        if store_id:
            q = q.filter(ChatIncident.store_id == store_id)
        rows = q.order_by(ChatIncident.last_seen.desc()).limit(max(1, limit)).all()
        return [{
            "id": r.id,
            "store_id": r.store_id,
            "question": r.question,
            "rule": r.rule,
            "detail": r.detail,
            "answer_excerpt": r.answer_excerpt,
            "tools": [t for t in (r.tools or "").split(",") if t],
            "experts": [e for e in (r.experts or "").split(",") if e],
            "status": r.status,
            "hits": r.hits,
            "first_seen": r.first_seen.isoformat() if r.first_seen else None,
            "last_seen": r.last_seen.isoformat() if r.last_seen else None,
        } for r in rows]
    finally:
        db.close()


def set_status(incident_id: int, status: str, note: str = "") -> bool:
    """harvest의 재현 검증 결과나 사람의 판단을 반영한다."""
    from app.models.ai import ChatIncident

    if status not in ("pending", "confirmed", "registered", "rejected"):
        raise ValueError(f"알 수 없는 상태: {status}")
    db = _session()
    try:
        row = db.get(ChatIncident, incident_id)
        if row is None:
            return False
        row.status = status
        if note:
            row.detail = (note or "")[:300]
        db.commit()
        return True
    finally:
        db.close()
