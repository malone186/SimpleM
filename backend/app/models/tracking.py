"""사용자 활동 트래킹 이벤트 모델 (백엔드 B 소유)

- 앱의 모든 인증 요청을 미들웨어가 이 테이블에 1건씩 기록한다(서버사이드 수집 → 프론트 무수정).
- '새로 만드는 테이블'이라 앱 DB 계정이 소유자가 되어, 기존 users 테이블 ALTER 권한 문제(InsufficientPrivilege)를 우회한다.
- 마지막 접속(last_active)·활성화 시각·기능별 사용량은 전부 이 이벤트 로그의 집계로 파생된다(별도 컬럼 불필요).
"""
from sqlalchemy import Column, Integer, String, DateTime, Index
from sqlalchemy.sql import func

from app.core.database import Base


# 경로 접두어 → 화면에 보여줄 기능 카테고리 라벨
_FEATURE_MAP = {
    "inventory": "재고",
    "operation": "운영",
    "chatbot": "챗봇",
    "auth": "인증",
    "law": "법률",
    "sensor": "센서",
    "roastery": "원두검색",
    "inquiry": "문의",
}


def classify_feature(path: str) -> str:
    """'/api/v1/<도메인>/...' 경로를 기능 카테고리로 분류한다. 미분류는 '기타'."""
    try:
        parts = [p for p in path.split("/") if p]
        # ["api", "v1", "<domain>", ...]
        if len(parts) >= 3 and parts[0] == "api" and parts[1] == "v1":
            domain = parts[2]
            for key, label in _FEATURE_MAP.items():
                if domain.startswith(key):
                    return label
    except Exception:
        pass
    return "기타"


class TrackingEvent(Base):
    __tablename__ = "tracking_events"

    id = Column(Integer, primary_key=True, index=True)
    email = Column(String(100), index=True, nullable=True)   # 누가 (비로그인/토큰없는 요청은 NULL)
    method = Column(String(10), nullable=True)               # GET/POST/...
    path = Column(String(255), nullable=True)                # 요청 경로
    feature = Column(String(40), index=True, nullable=True)  # 기능 카테고리(재고/운영/챗봇...)
    status_code = Column(Integer, nullable=True)             # 응답 상태 코드
    created_at = Column(DateTime(timezone=True), server_default=func.now(), index=True, nullable=False)

    __table_args__ = (
        Index("ix_tracking_email_created", "email", "created_at"),
    )
