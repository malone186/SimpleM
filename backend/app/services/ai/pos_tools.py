"""POS 실시간 연동 챗봇 도구 (백엔드 B) — "포스 연동 잘 되고 있어?"에 답한다

로직은 pos_service에 있고 여기는 챗봇 등록 래퍼만 둔다.
동기화 실행은 돈이 나가는 액션이 아니라 이미 결제된 매출을 장부에 옮기는
사실 기록이므로 draft_ 없이 바로 실행한다.
store_id는 main_agent의 _bind_store가 로그인 사용자 값으로 강제로 덮어쓴다.
"""

import json

from langchain_core.tools import tool

from app.models.ai import PosConnection
from app.services import pos_service


def _dump(data) -> str:
    return json.dumps(data, ensure_ascii=False, default=str)


@tool
def get_pos_status(store_id: str) -> str:
    """POS(Square) 실시간 연동 상태를 조회한다. '포스 연동 됐어?', 'POS 동기화 잘 되고 있어?',
    '마지막으로 언제 동기화됐어?'처럼 물을 때 쓴다.
    연결 여부, 환경(production/sandbox), 웹훅 설정 여부, 자동 동기화 여부,
    마지막 동기화 시각과 최근 성공/실패 상태를 준다.
    연결이 안 돼 있으면 판매 입력 화면의 'POS 실시간 연동' 카드에서 연결하라고 안내한다."""
    from app.core.database import SessionLocal

    with SessionLocal() as db:
        conn = db.query(PosConnection).filter(PosConnection.store_id == store_id).first()
        if conn is None:
            return _dump({"connected": False,
                          "안내": "POS가 연결돼 있지 않습니다. 판매 입력 화면의 'POS 실시간 연동' 카드에서 Square 토큰을 저장하면 됩니다."})
        return _dump({
            "connected": True,
            "provider": conn.provider,
            "environment": conn.environment,
            "webhook_configured": bool(conn.webhook_signature_key_enc),
            "auto_sync": conn.auto_sync,
            "last_synced_at": conn.last_synced_at.isoformat() if conn.last_synced_at else None,
            "last_status": conn.last_status,
            "last_error": conn.last_error,
        })


@tool
async def sync_pos_now(store_id: str, hours: float = 0) -> str:
    """POS(Square)에서 최근 주문을 지금 즉시 끌어와 매출·재고에 반영한다.
    '포스 매출 지금 동기화해 줘', '오늘 포스 매출 반영됐어?'처럼 요청할 때 쓴다.
    hours를 주면 그 시간만큼 거슬러 조회(최대 72), 0이면 마지막 동기화 이후분만 가져온다.
    결과로 반영된 주문 수·매출 건수·총액과, 메뉴에 없어 반영 못 한 미매칭 품목을 준다 —
    미매칭 품목이 있으면 메뉴 등록 후 다시 동기화하라고 안내한다."""
    from app.core.database import SessionLocal

    with SessionLocal() as db:
        conn = db.query(PosConnection).filter(PosConnection.store_id == store_id).first()
        if conn is None:
            return "POS가 연결돼 있지 않습니다. 판매 입력 화면의 'POS 실시간 연동' 카드에서 먼저 연결해 주세요."
        try:
            result = await pos_service.sync_connection(db, conn, hours=hours if hours > 0 else None)
        except pos_service.PosError as e:
            return f"동기화 실패: {e}"
        return _dump(result)


TOOLS = [get_pos_status, sync_pos_now]
