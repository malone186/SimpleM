"""포인트·상점 (백엔드 B) — 할 일을 해내면 코인이 쌓이고, 코인으로 브루를 꾸민다

게임화의 목적은 '사장님이 할 일을 실제로 끝내게 만드는 것'이다. 그래서 적립은
서비스가 이미 추적하고 있는 실제 성과(할 일 완료)에만 붙인다. 출석 같은 무의미한
행동에 코인을 주면 숫자만 늘고 행동은 안 바뀐다.

잔액은 원장(PointLedger) delta의 합이다. 잔액 컬럼을 따로 두지 않는 이유는
models/ai.py의 PointLedger 주석 참고.
"""

import hashlib
import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from sqlalchemy import func as sa_func
from sqlalchemy.exc import IntegrityError

logger = logging.getLogger(__name__)

KST = timezone(timedelta(hours=9))

# 할 일 하나를 끝냈을 때 주는 코인
POINTS_PER_TODO = 10

# ---------------------------------------------------------------------------
# 상점 카탈로그
#
# 상품은 '브루의 포즈'다.
#
# 처음엔 모자·옷 같은 착용 아이템으로 만들었다가 갈아엎었다. 브루는 포즈마다 완성된
# PNG 한 장이고 그림 안에 이미 캡·앞치마를 착용하고 컵까지 들고 있다. 그 위에 모자를
# 또 얹으면 꾸미기가 아니라 스티커를 덧붙이는 꼴이 되고, 포즈마다 머리 위치가 달라
# 좌표도 맞출 수 없었다.
#
# 포즈를 통째로 바꾸면 원본 일러스트 그대로라 어색할 여지가 없다. 상점 목록의 그림과
# 홈에 뜨는 모습이 정확히 같다는 것도 장점이다.
#
# mood: 프론트 Brew 컴포넌트의 BrewMood 값과 1:1로 대응한다.
# slot: 같은 슬롯은 하나만 착용된다 — 포즈는 당연히 하나뿐이라 슬롯 개념이 딱 맞는다.
# ---------------------------------------------------------------------------
SHOP_ITEMS: list[dict[str, Any]] = [
    # 포즈 — 홈 화면 마스코트가 이 모습으로 바뀐다.
    # 기본값(top, 모자 쓰고 커피 든 바리스타)은 무료라 상품에 없다.
    {"id": "pose_greet", "slot": "pose", "mood": "greet", "name": "인사하는 브루", "emoji": "👋", "price": 80,
     "desc": "발 흔들며 반겨주는 모습"},
    {"id": "pose_coffee", "slot": "pose", "mood": "coffee", "name": "커피 한 잔 브루", "emoji": "☕", "price": 100,
     "desc": "커피잔을 두 손으로 감싸 쥐었다"},
    {"id": "pose_resting", "slot": "pose", "mood": "resting", "name": "턱 괸 브루", "emoji": "😌", "price": 120,
     "desc": "한가한 오후의 여유"},
    {"id": "pose_happy", "slot": "pose", "mood": "happy", "name": "활짝 웃는 브루", "emoji": "😄", "price": 150,
     "desc": "오늘 매출이 잘 나온 날의 표정"},
    {"id": "pose_welcome", "slot": "pose", "mood": "welcome", "name": "하트 뿅뿅 브루", "emoji": "💗", "price": 180,
     "desc": "단골 손님을 맞이하는 마음"},
    {"id": "pose_clipboard", "slot": "pose", "mood": "clipboard", "name": "발주 담당 브루", "emoji": "📋", "price": 200,
     "desc": "클립보드를 든 꼼꼼한 브루"},
    {"id": "pose_serving", "slot": "pose", "mood": "serving", "name": "디저트 서빙 브루", "emoji": "🍰", "price": 250,
     "desc": "딸기 케이크를 접시째 들고 왔다"},
    {"id": "pose_pouring", "slot": "pose", "mood": "pouring", "name": "핸드드립 브루", "emoji": "🫗", "price": 300,
     "desc": "정성껏 물줄기를 내리는 중"},
    {"id": "pose_hero", "slot": "pose", "mood": "hero", "name": "스탠딩 바리스타", "emoji": "⭐", "price": 500,
     "desc": "브루노트의 얼굴. 가장 늠름한 자세", "min_level": 3},
    # 전신 애니메이션 포즈 — 정지 그림이 아니라 실제로 움직인다 (프론트 플립북 재생).
    # 모션캡처 동작을 마스코트에 입혀 스프라이트로 구운 최상급 아이템 — 레벨 달성 보상으로
    # min_level을 걸어 '레벨이 곧 목표'가 되게 한다 (코인만 있으면 다 사지는 걸 방지).
    {"id": "pose_dab", "slot": "pose", "mood": "dab", "name": "스웩 브루", "emoji": "😎", "price": 850,
     "desc": "요즘 유행하는 댑 포즈 (움직이는 포즈!)", "min_level": 4},
    {"id": "pose_workout", "slot": "pose", "mood": "workout", "name": "운동왕 브루", "emoji": "💪", "price": 850,
     "desc": "팔벌려뛰기로 몸 풀어요 (움직이는 포즈!)", "min_level": 4},
    {"id": "pose_jump", "slot": "pose", "mood": "jump", "name": "폴짝폴짝 브루", "emoji": "🐾", "price": 800,
     "desc": "신나서 폴짝폴짝 뛰어요 (움직이는 포즈!)", "min_level": 5},
    {"id": "pose_hello", "slot": "pose", "mood": "hello", "name": "인사왕 브루", "emoji": "👋", "price": 900,
     "desc": "손을 들어 반갑게 인사해요 (움직이는 포즈!)", "min_level": 6},
    {"id": "pose_dance", "slot": "pose", "mood": "dance", "name": "댄스 타임 브루", "emoji": "🕺", "price": 1000,
     "desc": "리듬 타며 춤춰요 (움직이는 포즈!)", "min_level": 7},
    # 배경 효과 — 캐릭터 위가 아니라 뒤에 깔리므로 어떤 포즈와도 겹치지 않는다.
    {"id": "bg_sparkle", "slot": "background", "name": "반짝임", "emoji": "✨", "price": 300,
     "desc": "가만히 있어도 빛나는 중"},
    {"id": "bg_heart", "slot": "background", "name": "하트 뿅뿅", "emoji": "💗", "price": 300,
     "desc": "단골 손님이 늘어날 것 같은 기분"},
    {"id": "bg_beans", "slot": "background", "name": "커피콩 흩날림", "emoji": "🫘", "price": 300,
     "desc": "볶은 원두가 사르르 떨어져요"},
    {"id": "bg_snow", "slot": "background", "name": "겨울 눈꽃", "emoji": "❄️", "price": 300,
     "desc": "포근한 첫눈 내리는 날"},
    {"id": "bg_confetti", "slot": "background", "name": "축하 컨페티", "emoji": "🎉", "price": 350,
     "desc": "오픈·이벤트 날의 들뜬 기분"},
    {"id": "bg_bubble", "slot": "background", "name": "뽀글 거품", "emoji": "🫧", "price": 300,
     "desc": "라떼 거품처럼 몽글몽글"},
    {"id": "bg_steam", "slot": "background", "name": "김 모락모락", "emoji": "♨️", "price": 350,
     "desc": "갓 내린 커피의 김이 피어올라요"},
    {"id": "bg_blossom", "slot": "background", "name": "벚꽃잎 흩날림", "emoji": "🌸", "price": 350,
     "desc": "봄바람에 벚꽃잎이 팔랑팔랑"},
    {"id": "bg_maple", "slot": "background", "name": "가을 단풍", "emoji": "🍁", "price": 350,
     "desc": "단풍잎이 물들며 떨어져요"},
    {"id": "bg_coins", "slot": "background", "name": "코인 비", "emoji": "🪙", "price": 500,
     "desc": "코인이 쏟아지는 매출 대박 기운", "min_level": 5},
    # 카페 배경 — 게임 룸(브루의 카페)의 배경 사진을 통째로 바꾼다.
    # 프론트에 같은 id의 사진이 등록돼 있어야 상점에 노출된다(사진 없는 아이템은
    # 프론트가 숨긴다). 사진 추가 방법: 저장소 루트 '카페배경_추가_가이드.md' 참고.
    {"id": "room_window", "slot": "room", "name": "창가 자리", "emoji": "🪟", "price": 400,
     "desc": "큰 창으로 햇살이 드는 오후"},
    {"id": "room_terrace", "slot": "room", "name": "야외 테라스", "emoji": "⛱️", "price": 400,
     "desc": "파라솔 아래 노천카페"},
    {"id": "room_night", "slot": "room", "name": "밤의 카페", "emoji": "🌙", "price": 450,
     "desc": "전구 불빛만 남은 심야 감성"},
    {"id": "room_blossom", "slot": "room", "name": "벚꽃 시즌", "emoji": "🌸", "price": 500,
     "desc": "창밖 가득 흩날리는 벚꽃"},
    {"id": "room_rainy", "slot": "room", "name": "비 오는 날", "emoji": "☔", "price": 450,
     "desc": "빗방울 맺힌 창가의 아늑함"},
    {"id": "room_winter", "slot": "room", "name": "겨울 카페", "emoji": "🎄", "price": 500,
     "desc": "트리와 눈 내리는 창밖"},
    {"id": "room_sunset", "slot": "room", "name": "노을 루프탑", "emoji": "🌇", "price": 550,
     "desc": "주황빛 하늘 아래 옥상 카페"},
    {"id": "room_plant", "slot": "room", "name": "플랜테리어", "emoji": "🪴", "price": 450,
     "desc": "초록 식물 가득한 인테리어"},
    # 앞치마 색 — 브루가 입은 앞치마만 색을 바꾼다(털·모자·컵·글자는 그대로). 포즈별로
    # '앞치마 영역 마스크'로 리컬러한 변형 PNG를 미리 구워 두고, color 값으로 그 이미지를
    # 골라 원본 포즈를 대체한다(프론트 apronVariants.ts). pose와 다른 슬롯이라 함께 착용된다.
    {"id": "apron_navy", "slot": "apron", "color": "navy", "name": "네이비 앞치마", "emoji": "🔵", "price": 300,
     "desc": "차분한 감색 앞치마"},
    {"id": "apron_forest", "slot": "apron", "color": "forest", "name": "포레스트 앞치마", "emoji": "🟢", "price": 300,
     "desc": "숲빛 그린 앞치마"},
    {"id": "apron_wine", "slot": "apron", "color": "wine", "name": "와인 앞치마", "emoji": "🍷", "price": 350,
     "desc": "깊은 버건디 앞치마"},
    {"id": "apron_mustard", "slot": "apron", "color": "mustard", "name": "머스터드 앞치마", "emoji": "🟡", "price": 300,
     "desc": "따뜻한 겨자색 앞치마"},
    {"id": "apron_charcoal", "slot": "apron", "color": "charcoal", "name": "차콜 앞치마", "emoji": "⚫", "price": 300,
     "desc": "시크한 차콜 블랙 앞치마"},
    {"id": "apron_terracotta", "slot": "apron", "color": "terracotta", "name": "테라코타 앞치마", "emoji": "🟠", "price": 300,
     "desc": "구움과자 같은 테라코타 앞치마"},
]

_ITEM_BY_ID = {item["id"]: item for item in SHOP_ITEMS}

SLOT_LABEL = {
    "pose": "브루 모습",
    "background": "배경 효과",
    "apron": "앞치마 색",
    "room": "카페 배경",  # 게임 룸 배경 사진 (부위당 하나 착용 규칙 그대로)
}

REASON_LABEL = {
    "todo_done": "할 일 완료",
    "purchase": "상점 구매",
    "daily_bonus": "일일 도전 보너스",
    "quest": "주간 퀘스트 보상",
    "gacha": "브루 캡슐 뽑기",
    "gacha_reward": "캡슐에서 코인 획득",
    "test_grant": "테스트 지급",  # 개발 중 상점을 확인하려고 수동으로 넣은 코인
    "admin_grant": "관리자 지급",
    "admin_revoke": "관리자 회수",
}

# 일일 도전 — 오늘 할 일 N개를 끝내면 보너스 코인 (빈 출석이 아니라 실제 완료 기준)
DAILY_GOAL = 3
DAILY_REWARD = 30

# ---------------------------------------------------------------------------
# 주간 퀘스트 — '오늘의 할 일'과 경쟁하지 않고 그걸 재료로 쓴다.
#
# 새 행동을 시키는 게 아니라, 이미 완료한 할 일(원장 todo_done 행)을 주 단위로
# 세서 누적 목표를 채우면 큰 보상을 준다. 할 일 = 그날의 내용(무엇을),
# 퀘스트 = 기간의 습관(얼마나 꾸준히)이라는 역할 분담.
# kind: count = 이번 주 완료 개수 / days = 이번 주에 완료가 있었던 날 수
# 월요일(KST) 시작으로 리셋되고, 보상 중복 수령은 원장 유니크(reason, ref=주차)로 막는다.
# ---------------------------------------------------------------------------
WEEKLY_QUESTS: list[dict[str, Any]] = [
    {"id": "wq-todo-5", "kind": "count", "goal": 5, "reward": 60,
     "title": "몸풀기", "desc": "이번 주 할 일 5개 완료"},
    {"id": "wq-todo-15", "kind": "count", "goal": 15, "reward": 160,
     "title": "성실한 사장님", "desc": "이번 주 할 일 15개 완료"},
    {"id": "wq-todo-30", "kind": "count", "goal": 30, "reward": 400,
     "title": "카페의 심장", "desc": "이번 주 할 일 30개 완료"},
    {"id": "wq-days-4", "kind": "days", "goal": 4, "reward": 120,
     "title": "꾸준함이 무기", "desc": "이번 주 4일 이상 할 일 완료"},
]
_QUEST_BY_ID = {q["id"]: q for q in WEEKLY_QUESTS}

# 일일 퀘스트 — 손익분기점에 묶는다. 배지가 아니라 사장님이 유일하게 신경 쓰는 숫자(본전).
# 목표 잔수는 손익분기 서비스가 이미 계산한 breakeven_daily_cups를 그대로 쓴다.
# 진행은 오늘(KST) 실제 판매 잔 수. 매출을 입력해야 채워진다(실시간 판매가 아니다).
DAILY_BE_REWARD = 50
DAILY_BE_ID = "dq-breakeven"


class RewardError(ValueError):
    """포인트·상점 처리 실패 (잔액 부족, 없는 아이템 등)"""


def _session():
    import app.models  # noqa: F401 — 모든 모델을 Base.metadata에 등록

    from app.core.database import SessionLocal

    return SessionLocal()


# ---------------------------------------------------------------------------
# 잔액 · 내역
# ---------------------------------------------------------------------------

def _balance(db, store_id: str) -> int:
    from app.models.ai import PointLedger

    total = db.query(sa_func.coalesce(sa_func.sum(PointLedger.delta), 0)).filter(
        PointLedger.store_id == store_id
    ).scalar()
    return int(total or 0)


def get_balance(store_id: str) -> int:
    with _session() as db:
        return _balance(db, store_id)


def get_wallet(store_id: str, history_limit: int = 30) -> dict[str, Any]:
    """상점 화면 상단이 필요로 하는 것 전부 — 잔액, 누적 적립, 최근 내역."""
    from app.models.ai import PointLedger

    with _session() as db:
        rows = (
            db.query(PointLedger)
            .filter(PointLedger.store_id == store_id)
            .order_by(PointLedger.id.desc())
            .limit(history_limit)
            .all()
        )
        earned = db.query(sa_func.coalesce(sa_func.sum(PointLedger.delta), 0)).filter(
            PointLedger.store_id == store_id, PointLedger.delta > 0
        ).scalar()

        return {
            "balance": _balance(db, store_id),
            "total_earned": int(earned or 0),
            "history": [
                {
                    "id": r.id,
                    "delta": r.delta,
                    "reason": r.reason,
                    "reason_label": REASON_LABEL.get(r.reason, r.reason),
                    "memo": r.memo,
                    "created_at": r.created_at.isoformat() if r.created_at else None,
                }
                for r in rows
            ],
        }


# ---------------------------------------------------------------------------
# 적립
# ---------------------------------------------------------------------------

def award(store_id: str, delta: int, reason: str, ref: str, memo: str = "") -> bool:
    """포인트를 적립한다. 같은 (reason, ref)로 이미 적립됐으면 조용히 건너뛴다.

    중복 판정을 DB 유니크 제약에 맡긴다 — 조회 후 삽입 방식은 같은 요청이 동시에
    두 번 들어오면 둘 다 통과한다. IntegrityError를 잡는 쪽이 확실하다.

    @returns 실제로 적립됐으면 True, 이미 적립돼 있었으면 False
    """
    from app.models.ai import PointLedger

    with _session() as db:
        entry = PointLedger(store_id=store_id, delta=delta, reason=reason, ref=ref, memo=memo)
        db.add(entry)
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            return False
    return True


def award_todo_done(store_id: str, todo_id: int, title: str) -> bool:
    """할 일 완료 보상. 완료를 껐다 켜도 처음 한 번만 지급된다(ref = 할 일 id)."""
    memo = title if len(title) <= 40 else title[:39] + "…"
    return award(store_id, POINTS_PER_TODO, "todo_done", str(todo_id), memo)


def award_derived_todo(store_id: str, key: str, title: str) -> bool:
    """자동 도출 할 일(재고 발주·서류 갱신·브루 추천) 완료 보상.

    이 항목들은 조건에서 매번 새로 조립되므로 todo_items 테이블에 행이 없다.
    그래도 사장님이 실제로 끝낸 일이라 보상은 같아야 한다 — 대시보드가 쓰는 안정적인
    id(stock-<재료id>, comp-<서류id>, insight-<키>, promo-main)를 그대로 ref로 삼는다.

    ref에 'k:' 접두어를 붙이는 이유: 저장된 할 일은 ref가 숫자 id라 같은 reason 안에서
    두 종류가 섞인다. 접두어가 없으면 언젠가 겹칠 수 있다.
    """
    k = (key or "").strip()
    if not k:
        raise RewardError("할 일 식별자가 비어 있습니다.")

    memo = title if len(title) <= 40 else title[:39] + "…"
    return award(store_id, POINTS_PER_TODO, "todo_done", _derived_ref(k), memo)


# 관리자 콘솔 수동 지급 한도 — 오타 한 번으로 잔액이 터무니없어지는 걸 막는다
ADMIN_GRANT_MAX = 100_000


def admin_grant(store_id: str, amount: int, memo: str = "", admin_email: str = "") -> dict[str, Any]:
    """[관리자 지급] 관리자 콘솔에서 특정 사장님 계정에 코인을 넣거나 회수한다.

    적립은 원래 '실제로 끝낸 할 일'에만 붙는 게 원칙이다. 이 경로는 그 예외라
    내역에 '관리자 지급/회수'로 따로 남긴다 — 사장님이 상점 내역을 봤을 때 어디서
    생긴 코인인지 알 수 있어야 한다.

    멱등 처리는 하지 않는다(같은 금액을 두 번 주고 싶을 수도 있다). 대신 ref에
    마이크로초 시각을 넣어 유니크 제약에 걸리지 않게 한다.

    회수(음수)는 잔액 밑으로 내려가지 않는다 — 원장 합이 음수가 되면 상점 화면의
    '부족한 코인' 계산이 이상해진다.
    """
    from app.models.ai import PointLedger

    delta = int(amount)
    if delta == 0:
        raise RewardError("지급할 코인 수를 입력하세요.")
    if abs(delta) > ADMIN_GRANT_MAX:
        raise RewardError(f"한 번에 {ADMIN_GRANT_MAX:,}코인까지만 처리할 수 있어요.")

    sid = (store_id or "").strip()
    if not sid:
        raise RewardError("대상 계정이 비어 있습니다.")

    note = (memo or "").strip() or ("관리자 지급" if delta > 0 else "관리자 회수")
    if len(note) > 60:
        note = note[:59] + "…"

    with _session() as db:
        balance = _balance(db, sid)
        if delta < 0 and balance + delta < 0:
            raise RewardError(f"보유 코인({balance}개)보다 많이 회수할 수 없어요.")

        stamp = datetime.now(KST).strftime("%Y%m%d%H%M%S%f")
        db.add(PointLedger(
            store_id=sid,
            delta=delta,
            reason="admin_grant" if delta > 0 else "admin_revoke",
            ref=f"admin:{stamp}",
            memo=note,
        ))
        db.commit()
        new_balance = _balance(db, sid)

    logger.info("관리자 코인 %s — 대상 %s, %+d코인 (관리자 %s, 사유: %s)",
                "지급" if delta > 0 else "회수", sid, delta, admin_email or "-", note)
    return {"store_id": sid, "delta": delta, "balance": new_balance, "memo": note}


def _derived_ref(key: str) -> str:
    """자동 도출 항목 key를 ref 컬럼(64자)에 담을 형태로.

    인사이트 키는 'insight-renewal:12:2026-08-10'처럼 길어져 120자까지 온다. 그냥 자르면
    앞부분이 같은 두 항목이 한 항목으로 뭉쳐 한쪽이 코인을 못 받는다 — 넘칠 때만 뒤를
    해시로 갈음해 길이는 맞추고 구분은 남긴다.
    """
    ref = f"k:{key}"
    if len(ref) <= 64:
        return ref
    digest = hashlib.sha1(key.encode("utf-8")).hexdigest()[:16]
    return f"k:{key[:45]}#{digest}"


# ---------------------------------------------------------------------------
# 성장(EXP·레벨) · 스트릭 · 일일 도전 — '브루 키우기'
#
# EXP = 누적으로 번 코인(양수 delta 합). 쓰는 코인(잔액)과 분리돼, 아이템을 사도 성장은
# 되돌아가지 않는다. 레벨·칭호는 EXP에서 계산한다. 스트릭은 '할 일을 한 날'의 연속 일수 —
# 단순 접속이 아니라 실제 완료 기준이라 "빈 출석엔 보상 없음" 원칙과 맞는다.
# ---------------------------------------------------------------------------

def _level_title(level: int) -> str:
    if level <= 2:
        return "새싹 바리스타"
    if level <= 4:
        return "견습 바리스타"
    if level <= 7:
        return "정식 바리스타"
    if level <= 10:
        return "베테랑 바리스타"
    return "마스터 바리스타"


def _level_calc(exp: int) -> tuple[int, int, int, str]:
    """누적 EXP → (레벨, 현재 레벨 내 EXP, 다음 레벨까지 필요 EXP, 칭호).

    레벨 L→L+1 비용 = 100 + (L-1)*50 (오를수록 완만하게 늘어난다).
    """
    level, acc = 1, 0
    while True:
        cost = 100 + (level - 1) * 50
        if exp < acc + cost:
            return level, exp - acc, cost, _level_title(level)
        acc += cost
        level += 1


def _to_kst_date(dt):
    """PointLedger.created_at(naive UTC일 수 있음) → KST 날짜."""
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(KST).date()


def _streak(active_dates: set, today) -> tuple[int, bool]:
    """할 일을 한 날의 연속 일수. 오늘 아직 안 했어도 어제까지 이어졌으면 유지된다."""
    if today in active_dates:
        cur = today
    elif (today - timedelta(days=1)) in active_dates:
        cur = today - timedelta(days=1)
    else:
        return 0, False
    n = 0
    while cur in active_dates:
        n += 1
        cur -= timedelta(days=1)
    return n, today in active_dates


def get_progress(store_id: str) -> dict[str, Any]:
    """브루 키우기 상태 — 레벨·EXP·스트릭·일일 도전.

    일일 도전을 달성했는데 아직 보너스를 안 받았으면 여기서 지급한다(하루 한 번, ref로 멱등).
    """
    from app.models.ai import PointLedger

    with _session() as db:
        rows = db.query(PointLedger.created_at, PointLedger.reason, PointLedger.delta).filter(
            PointLedger.store_id == store_id, PointLedger.delta > 0
        ).all()

    today = datetime.now(KST).date()
    exp = 0
    active: set = set()
    todo_today = 0
    daily_claimed = False
    for created, reason, delta in rows:
        exp += int(delta)
        d = _to_kst_date(created)
        if not d:
            continue
        active.add(d)
        if d == today and reason == "todo_done":
            todo_today += 1
        if d == today and reason == "daily_bonus":
            daily_claimed = True

    # 일일 도전 달성 & 미수령 → 보너스 지급 (멱등: ref=daily:날짜)
    reward_given = False
    if todo_today >= DAILY_GOAL and not daily_claimed:
        if award(store_id, DAILY_REWARD, "daily_bonus", f"daily:{today.isoformat()}",
                 f"일일 도전 달성(+{DAILY_REWARD})"):
            exp += DAILY_REWARD
            daily_claimed = True
            reward_given = True

    streak, active_today = _streak(active, today)
    level, in_level, to_next, title = _level_calc(exp)
    return {
        "exp": exp,
        "level": level,
        "level_title": title,
        "exp_in_level": in_level,
        "exp_to_next": to_next,
        "streak": streak,
        "streak_active_today": active_today,
        "daily": {
            "goal": DAILY_GOAL,
            "progress": min(todo_today, DAILY_GOAL),
            "done": todo_today >= DAILY_GOAL,
            "reward": DAILY_REWARD,
            "claimed": daily_claimed,
            "just_awarded": reward_given,
        },
    }


# ---------------------------------------------------------------------------
# 상점
# ---------------------------------------------------------------------------

def _level_of(db, store_id: str) -> int:
    """현재 레벨 — 적립 총합(EXP)으로 계산한다 (get_progress와 같은 기준)."""
    from app.models.ai import PointLedger

    exp = db.query(sa_func.coalesce(sa_func.sum(PointLedger.delta), 0)).filter(
        PointLedger.store_id == store_id, PointLedger.delta > 0
    ).scalar()
    level, _, _, _ = _level_calc(int(exp or 0))
    return level


def get_shop(store_id: str) -> dict[str, Any]:
    """카탈로그 + 보유/착용 상태를 한 번에. 프론트가 추가 조회 없이 그릴 수 있게.

    min_level이 걸린 아이템은 레벨 미달이면 locked=True로 내려간다 — 목록에는 실루엣으로
    보여서 '저건 Lv.N에 열린다'는 목표가 되고, 구매는 buy()가 서버에서 막는다.
    """
    from app.models.ai import OwnedItem

    with _session() as db:
        owned = {o.item_id: o for o in db.query(OwnedItem).filter(OwnedItem.store_id == store_id).all()}
        balance = _balance(db, store_id)
        level = _level_of(db, store_id)

    items = []
    for item in SHOP_ITEMS:
        row = owned.get(item["id"])
        min_level = int(item.get("min_level", 0))
        items.append({
            **item,
            "slot_label": SLOT_LABEL.get(item["slot"], item["slot"]),
            "owned": row is not None,
            "equipped": bool(row and row.equipped),
            "affordable": balance >= item["price"],
            "min_level": min_level,
            # 이미 보유한 건 잠그지 않는다 (레벨 조건이 나중에 생겨도 소급 몰수하지 않음)
            "locked": min_level > level and row is None,
        })

    return {"balance": balance, "level": level, "items": items}


def get_equipped(store_id: str) -> list[dict[str, Any]]:
    """착용 중인 아이템 — 브루를 그리는 화면들이 쓴다.

    포즈 아이템은 mood가 함께 온다. 프론트가 그 값으로 브루 그림 자체를 바꾼다.
    """
    from app.models.ai import OwnedItem

    with _session() as db:
        rows = db.query(OwnedItem).filter(
            OwnedItem.store_id == store_id, OwnedItem.equipped.is_(True)
        ).all()
        ids = [r.item_id for r in rows]

    out = []
    for i in ids:
        item = _ITEM_BY_ID.get(i)
        if not item:
            continue  # 카탈로그에서 빠진 옛 아이템(착용 아이템 시절 구매분)은 무시한다
        entry = {"id": i, "slot": item["slot"], "emoji": item["emoji"]}
        if item.get("mood"):
            entry["mood"] = item["mood"]
        if item.get("color"):
            entry["color"] = item["color"]  # 앞치마 색 — 프론트가 변형 이미지를 고른다
        out.append(entry)
    return out


def buy(store_id: str, item_id: str) -> dict[str, Any]:
    """아이템 구매 — 잔액을 차감하고 보유 목록에 넣는다. 산 즉시 착용한다.

    차감은 원장에 음수 한 줄로 기록된다. ref에 시각을 넣어 같은 아이템을 나중에
    다시 다뤄도 유니크 제약에 걸리지 않게 한다(재구매는 아래에서 막는다).
    """
    from app.models.ai import OwnedItem, PointLedger

    item = _ITEM_BY_ID.get(item_id)
    if not item:
        raise RewardError("존재하지 않는 아이템입니다.")

    with _session() as db:
        already = db.query(OwnedItem).filter(
            OwnedItem.store_id == store_id, OwnedItem.item_id == item_id
        ).one_or_none()
        if already:
            raise RewardError("이미 가지고 있는 아이템이에요.")

        # 레벨 잠금 — 프론트가 숨겨도 API를 직접 부르면 뚫리므로 서버가 최종 방어한다
        min_level = int(item.get("min_level", 0))
        if min_level:
            level = _level_of(db, store_id)
            if level < min_level:
                raise RewardError(f"Lv.{min_level} 달성 시 열리는 아이템이에요. (현재 Lv.{level})")

        balance = _balance(db, store_id)
        if balance < item["price"]:
            raise RewardError(f"코인이 {item['price'] - balance}개 부족해요.")

        stamp = datetime.now(KST).strftime("%Y%m%d%H%M%S%f")
        db.add(PointLedger(
            store_id=store_id,
            delta=-item["price"],
            reason="purchase",
            ref=f"{item_id}:{stamp}",
            memo=item["name"],
        ))
        # 같은 슬롯의 기존 착용은 벗긴다 — 산 걸 바로 보여주는 게 자연스럽다
        db.query(OwnedItem).filter(
            OwnedItem.store_id == store_id,
            OwnedItem.item_id.in_([i["id"] for i in SHOP_ITEMS if i["slot"] == item["slot"]]),
        ).update({"equipped": False}, synchronize_session=False)
        db.add(OwnedItem(store_id=store_id, item_id=item_id, equipped=True))
        db.commit()

    logger.info("상점 구매 — %s: %s (-%d코인)", store_id, item_id, item["price"])
    return get_shop(store_id)


def set_equipped(store_id: str, item_id: str, equipped: bool) -> dict[str, Any]:
    """착용/해제. 같은 슬롯에는 하나만 착용된다."""
    from app.models.ai import OwnedItem

    item = _ITEM_BY_ID.get(item_id)
    if not item:
        raise RewardError("존재하지 않는 아이템입니다.")

    with _session() as db:
        row = db.query(OwnedItem).filter(
            OwnedItem.store_id == store_id, OwnedItem.item_id == item_id
        ).one_or_none()
        if not row:
            raise RewardError("아직 구매하지 않은 아이템이에요.")

        if equipped:
            db.query(OwnedItem).filter(
                OwnedItem.store_id == store_id,
                OwnedItem.item_id.in_([i["id"] for i in SHOP_ITEMS if i["slot"] == item["slot"]]),
            ).update({"equipped": False}, synchronize_session=False)
        row.equipped = equipped
        db.commit()

    return get_shop(store_id)


# ---------------------------------------------------------------------------
# 주간 퀘스트
# ---------------------------------------------------------------------------

def _week_key():
    """이번 주(월요일 시작, KST)의 식별자와 시작 시각(UTC naive)을 돌려준다."""
    now_kst = datetime.now(KST)
    monday = (now_kst - timedelta(days=now_kst.weekday())).date()
    start_utc = datetime.combine(monday, datetime.min.time(), tzinfo=KST).astimezone(timezone.utc)
    return monday.isoformat(), start_utc.replace(tzinfo=None), monday


def _weekly_todo_stats(db, store_id: str):
    """이번 주 할 일 완료 (총 개수, 완료가 있었던 날 수). 원장이 진실이라 별도 표가 없다."""
    _, start_utc, monday = _week_key()
    from app.models.ai import PointLedger

    rows = db.query(PointLedger.created_at).filter(
        PointLedger.store_id == store_id,
        PointLedger.reason == "todo_done",
        # KST 자정 경계의 UTC 저장 편차를 흡수하도록 하루 여유를 두고 가져와 정확히 거른다
        PointLedger.created_at >= start_utc - timedelta(days=1),
    ).all()
    dates = [d for (created,) in rows if (d := _to_kst_date(created)) and d >= monday]
    return len(dates), len(set(dates))


# ---------------------------------------------------------------------------
# 일일 퀘스트 — 오늘 본전 넘기기 (손익분기점 연동)
# ---------------------------------------------------------------------------

def _today_cups(db, store_id: str) -> int:
    """오늘(KST) 판매된 잔 수 합. 매출을 입력해야 채워진다(실시간 판매가 아님)."""
    from app.models.inventory import Sale

    today = datetime.now(KST).date()
    # KST 자정 경계의 저장 편차를 흡수하려 하루 여유로 당겨오고 KST 날짜로 정확히 거른다
    start = datetime.combine(today, datetime.min.time(), tzinfo=KST) - timedelta(days=1)
    rows = db.query(Sale.quantity, Sale.sold_at).filter(
        Sale.store_id == store_id, Sale.sold_at >= start.astimezone(timezone.utc),
    ).all()
    total = 0
    for qty, sold_at in rows:
        d = sold_at.astimezone(KST).date() if sold_at.tzinfo else sold_at.date()
        if d == today:
            total += int(qty or 0)
    return total


def _daily_breakeven_quest(store_id: str) -> dict[str, Any]:
    """오늘의 목표 카드 데이터.

    손익분기(고정비·레시피·객단가)가 갖춰지면 목표 잔수를 주고, 아니면 setup 안내를 준다.
    게임 화면이 손익분기 서비스에 기대는 건 여기 한 곳뿐이라, 실패해도 카드만 빠지고
    주간 퀘스트는 그대로 뜬다.
    """
    today = datetime.now(KST).date().isoformat()
    base = {"id": DAILY_BE_ID, "date": today, "reward": DAILY_BE_REWARD,
            "title": "오늘 본전 넘기기"}
    try:
        from app.services.ai import breakeven_service

        be = breakeven_service.compute_breakeven(store_id)
    except Exception:
        logger.exception("일일 퀘스트 손익분기 계산 실패 — 카드 숨김")
        return {**base, "available": False, "needs_setup": True,
                "message": "손익분기를 설정하면 오늘의 목표가 생겨요."}

    target = be.get("breakeven_daily_cups")
    if not be.get("computed") or not target:
        # 고정비·레시피·객단가 중 뭐가 없는지 손익분기 서비스가 만든 안내를 그대로 전한다
        return {**base, "available": False, "needs_setup": True,
                "target_revenue": be.get("breakeven_daily_revenue"),
                "message": be.get("message") or "손익분기를 설정하면 오늘의 목표가 생겨요."}

    with _session() as db:
        cups = _today_cups(db, store_id)
        from app.models.ai import PointLedger
        claimed = db.query(PointLedger.id).filter(
            PointLedger.store_id == store_id,
            PointLedger.reason == "quest_daily",
            PointLedger.ref == f"{DAILY_BE_ID}:{today}",
        ).first() is not None

    done = cups >= target
    return {
        **base,
        "available": True,
        "needs_setup": False,
        "goal": target,
        "progress": min(cups, target),
        "sold_cups": cups,
        "avg_ticket": be.get("avg_ticket"),
        "target_daily_revenue": be.get("breakeven_daily_revenue"),
        "done": done,
        "claimed": claimed,
        "claimable": done and not claimed,
        "desc": f"약 {target}잔이면 오늘치 고정비를 다 갚아요",
    }


def get_daily_quest(store_id: str) -> dict[str, Any]:
    """오늘의 목표(일일 퀘스트) 단독 조회."""
    return _daily_breakeven_quest(store_id)


def claim_daily_quest(store_id: str) -> dict[str, Any]:
    """오늘 본전 달성 보상 수령. 하루 1회(ref=날짜)만 — DB 유니크가 이중 수령을 막는다."""
    q = _daily_breakeven_quest(store_id)
    if not q.get("available"):
        raise RewardError("아직 오늘의 목표가 없어요. 손익분기를 먼저 설정해 주세요.")
    if not q.get("done"):
        raise RewardError("아직 오늘 목표를 채우지 못했어요.")
    today = q["date"]
    awarded = award(store_id, DAILY_BE_REWARD, "quest_daily", f"{DAILY_BE_ID}:{today}",
                    "일일 퀘스트 '오늘 본전 넘기기' 달성")
    result = _daily_breakeven_quest(store_id)
    result["awarded"] = DAILY_BE_REWARD if awarded else 0
    result["balance"] = get_balance(store_id)
    return result


def get_quests(store_id: str) -> dict[str, Any]:
    """주간 퀘스트 목록 — 진행도·달성·수령 여부. 월요일(KST)마다 리셋된다."""
    week, _, _ = _week_key()
    from app.models.ai import PointLedger

    with _session() as db:
        count, days = _weekly_todo_stats(db, store_id)
        claimed_refs = {
            ref for (ref,) in db.query(PointLedger.ref).filter(
                PointLedger.store_id == store_id, PointLedger.reason == "quest"
            ).all()
        }
    quests = []
    for q in WEEKLY_QUESTS:
        progress = count if q["kind"] == "count" else days
        claimed = f"{q['id']}:{week}" in claimed_refs
        quests.append({
            "id": q["id"], "title": q["title"], "desc": q["desc"],
            "goal": q["goal"], "progress": min(progress, q["goal"]), "reward": q["reward"],
            "done": progress >= q["goal"], "claimed": claimed,
            "claimable": progress >= q["goal"] and not claimed,
        })
    # 오늘의 목표(일일 퀘스트)를 같은 응답에 실어 화면이 한 번만 부르게 한다
    return {"week": week, "quests": quests, "daily": _daily_breakeven_quest(store_id)}


def claim_quest(store_id: str, quest_id: str) -> dict[str, Any]:
    """달성한 퀘스트의 보상 수령. 주차별 ref 유니크로 이중 수령은 DB가 막는다."""
    q = _QUEST_BY_ID.get(quest_id)
    if not q:
        raise RewardError("존재하지 않는 퀘스트입니다.")
    week, _, _ = _week_key()
    with _session() as db:
        count, days = _weekly_todo_stats(db, store_id)
    progress = count if q["kind"] == "count" else days
    if progress < q["goal"]:
        raise RewardError("아직 목표를 채우지 못했어요.")
    awarded = award(store_id, q["reward"], "quest", f"{quest_id}:{week}",
                    f"주간 퀘스트 '{q['title']}' 달성")
    result = get_quests(store_id)
    result["awarded"] = q["reward"] if awarded else 0
    result["balance"] = get_balance(store_id)
    return result


# ---------------------------------------------------------------------------
# 브루 캡슐 뽑기 (가챠)
#
# 코인 소모처 + 운 요소. 서버가 결과를 정한다 — 프론트에서 정하면 조작이 가능하고,
# 원장·보유 기록과 결과가 어긋날 수 있다.
# 확률: 일반(코인 반환) 40% / 희귀(500코인 이하 미보유 아이템) 45% / 전설(500 초과) 15%.
# 해당 등급에서 줄 수 있는 아이템이 없으면(다 모았거나 레벨 잠금) 코인으로 대체 —
# '꽝'은 없다. 뽑기 비용보다 기대값이 낮게 코인 표를 짜서 인플레를 막는다.
# ---------------------------------------------------------------------------
GACHA_COST = 300
_GACHA_COMMON_COINS = (30, 50, 80, 120, 150)  # 일반 등급 코인 표 (기대값 86)


def draw_capsule(store_id: str) -> dict[str, Any]:
    """캡슐 1회 뽑기 — 차감·지급·보유 등록까지 원장 기준으로 처리하고 결과를 돌려준다."""
    import random

    from app.models.ai import OwnedItem, PointLedger

    with _session() as db:
        balance = _balance(db, store_id)
        if balance < GACHA_COST:
            raise RewardError(f"코인이 {GACHA_COST - balance}개 부족해요. (뽑기 1회 {GACHA_COST}코인)")
        level = _level_of(db, store_id)
        owned_ids = {o.item_id for o in db.query(OwnedItem).filter(OwnedItem.store_id == store_id).all()}

        # 등급별 후보 — 미보유 + 레벨 잠금 아닌 것만 (잠금 아이템이 뽑기로 뚫리면 잠금이 무의미)
        def pool(cheap: bool) -> list[dict[str, Any]]:
            return [
                i for i in SHOP_ITEMS
                if i["id"] not in owned_ids
                and int(i.get("min_level", 0)) <= level
                and (i["price"] <= 500 if cheap else i["price"] > 500)
            ]

        stamp = datetime.now(KST).strftime("%Y%m%d%H%M%S%f")
        db.add(PointLedger(store_id=store_id, delta=-GACHA_COST, reason="gacha",
                           ref=f"draw:{stamp}", memo="브루 캡슐 뽑기"))

        roll = random.random()
        rarity, kind = "common", "coins"
        coins_won = 0
        item_won: Optional[dict[str, Any]] = None
        if roll < 0.40:
            coins_won = random.choice(_GACHA_COMMON_COINS)
        elif roll < 0.85:
            rarity = "rare"
            cands = pool(cheap=True)
            if cands:
                kind, item_won = "item", random.choice(cands)
            else:
                coins_won = 150  # 다 모은 사장님에겐 코인으로
        else:
            rarity = "epic"
            cands = pool(cheap=False)
            if cands:
                kind, item_won = "item", random.choice(cands)
            else:
                coins_won = 300

        if item_won is not None:
            db.add(OwnedItem(store_id=store_id, item_id=item_won["id"], equipped=False))
            memo = f"캡슐 뽑기 — {item_won['name']} 획득"
            # 아이템 지급도 원장에 0코인 줄로 남겨 내역에서 보이게 한다
            db.add(PointLedger(store_id=store_id, delta=0, reason="gacha_reward",
                               ref=f"item:{stamp}", memo=memo))
        else:
            db.add(PointLedger(store_id=store_id, delta=coins_won, reason="gacha_reward",
                               ref=f"coins:{stamp}", memo=f"캡슐에서 코인 {coins_won}개"))
        db.commit()
        new_balance = _balance(db, store_id)

    result: dict[str, Any] = {"rarity": rarity, "kind": kind, "cost": GACHA_COST, "balance": new_balance}
    if kind == "coins":
        result["coins"] = coins_won
    else:
        assert item_won is not None
        result["item"] = {
            "id": item_won["id"], "slot": item_won["slot"],
            "slot_label": SLOT_LABEL.get(item_won["slot"], item_won["slot"]),
            "name": item_won["name"], "emoji": item_won["emoji"],
            "mood": item_won.get("mood"), "color": item_won.get("color"),
        }
    return result
