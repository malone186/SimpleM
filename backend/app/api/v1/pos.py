"""POS 실시간 연동 API (백엔드 B) — 연결 관리 · 즉시 동기화 · Square 웹훅 · 자동 폴링

기존 /operation/pos/sync(데모·목 폴백)와 별개의 실경로다. 여기는 목이 없다:
연결이 없으면 없다고 말하고, Square가 실패하면 실패했다고 말한다.
"""
import asyncio
import logging
import os

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.core.auth import get_current_user
from app.core.database import get_db
from app.models.ai import PosConnection
from app.models.user import User
from app.services import pos_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/pos", tags=["POS 실시간 연동"])

# 스케줄러(Cloud Scheduler 등)용 공유 비밀 — 비어 있으면 run-sync 엔드포인트는 404로 숨긴다
CRON_SECRET = os.getenv("POS_SYNC_CRON_SECRET", "")


# ---------------------------------------------------------------------------
# 스키마
# ---------------------------------------------------------------------------

class PosConnectionIn(BaseModel):
    provider: str = Field("square", description="현재 square만 지원")
    environment: str = Field("production", description="production | sandbox")
    access_token: str = Field(..., min_length=8, description="Square Access Token")
    webhook_signature_key: str | None = Field(None, description="Square Webhook Signature Key (실시간 웹훅용, 선택)")
    auto_sync: bool = Field(True, description="주기 자동 동기화 사용 여부")


class PosConnectionOut(BaseModel):
    connected: bool
    provider: str | None = None
    environment: str | None = None
    access_token_masked: str | None = None
    webhook_configured: bool = False
    webhook_url: str | None = None
    merchant_id: str | None = None
    auto_sync: bool | None = None
    last_synced_at: str | None = None
    last_status: str | None = None
    last_error: str | None = None


def _to_out(conn: PosConnection | None) -> PosConnectionOut:
    if conn is None:
        return PosConnectionOut(connected=False)
    return PosConnectionOut(
        connected=True,
        provider=conn.provider,
        environment=conn.environment,
        access_token_masked=pos_service.mask_token(pos_service.decrypt(conn.access_token_enc)),
        webhook_configured=bool(conn.webhook_signature_key_enc),
        webhook_url=conn.webhook_url,
        merchant_id=conn.merchant_id,
        auto_sync=conn.auto_sync,
        last_synced_at=conn.last_synced_at.isoformat() if conn.last_synced_at else None,
        last_status=conn.last_status,
        last_error=conn.last_error,
    )


def _webhook_url_for(request: Request) -> str:
    """이 서버가 밖에서 불리는 웹훅 주소 — Square 대시보드에 등록할 URL이자 서명 검증 기준."""
    base = str(request.base_url).rstrip("/")
    # Cloud Run 뒤에서는 프록시가 http로 보일 수 있다 — 공개 주소는 항상 https다
    if base.startswith("http://") and "localhost" not in base and "127.0.0.1" not in base:
        base = "https://" + base[len("http://"):]
    return f"{base}/api/v1/pos/webhook/square"


# ---------------------------------------------------------------------------
# 연결 관리
# ---------------------------------------------------------------------------

@router.get("/connection", response_model=PosConnectionOut)
def get_connection(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    conn = db.query(PosConnection).filter(PosConnection.store_id == current_user.email).first()
    return _to_out(conn)


@router.put("/connection", response_model=PosConnectionOut)
async def put_connection(
    body: PosConnectionIn,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """연결 저장 — 저장 전에 실제 Square에 토큰을 검증하고 merchant_id를 받아둔다.

    잘못된 토큰이 조용히 저장돼 자동 동기화가 영원히 실패하는 상태를 만들지 않기 위해,
    검증 실패면 저장하지 않고 400으로 알려준다.
    """
    if body.provider != "square":
        raise HTTPException(400, "현재는 Square만 지원합니다.")
    if body.environment not in ("production", "sandbox"):
        raise HTTPException(400, "environment는 production 또는 sandbox여야 합니다.")

    try:
        merchant_id = await pos_service.fetch_merchant_id(body.access_token, body.environment)
    except pos_service.PosError as e:
        raise HTTPException(400, str(e))

    # 동기 SQLAlchemy는 async 핸들러에서 그대로 부르면 Neon 왕복(~0.2초/쿼리) 동안
    # 이벤트 루프 전체가 멈춘다 — /chatbot/chat의 쿼터 처리와 같은 이유로 스레드로 내린다.
    def _save() -> PosConnection:
        conn = db.query(PosConnection).filter(PosConnection.store_id == current_user.email).first()
        if conn is None:
            conn = PosConnection(store_id=current_user.email)
            db.add(conn)
        conn.provider = body.provider
        conn.environment = body.environment
        conn.access_token_enc = pos_service.encrypt(body.access_token)
        conn.webhook_signature_key_enc = (
            pos_service.encrypt(body.webhook_signature_key) if body.webhook_signature_key else None
        )
        conn.webhook_url = _webhook_url_for(request)
        conn.merchant_id = merchant_id
        conn.auto_sync = body.auto_sync
        conn.last_status = None
        conn.last_error = None
        db.commit()
        db.refresh(conn)
        return conn

    return _to_out(await asyncio.to_thread(_save))


@router.delete("/connection", status_code=204)
def delete_connection(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    db.query(PosConnection).filter(PosConnection.store_id == current_user.email).delete()
    db.commit()


# ---------------------------------------------------------------------------
# 동기화
# ---------------------------------------------------------------------------

@router.post("/sync-now")
async def sync_now(
    hours: float | None = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """지금 즉시 동기화 — hours를 주면 그 시간만큼 거슬러 조회(최대 72h), 없으면 마지막 동기화 이후."""
    conn = await asyncio.to_thread(
        lambda: db.query(PosConnection).filter(PosConnection.store_id == current_user.email).first())
    if conn is None:
        raise HTTPException(409, "POS가 연결돼 있지 않습니다. 먼저 연결을 저장해 주세요.")
    try:
        return await pos_service.sync_connection(db, conn, hours=hours)
    except pos_service.PosError as e:
        raise HTTPException(502, str(e))


@router.post("/run-sync")
async def run_sync_for_scheduler(x_cron_secret: str = Header(default="")):
    """모든 매장 자동 동기화 — 외부 스케줄러 전용 (공유 비밀 필요, 미설정 시 존재 자체를 숨김)."""
    if not CRON_SECRET:
        raise HTTPException(404, "Not Found")
    if x_cron_secret != CRON_SECRET:
        raise HTTPException(403, "Forbidden")
    return await pos_service.sync_all_auto()


# ---------------------------------------------------------------------------
# Square 웹훅 — 인증 대신 서명 검증 (Square 서버가 부른다)
# ---------------------------------------------------------------------------

@router.post("/webhook/square")
async def square_webhook(
    request: Request,
    db: Session = Depends(get_db),
    x_square_hmacsha256_signature: str = Header(default=""),
):
    body = await request.body()
    try:
        return await pos_service.handle_square_webhook(db, body, x_square_hmacsha256_signature)
    except pos_service.PosError as e:
        # 서명 실패·미연결 merchant 등 — Square가 재시도 폭주하지 않게 4xx로 종결
        logger.warning("[POS 웹훅] 거부: %s", e)
        raise HTTPException(400, str(e))


# ---------------------------------------------------------------------------
# 자동 폴링 루프 — main.py lifespan에서 시작한다 (웹훅 미설정 매장의 안전망)
# ---------------------------------------------------------------------------

async def auto_sync_loop():
    interval = pos_service.AUTO_SYNC_INTERVAL
    if interval <= 0:
        logger.info("[POS 자동동기화] POS_AUTO_SYNC_INTERVAL<=0 — 폴링 비활성")
        return
    logger.info("[POS 자동동기화] %d초 간격 폴링 시작", interval)
    while True:
        try:
            await asyncio.sleep(interval)
            result = await pos_service.sync_all_auto()
            if result["connections"]:
                logger.info("[POS 자동동기화] %s", result)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("[POS 자동동기화] 루프 오류 — 다음 주기에 재시도")
