# c:\STUDY\SimpleM\backend\app\models\user.py
import logging

from sqlalchemy import Column, Integer, String, DateTime, inspect, text
from sqlalchemy.sql import func
from app.core.database import Base

logger = logging.getLogger(__name__)

# 데이터베이스에 저장될 'users' 테이블의 구조 설계도입니다.
class User(Base):
    __tablename__ = "users"  # 데이터베이스 내의 실제 테이블 이름입니다.

    # 1. 고유 식별 번호 (1, 2, 3... 자동으로 하나씩 증가하며 부여됩니다.)
    id = Column(Integer, primary_key=True, index=True)

    # 2. 로그인용 이메일 주소 (아이디 역할, 중복 가입을 막기 위해 unique 옵션을 줍니다.)
    email = Column(String(100), unique=True, index=True, nullable=False)

    # 3. 암호화된 비밀번호 (보안을 위해 글자 그대로 저장하지 않고, 암호화된 외계어 상태로 보관합니다.)
    hashed_password = Column(String(255), nullable=False)

    # 4. 점주(사용자)의 이름 (예: "홍길동")
    name = Column(String(50), nullable=False)

    # 5. 매장(카페) 이름 (예: "포자카페 강남점")
    store_name = Column(String(100), nullable=False)

    # 6. 계정이 생성된 날짜와 시간 (회원가입이 완료되는 시점의 현재 시각이 자동으로 입력됩니다.)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)

    # 7. 유입 경로(Acquisition) — 가입 시점 first-touch 1건. 전부 nullable → 기존 회원/구버전 앱과 하위호환.
    #    acquisition_source: 정규 채널 키(referral/web_search/instagram/app_store/youtube/naver_blog/etc)
    #    acquisition_detail: 캠페인명/추천코드 등 보조 원문값
    #    acquisition_at    : 트래킹 값이 실제 수집된 시각(가입시각과 분리 보관)
    acquisition_source = Column(String(30), nullable=True)
    acquisition_detail = Column(String(120), nullable=True)
    acquisition_at = Column(DateTime(timezone=True), nullable=True)


def ensure_acquisition_columns(engine) -> None:
    """[자가치유 스키마] 기존 users 테이블에 유입 경로 컬럼이 없으면 멱등하게 ADD COLUMN 한다.
    Base.metadata.create_all은 '기존 테이블'에 컬럼을 추가하지 않으므로, 배포 시 무중단으로 컬럼을 보강한다.
    전부 nullable이라 팀원 코드/구버전 앱에 영향이 없다. (정식 alembic 마이그레이션은 추후 백엔드 A와 보강)"""
    try:
        insp = inspect(engine)
        if not insp.has_table("users"):
            return  # 테이블 자체가 아직 없으면 create_all이 스키마째로 생성한다.
        existing = {c["name"] for c in insp.get_columns("users")}
    except Exception as e:
        logger.warning(f"[유입경로 스키마] users 테이블 점검 실패 — 건너뜁니다: {e}")
        return

    is_pg = engine.dialect.name == "postgresql"
    ts_type = "TIMESTAMP WITH TIME ZONE" if is_pg else "DATETIME"
    wanted = {
        "acquisition_source": "VARCHAR(30)",
        "acquisition_detail": "VARCHAR(120)",
        "acquisition_at": ts_type,
    }
    missing = {name: coltype for name, coltype in wanted.items() if name not in existing}
    if not missing:
        return
    try:
        with engine.begin() as conn:
            for name, coltype in missing.items():
                conn.execute(text(f"ALTER TABLE users ADD COLUMN {name} {coltype}"))
        logger.info(f"[유입경로 스키마] users 테이블에 컬럼 추가 완료: {', '.join(missing)}")
    except Exception as e:
        logger.warning(f"[유입경로 스키마] 컬럼 추가 실패 — 유입경로는 추정값으로 폴백됩니다: {e}")
