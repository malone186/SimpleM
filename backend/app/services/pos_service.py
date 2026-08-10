"""POS 실시간 연동 (백엔드 B) — 매장별 Square 계정 실연동

기존 데모(`_pos.py`, 전역 env 토큰 + 목 폴백)와 달리 이 모듈은 실경로만 있다:
  · 토큰은 매장별로 DB(PosConnection)에 암호화 저장 — 멀티테넌트
  · 키가 없거나 API가 실패하면 가짜 주문을 만들지 않고 그대로 에러를 알린다
  · 같은 주문이 웹훅과 폴링으로 두 번 들어와도 PosSyncedOrder 대장이 중복을 막는다

실시간성은 두 겹이다:
  1) Square 웹훅(order.created/updated) → 주문 발생 즉시 반영 (서명 검증 필수)
  2) 자동 폴링(기본 5분) → 웹훅 미설정/유실 시의 안전망
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import logging
import os
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

import httpx
from cryptography.fernet import Fernet, InvalidToken
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.ai import PosConnection, PosSyncedOrder

logger = logging.getLogger(__name__)

AUTO_SYNC_INTERVAL = int(os.getenv("POS_AUTO_SYNC_INTERVAL", "300"))  # 초, 0이면 자동 폴링 끔
_MAX_WINDOW_HOURS = 72  # 한 번에 거슬러 올라가는 최대 범위 (오래 꺼져 있던 매장 보호)
_OVERLAP_MINUTES = 10   # last_synced_at에서 이만큼 겹쳐 조회 — 경계 주문 누락 방지 (중복은 대장이 거른다)


class PosError(Exception):
    pass


# ---------------------------------------------------------------------------
# 토큰 암호화 — SECRET_KEY에서 유도한 Fernet 키 (평문 토큰을 DB에 두지 않는다)
# ---------------------------------------------------------------------------

def _fernet() -> Fernet:
    from app.core.auth import SECRET_KEY

    key = base64.urlsafe_b64encode(hashlib.sha256(SECRET_KEY.encode()).digest())
    return Fernet(key)


def encrypt(value: str) -> str:
    return _fernet().encrypt(value.encode()).decode()


def decrypt(value: str) -> str:
    try:
        return _fernet().decrypt(value.encode()).decode()
    except InvalidToken as e:  # SECRET_KEY가 바뀐 경우 — 재연결 필요
        raise PosError("저장된 POS 토큰을 해독할 수 없습니다. 연결을 다시 저장해 주세요.") from e


def mask_token(token: str) -> str:
    if len(token) <= 8:
        return "****"
    return f"{token[:4]}…{token[-4:]}"


# ---------------------------------------------------------------------------
# Square API 클라이언트 — 연결(매장)별 토큰으로 호출. 실패 시 목 폴백 없이 에러.
# ---------------------------------------------------------------------------

def _base_url(environment: str) -> str:
    # 로컬 검증용 우회로 — 값이 있으면 그 주소를 Square 대신 부른다(모의 Square 서버).
    # 운영/배포에서는 이 env를 비워 두므로 항상 진짜 Square로 나간다.
    override = os.getenv("POS_SQUARE_BASE_URL", "").strip()
    if override:
        return override.rstrip("/")
    host = "connect.squareup.com" if environment == "production" else "connect.squareupsandbox.com"
    return f"https://{host}/v2"


def _headers(token: str) -> dict:
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


async def fetch_merchant_id(token: str, environment: str) -> str:
    """연결 검증 겸 merchant_id 조회 — 웹훅 이벤트를 매장으로 라우팅하는 열쇠."""
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.get(f"{_base_url(environment)}/merchants", headers=_headers(token))
    if resp.status_code == 401:
        raise PosError("Square 토큰이 유효하지 않습니다 (401). 토큰과 환경(sandbox/production)을 확인해 주세요.")
    if resp.status_code != 200:
        raise PosError(f"Square merchants 조회 실패 (HTTP {resp.status_code}).")
    merchants = resp.json().get("merchant", [])
    if not merchants:
        raise PosError("Square 계정에서 merchant 정보를 찾지 못했습니다.")
    return merchants[0]["id"]


async def _fetch_orders(token: str, environment: str, start_at: str, end_at: str) -> list[dict]:
    base = _base_url(environment)
    headers = _headers(token)
    async with httpx.AsyncClient(timeout=30) as client:
        loc_resp = await client.get(f"{base}/locations", headers=headers)
        if loc_resp.status_code != 200:
            raise PosError(f"Square locations 조회 실패 (HTTP {loc_resp.status_code}).")
        locations = [l["id"] for l in loc_resp.json().get("locations", [])]
        if not locations:
            raise PosError("Square 계정에 활성 매장(Location)이 없습니다.")

        states = ["COMPLETED", "OPEN"] if environment == "sandbox" else ["COMPLETED"]
        # Square orders/search는 요청당 location 10개 제한 — 예전엔 [:10]으로 잘라
        # 11번째 이후 매장의 매출이 소리 없이 누락됐다. 10개씩 나눠 전부 조회한다.
        orders: list[dict] = []
        for i in range(0, len(locations), 10):
            payload = {
                "location_ids": locations[i:i + 10],
                "query": {
                    "filter": {
                        "state_filter": {"states": states},
                        "date_time_filter": {"created_at": {"start_at": start_at, "end_at": end_at}},
                    },
                    "sort": {"sort_field": "CREATED_AT", "sort_order": "DESC"},
                },
            }
            resp = await client.post(f"{base}/orders/search", json=payload, headers=headers)
            if resp.status_code != 200:
                raise PosError(f"Square orders 검색 실패 (HTTP {resp.status_code}).")
            orders.extend(resp.json().get("orders", []))
        return orders


async def _fetch_order(token: str, environment: str, order_id: str) -> Optional[dict]:
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.get(f"{_base_url(environment)}/orders/{order_id}", headers=_headers(token))
    if resp.status_code == 404:
        return None
    if resp.status_code != 200:
        raise PosError(f"Square 주문 조회 실패 (HTTP {resp.status_code}).")
    return resp.json().get("order")


# ---------------------------------------------------------------------------
# 주문 → 매출 기록 (레시피 재고 차감 포함, 중복 방지)
# ---------------------------------------------------------------------------

def _parse_dt(value: str | None) -> datetime:
    if value:
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            pass
    return datetime.now(timezone.utc)


def record_orders(db: Session, store_id: str, orders: list[dict], provider: str = "square") -> dict:
    """Square 주문 목록을 Sale로 기록하고 레시피 기준 재고를 차감한다.

    메뉴 매칭은 매출 파일 임포트와 같은 규칙(_norm/_norm_menu — 온도·사이즈 꼬리표 무시)을
    재사용해, 파일로 올리든 POS로 들어오든 같은 이름은 같은 메뉴로 잡힌다.
    """
    from app.models.inventory import Menu, Recipe, Sale, Stock, StockTransaction
    from app.services.ai.sales_import_service import _norm, _norm_menu

    menus = db.query(Menu).filter(Menu.store_id == store_id, Menu.is_active == True).all()  # noqa: E712
    by_name = {_norm(m.name): m for m in menus}
    by_variant: dict[str, Any] = {}
    ambiguous: set[str] = set()
    for m in menus:
        k = _norm_menu(m.name)
        if not k:
            continue
        if k in by_variant and by_variant[k].id != m.id:
            ambiguous.add(k)
        else:
            by_variant[k] = m
    for k in ambiguous:
        by_variant.pop(k, None)

    menu_ids = [m.id for m in menus]
    recipes_by_menu: dict[int, list[tuple[int, float]]] = {}
    if menu_ids:
        for rc in db.query(Recipe).filter(Recipe.menu_id.in_(menu_ids)).all():
            recipes_by_menu.setdefault(rc.menu_id, []).append((rc.ingredient_id, rc.quantity))
    ing_ids = {ing for lst in recipes_by_menu.values() for (ing, _q) in lst}
    # 재고 행은 잠그고 읽는다(FOR UPDATE) — 웹훅·폴링·수동 조정이 같은 재료를 동시에
    # 건드리면 읽고-고치고-쓰는 사이의 갱신 하나가 소리 없이 사라져 재고 캐시가
    # 변동 장부 합계와 어긋난다. id 순 정렬은 교차 잠금 데드락 방지용.
    stock_by_ing = {
        s.ingredient_id: s
        for s in db.query(Stock).filter(Stock.ingredient_id.in_(ing_ids))
        .order_by(Stock.id).with_for_update().all()
    } if ing_ids else {}

    already = {
        r.order_id
        for r in db.query(PosSyncedOrder.order_id)
        .filter(PosSyncedOrder.store_id == store_id, PosSyncedOrder.provider == provider)
        .all()
    }

    created_sales = 0
    total_amount = 0
    skipped_dup = 0
    unmatched: dict[str, int] = {}
    synced_orders = 0

    for order in orders:
        order_id = order.get("id") or ""
        if not order_id:
            continue
        if order_id in already:
            skipped_dup += 1
            continue
        sold_at = _parse_dt(order.get("created_at"))
        order_had_sale = False

        for item in order.get("line_items", []) or []:
            name = (item.get("name") or "").strip()
            if not name:
                continue
            try:
                qty = max(1, int(float(item.get("quantity", "1"))))
            except (TypeError, ValueError):
                qty = 1
            money = item.get("total_money") or item.get("base_price_money") or {}
            amount = int(money.get("amount") or 0)  # KRW는 최소 단위가 원이라 그대로 쓴다
            if "total_money" not in item:
                amount = amount * qty

            menu = by_name.get(_norm(name)) or by_variant.get(_norm_menu(name))
            if menu is None:
                unmatched[name] = unmatched.get(name, 0) + qty
                continue

            db.add(Sale(menu_id=menu.id, quantity=qty, total_price=amount,
                        store_id=store_id, sold_at=sold_at))
            for ing_id, rqty in recipes_by_menu.get(menu.id, []):
                use = rqty * qty
                stock = stock_by_ing.get(ing_id)
                if stock is not None:
                    # 0에서 자르지 않는다 — 장부(StockTransaction)에는 -use 전액이 남는데
                    # 캐시만 0에서 멈추면 둘이 어긋나고, 발주 추천의 부족량 계산도
                    # 실제 부족분보다 적게 잡힌다. 수동 조정 경로와 같은 규칙(음수 허용).
                    stock.current_quantity -= use
                db.add(StockTransaction(ingredient_id=ing_id, quantity_change=-use,
                                        type="OUT", description=f"POS 실시간 동기화 ({provider})"))
            created_sales += 1
            total_amount += amount
            order_had_sale = True

        db.add(PosSyncedOrder(store_id=store_id, provider=provider, order_id=order_id))
        already.add(order_id)
        if order_had_sale:
            synced_orders += 1

    try:
        db.commit()
    except IntegrityError:
        # 웹훅과 폴링이 정확히 동시에 같은 주문을 넣은 경우 — 유니크 제약이 최후 방어선
        db.rollback()
        raise PosError("동시 동기화 충돌 — 잠시 후 자동으로 다시 시도됩니다.")

    return {
        "orders_seen": len(orders),
        "orders_synced": synced_orders,
        "orders_skipped_duplicate": skipped_dup,
        "sales_created": created_sales,
        "total_amount": total_amount,
        "unmatched_items": [{"name": k, "quantity": v} for k, v in sorted(unmatched.items())],
    }


# ---------------------------------------------------------------------------
# 동기화 진입점 — 수동(sync-now) · 자동 폴링 공용
# ---------------------------------------------------------------------------

async def sync_connection(db: Session, conn: PosConnection, hours: Optional[float] = None) -> dict:
    token = decrypt(conn.access_token_enc)
    now = datetime.now(timezone.utc)
    if hours is not None:
        start = now - timedelta(hours=min(hours, _MAX_WINDOW_HOURS))
    elif conn.last_synced_at is not None:
        last = conn.last_synced_at
        if last.tzinfo is None:
            last = last.replace(tzinfo=timezone.utc)
        start = max(last - timedelta(minutes=_OVERLAP_MINUTES), now - timedelta(hours=_MAX_WINDOW_HOURS))
    else:
        start = now - timedelta(hours=24)

    # 동기 SQLAlchemy(record_orders + commit)는 async 문맥에서 그대로 부르면 Neon 왕복
    # 동안 이벤트 루프가 멈춘다 — 주문 반영/상태 기록을 전부 스레드로 내린다.
    def _apply_ok(orders: list[dict]) -> dict:
        result = record_orders(db, conn.store_id, orders, provider=conn.provider)
        conn.last_synced_at = now
        conn.last_status = "ok"
        conn.last_error = None
        db.commit()
        return result

    def _mark_error(msg: str) -> None:
        conn.last_status = "error"
        conn.last_error = msg[:300]
        db.commit()

    try:
        orders = await _fetch_orders(
            token, conn.environment,
            start.strftime("%Y-%m-%dT%H:%M:%SZ"), now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        )
        return await asyncio.to_thread(_apply_ok, orders)
    except PosError as e:
        await asyncio.to_thread(_mark_error, str(e))
        raise
    except httpx.HTTPError as e:
        await asyncio.to_thread(_mark_error, f"네트워크 오류: {e}")
        raise PosError(f"Square 통신 실패: {e}") from e


async def sync_all_auto() -> dict:
    """auto_sync가 켜진 모든 연결을 순회 — 자동 폴링 루프와 cron 엔드포인트가 부른다."""
    from app.core.database import SessionLocal

    synced, failed = 0, 0
    with SessionLocal() as db:
        conns = await asyncio.to_thread(
            lambda: db.query(PosConnection).filter(PosConnection.auto_sync == True).all())  # noqa: E712
        for conn in conns:
            try:
                await sync_connection(db, conn)
                synced += 1
            except Exception as e:  # 한 매장의 실패가 다른 매장 동기화를 막으면 안 된다
                failed += 1
                logger.warning("[POS 자동동기화] %s 실패: %s", conn.store_id, e)
    return {"connections": synced + failed, "ok": synced, "failed": failed}


# ---------------------------------------------------------------------------
# Square 웹훅 — 서명 검증 후 해당 주문만 즉시 반영
# ---------------------------------------------------------------------------

def verify_square_signature(signature_key: str, notification_url: str, body: bytes, signature: str) -> bool:
    """Square 규격: base64(HMAC-SHA256(key, notification_url + raw_body))."""
    mac = hmac.new(signature_key.encode(), (notification_url.encode() + body), hashlib.sha256)
    expected = base64.b64encode(mac.digest()).decode()
    return hmac.compare_digest(expected, signature or "")


def _find_order_id(obj: Any) -> Optional[str]:
    """이벤트 페이로드 어디에 있든 order_id를 찾는다 (order.created/updated 등 형태 차이 흡수)."""
    if isinstance(obj, dict):
        for key, val in obj.items():
            if key == "order_id" and isinstance(val, str):
                return val
            if key == "id" and isinstance(val, str) and obj.get("state") is not None:
                return val
            found = _find_order_id(val)
            if found:
                return found
    elif isinstance(obj, list):
        for item in obj:
            found = _find_order_id(item)
            if found:
                return found
    return None


async def handle_square_webhook(db: Session, body: bytes, signature: str) -> dict:
    try:
        event = json.loads(body.decode("utf-8"))
    except Exception:
        raise PosError("웹훅 본문이 JSON이 아닙니다.")

    merchant_id = event.get("merchant_id")
    if not merchant_id:
        raise PosError("웹훅에 merchant_id가 없습니다.")

    conn = await asyncio.to_thread(
        lambda: db.query(PosConnection)
        .filter(PosConnection.merchant_id == merchant_id, PosConnection.provider == "square")
        .first()
    )
    if conn is None:
        raise PosError("이 merchant_id로 연결된 매장이 없습니다.")
    if not conn.webhook_signature_key_enc or not conn.webhook_url:
        raise PosError("이 매장은 웹훅 서명키가 설정되지 않았습니다.")

    sig_key = decrypt(conn.webhook_signature_key_enc)
    if not verify_square_signature(sig_key, conn.webhook_url, body, signature):
        raise PosError("웹훅 서명 검증 실패.")

    order_id = _find_order_id(event.get("data") or {})
    if not order_id:
        return {"handled": False, "reason": "주문 이벤트가 아님", "type": event.get("type")}

    token = decrypt(conn.access_token_enc)
    order = await _fetch_order(token, conn.environment, order_id)
    if order is None:
        return {"handled": False, "reason": "주문을 찾을 수 없음", "order_id": order_id}
    # 결제 완료 전(OPEN 등) 이벤트는 건너뛴다 — 완료 이벤트가 다시 온다 (sandbox는 OPEN도 허용)
    if conn.environment != "sandbox" and order.get("state") != "COMPLETED":
        return {"handled": False, "reason": f"미완료 주문({order.get('state')})", "order_id": order_id}

    def _apply() -> dict:
        result = record_orders(db, conn.store_id, [order], provider="square")
        conn.last_synced_at = datetime.now(timezone.utc)
        conn.last_status = "ok"
        conn.last_error = None
        db.commit()
        return result

    result = await asyncio.to_thread(_apply)
    return {"handled": True, "order_id": order_id, **result}
