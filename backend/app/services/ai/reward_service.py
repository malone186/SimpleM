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
from typing import Any

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
     "desc": "브루노트의 얼굴. 가장 늠름한 자세"},
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
}

REASON_LABEL = {
    "todo_done": "할 일 완료",
    "purchase": "상점 구매",
    "test_grant": "테스트 지급",  # 개발 중 상점을 확인하려고 수동으로 넣은 코인
}


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
# 상점
# ---------------------------------------------------------------------------

def get_shop(store_id: str) -> dict[str, Any]:
    """카탈로그 + 보유/착용 상태를 한 번에. 프론트가 추가 조회 없이 그릴 수 있게."""
    from app.models.ai import OwnedItem

    with _session() as db:
        owned = {o.item_id: o for o in db.query(OwnedItem).filter(OwnedItem.store_id == store_id).all()}
        balance = _balance(db, store_id)

    items = []
    for item in SHOP_ITEMS:
        row = owned.get(item["id"])
        items.append({
            **item,
            "slot_label": SLOT_LABEL.get(item["slot"], item["slot"]),
            "owned": row is not None,
            "equipped": bool(row and row.equipped),
            "affordable": balance >= item["price"],
        })

    return {"balance": balance, "items": items}


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
