"""FastAPI 엔트리포인트 (공동 소유) — 라우터 추가는 알파벳순"""

import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.api.v1.router import api_router
from app.core.database import Base, engine, get_db, SessionLocal

# [설계도 수집] 데이터베이스 테이블을 만들기 전에, models 폴더 안의 설계도들을 수집하여 등록합니다.
import app.models  # noqa: F401

logger = logging.getLogger(__name__)

# [안전장치] 서버가 처음 기동할 때, 우리가 설계한 DB 테이블(User 등)이 실제 DB에 없으면 자동으로 생성해 줍니다.
# DB가 꺼져 있어도 서버 자체는 뜨도록 한다 — DB와 무관한 기능(OCR 등)은 독립 동작해야 함 (PRD §7)
try:
    Base.metadata.create_all(bind=engine)

    # [자가치유] 기존 users 테이블에 유입 경로 컬럼이 없으면 무중단으로 보강한다 (create_all은 기존 테이블을 ALTER하지 않음).
    from app.models.user import ensure_acquisition_columns
    ensure_acquisition_columns(engine)

    # [자가치유] 기존 employees 테이블에 store_id(매장 스코핑용) 컬럼이 없으면 보강한다.
    from app.models.operation import ensure_employee_store_column
    ensure_employee_store_column(engine)

    # [한글 주석] 로그인 데모를 즉시 하실 수 있게 테스트용 사장님 계정을 자동으로 생성(시딩)해 둡니다.
    db_session = SessionLocal()
    try:
        from app.core.auth import get_password_hash
        from app.models.user import User
        owner_exists = db_session.query(User).filter(User.email == "owner@cafe.com").first()
        if not owner_exists:
            hashed_pwd = get_password_hash("owner123")
            test_user = User(
                email="owner@cafe.com",
                hashed_password=hashed_pwd,
                name="포슬이",
                store_name="포슬카페"
            )
            db_session.add(test_user)
            db_session.commit()
            logger.info("🎉 테스트용 사장님 계정이 자동으로 생성되었습니다: owner@cafe.com / owner123")
    except Exception as seed_err:
        logger.error(f"테스트 계정 자동 생성 중 오류 발생: {seed_err}")
    finally:
        db_session.close()
except Exception:
    logger.exception("DB 테이블 자동 생성 실패 — DB 연결을 확인하세요. DB 없이 서버를 계속 띄웁니다.")

@asynccontextmanager
async def _lifespan(app: FastAPI):
    """로컬 VLM(OCR_BACKEND=qwen_vlm)을 미리 로드 — 첫 OCR 요청의 모델 로드 지연 제거.

    백그라운드 스레드로 돌아가므로 서버 기동을 막지 않고, 다른 백엔드에서는 즉시 반환한다.
    """
    from app.services.ai.ocr_service import warmup_ocr_backend

    warmup_ocr_backend()
    yield


app = FastAPI(
    title="SimpleM 카페 통합 플랫폼 API",
    description="재고·발주·운영·AI(챗봇/OCR/리포트) 기능을 제공하는 SimpleM 백엔드 API",
    version="1.0.0",
    lifespan=_lifespan,
)

# [CORS 설정] 
# 로컬 개발 및 기기 간 IP 접속(Failed to fetch) 시의 브라우저 CORS 차단을 방지하기 위해 
# 모든 http/https 오리진 주소 접속을 허용하되, 인증 토큰 전달(credentials)도 안전하게 성립시킵니다.
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex="https?://.*",  # 192.168.x.x 또는 localhost 등 모든 오리진 주소를 정규식 허용
    allow_credentials=True,             # 인증 정보(토큰/쿠키) 전송을 허용
    allow_methods=["*"],                # 모든 HTTP 메소드 허용
    allow_headers=["*"],                # 모든 커스텀 헤더 허용
)


# [활동 트래킹 수집] 앱의 모든 인증 요청을 tracking_events 테이블에 1건씩 기록한다(서버사이드 → 프론트 무수정).
#  - 마지막 접속·기능별 사용량·이탈 위험은 이 로그의 집계로 관리자 콘솔에 표시된다.
#  - 어떤 실패도 원 요청을 막지 않는다(전 구간 try/except). 관리자 콘솔 트래픽(/admin)·문서·헬스는 기록 제외.
@app.middleware("http")
async def track_activity(request, call_next):
    response = await call_next(request)
    try:
        path = request.url.path
        method = request.method
        # /api/v1 실사용 요청만 기록. 관리자 콘솔·인증 프리플라이트는 노이즈라 제외.
        if (
            method != "OPTIONS"
            and path.startswith("/api/v1")
            and not path.startswith("/api/v1/admin")
        ):
            from app.models.tracking import TrackingEvent, classify_feature

            # [베스트에포트] Authorization 헤더의 로컬 JWT에서 이메일(sub)만 조용히 추출 — 실패해도 무시.
            email = None
            auth_header = request.headers.get("authorization") or ""
            if auth_header.lower().startswith("bearer "):
                token = auth_header[7:].strip()
                try:
                    import jwt as _jwt
                    from app.core.auth import SECRET_KEY, ALGORITHM
                    payload = _jwt.decode(
                        token, SECRET_KEY, algorithms=[ALGORITHM],
                        options={"verify_exp": False},
                    )
                    email = payload.get("sub")
                except Exception:
                    email = None  # Firebase 토큰 등 로컬 해독 불가 시 익명 기록

            db_session = SessionLocal()
            try:
                db_session.add(TrackingEvent(
                    email=email,
                    method=method,
                    path=path[:255],
                    feature=classify_feature(path),
                    status_code=getattr(response, "status_code", None),
                ))
                db_session.commit()
            finally:
                db_session.close()
    except Exception:
        logger.debug("활동 트래킹 기록 실패(무시)", exc_info=True)
    return response


app.include_router(api_router, prefix="/api/v1")


# [공개 정책 페이지] 개인정보처리방침·이용약관을 인증 없이 접근 가능한 공개 URL로 게시합니다.
# Play Console 등록 및 앱 내 링크에 사용합니다. (예: https://<도메인>/legal/privacy.html)
# html=True → /legal/ 요청 시 index.html을 자동 제공.
_LEGAL_DIR = Path(__file__).parent / "static" / "legal"
app.mount("/legal", StaticFiles(directory=str(_LEGAL_DIR), html=True), name="legal")


# 1. 서버 작동 테스트용 첫 API (기본 주소로 들어왔을 때 환영 인사)
@app.get("/")
def read_root():
    return {
        "message": "SimpleM 카페 통합 플랫폼 백엔드 서버에 오신 것을 환영합니다!",
        "status": "online",
    }


# 2. 데이터베이스 접속이 실제로 잘 되는지 테스트해보는 맛보기 API
@app.get("/db-test")
def test_database_connection(db: Session = Depends(get_db)):
    try:
        # 데이터베이스에 "혹시 살아 있니?" 하고 가벼운 질문(SQL)을 던져봅니다.
        db.execute(text("SELECT 1"))
        return {
            "database": "success",
            "message": "PostgreSQL 데이터베이스(simpleM)와 연결이 아주 건강하게 성공했습니다!",
        }
    except Exception as e:
        return {
            "database": "fail",
            "error_detail": str(e),
            "message": "앗! 데이터베이스 연결에 문제가 발생했습니다. .env 파일의 주소나 패스워드를 점검해 주세요.",
        }


@app.get("/health")
async def health() -> dict:
    return {"status": "ok"}
