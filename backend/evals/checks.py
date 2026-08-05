"""채점 규칙 — 본체는 app/services/ai/answer_audit.py에 있다

[왜 여기 두지 않았나] 같은 규칙을 운영 대화에서도 매 턴 돌려 사고를 자동으로 잡는다
(answer_audit.audit_turn). 그런데 프로덕션 이미지에는 app·alembic·data만 들어가고
evals/는 빠지므로, 규칙이 여기 있으면 배포된 서버에서 import 자체가 실패한다.
그래서 규칙은 app 아래에 두고 여기서는 이름만 다시 내보낸다.

채점 규칙 두 종류:
 1) 정답 대조 — 문항에 적어 둔 기대값과 맞는지. '이미 아는 오답'의 재발을 막는다.
    (contains_number / contains_text — run_golden이 쓴다)
 2) 감시 규칙(WATCHERS) — 정답을 몰라도 답변만 보고 이상을 잡는다. '새로운 유형의 오답'은
    이쪽이 잡는다. 골든 문항이든 정답 없는 탐색 문항이든 모든 답변에 똑같이 적용된다.
"""

from app.services.ai.answer_audit import (  # noqa: F401
    NUMERIC_FLOOR,
    WATCHERS,
    YEAR_RANGE,
    big_numbers,
    contains_number,
    contains_text,
    extract_numbers,
    looks_dissatisfied,
    paraphrase_disagreement,
    run_watchers,
)
