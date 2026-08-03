"""FastAPI 엔트리포인트 (공동 소유) — 라우터 추가는 알파벳순"""

import logging
import re
import time as _time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.api.v1.router import api_router
from app.core.database import Base, engine, get_db, SessionLocal

# [설계도 수집] 데이터베이스 테이블을 만들기 전에, models 폴더 안의 설계도들을 수집하여 등록합니다.
import app.models  # noqa: F401

logger = logging.getLogger(__name__)

# [로그 레벨] 루트 로거의 기본값은 WARNING이라 앱 코드의 logger.info(...)가 한 줄도 안 나간다.
# 그 탓에 "FCM 자격증명 로드 완료" 같은 기동 확인용 로그를 Cloud Run에서 grep해도 안 잡혀,
# 기능은 정상인데 미설정으로 오판하게 된다. INFO까지 내보낸다 (uvicorn 자체 로거는 그대로).
logging.basicConfig(level=logging.INFO, format="%(levelname)s:%(name)s:%(message)s")

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

    # [자가치유] 기존 ocr_documents 테이블에 store_id 컬럼이 없으면 보강한다 (매장별 OCR 조회용).
    from app.models.ai import ensure_ocr_store_column
    ensure_ocr_store_column(engine)

    # [자가치유] 기존 store_profiles 테이블에 configured 컬럼이 없으면 보강한다.
    from app.models.ai import ensure_store_profile_columns
    ensure_store_profile_columns(engine)

    # [자가치유] 기존 employee_profiles 테이블에 color(직원 대표색) 컬럼이 없으면 보강한다.
    from app.models.ai import ensure_employee_profile_columns
    ensure_employee_profile_columns(engine)

    # [자가치유] 기존 sales 테이블에 단골 연결용 customer_id·payment_method를 보강한다.
    from app.models.membership import ensure_sale_customer_columns
    ensure_sale_customer_columns(engine)

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
    """앱 수명 훅 — 백그라운드 폴링 작업들을 띄운다 (백엔드 B).

    · POS 자동 동기화: 웹훅이 실시간을 담당하고, 이 폴링은 웹훅 미설정/유실 매장의 안전망.
      POS_AUTO_SYNC_INTERVAL=0 이면 루프가 즉시 종료되어 아무 것도 하지 않는다.
    · 원두 시세 스냅샷: 가격 이력을 하루 1회 쌓아 추이(트렌드)의 원천 데이터를 만든다.
      오늘 쌓기 시작해야 다음 주에 그래프가 나오므로 앱이 뜰 때부터 돌린다.
      BEAN_SNAPSHOT_INTERVAL=0 이면 비활성.
    """
    import asyncio

    from app.api.v1.pos import auto_sync_loop
    from app.services.operation.bean_market_service import price_snapshot_loop

    pos_task = asyncio.create_task(auto_sync_loop())
    snapshot_task = asyncio.create_task(price_snapshot_loop())
    try:
        yield
    finally:
        pos_task.cancel()
        snapshot_task.cancel()


app = FastAPI(
    title="브루노트 카페 통합 플랫폼 API",
    description="재고·발주·운영·AI(챗봇/OCR/리포트) 기능을 제공하는 브루노트 백엔드 API",
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
#  - DB INSERT는 백그라운드 스레드에서 — 원격 DB 왕복(INSERT+COMMIT ~0.5초)이 모든 API
#    응답 시간에 그대로 얹히던 것을 제거한다. 트래킹은 베스트에포트라 유실 허용.
def _record_tracking(email, method, path, status_code):
    try:
        from app.models.tracking import TrackingEvent, classify_feature

        db_session = SessionLocal()
        try:
            db_session.add(TrackingEvent(
                email=email,
                method=method,
                path=path[:255],
                feature=classify_feature(path),
                status_code=status_code,
            ))
            db_session.commit()
        finally:
            db_session.close()
    except Exception:
        logger.debug("활동 트래킹 기록 실패(무시)", exc_info=True)


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

            import asyncio
            asyncio.get_running_loop().run_in_executor(
                None, _record_tracking, email, method, path,
                getattr(response, "status_code", None),
            )
    except Exception:
        logger.debug("활동 트래킹 기록 실패(무시)", exc_info=True)
    return response


app.include_router(api_router, prefix="/api/v1")


# [공개 정책 페이지] 개인정보처리방침·이용약관을 인증 없이 접근 가능한 공개 URL로 게시합니다.
# Play Console 등록 및 앱 내 링크에 사용합니다. (예: https://<도메인>/legal/privacy.html)
# html=True → /legal/ 요청 시 index.html을 자동 제공.
_LEGAL_DIR = Path(__file__).parent / "static" / "legal"
app.mount("/legal", StaticFiles(directory=str(_LEGAL_DIR), html=True), name="legal")

# [매장 위치 지도] 앱 WebView가 HTML 문자열을 baseUrl과 함께 로드하면 iOS가 Referer를
# 보내지 않아, Referer로 도메인을 검증하는 네이버 지도가 인증을 거부한다(지도가 안 뜬다).
# 지도 HTML을 실제 URL(https://<도메인>/map/)로 서빙하면 Referer가 정상 전송된다.
# NCP 콘솔 Maps Application의 "Web 서비스 URL"에 이 API 도메인을 등록해야 동작한다.
_MAP_DIR = Path(__file__).parent / "static" / "map"
app.mount("/map", StaticFiles(directory=str(_MAP_DIR), html=True), name="map")

# [관리자 콘솔] 예전 admin_web/(별도 http.server, 포트 3000)을 FastAPI가 직접 서빙한다 —
# 백엔드 배포(--source backend)에 같이 실려 Cloud Run에서도 /console로 접근 가능.
# 페이지는 Jinja 템플릿: 같은 origin의 API 상대 경로와 캐시 무효화 버전을 주입한다.
# 인증은 페이지가 아니라 API가 담당한다(/api/v1/admin/* 토큰 게이트) — 페이지 자체는 로그인 화면만 노출.
_CONSOLE_DIR = Path(__file__).parent / "admin_console"
app.mount("/console/static", StaticFiles(directory=str(_CONSOLE_DIR / "static")), name="console_static")
_console_templates = Jinja2Templates(directory=str(_CONSOLE_DIR / "templates"))
# 기동 시각을 asset 버전으로 → 재배포마다 브라우저 캐시가 자동 갱신된다 (수동 ?v= 올리기 불필요)
_CONSOLE_ASSET_VERSION = str(int(_time.time()))


@app.get("/console", include_in_schema=False)
def admin_console_page(request: Request):
    """관리자 데스크톱 콘솔 — Jinja 렌더링 (api_base=''는 같은 origin 상대 경로를 뜻한다)."""
    return _console_templates.TemplateResponse(
        request=request,
        name="index.html",
        context={"api_base": "", "asset_version": _CONSOLE_ASSET_VERSION},
    )


# 1. 데이터베이스 접속이 실제로 잘 되는지 테스트해보는 맛보기 API
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


def _db_identity() -> dict:
    """지금 붙어 있는 DB가 무엇인지 — 관리자 콘솔 '시스템 상태'에 그대로 표시된다.

    화면에 'PostgreSQL'이라고만 쓰면 운영 Neon에 붙었는지, 팀원 PC의 로컬 DB에 붙었는지,
    폴백으로 SQLite 파일에 쓰고 있는지 구분이 안 된다. 잘못된 DB에 붙은 채로 데모를 하면
    쓴 데이터가 어디로 갔는지 한참 뒤에야 알게 된다.

    접속 정보 중 계정·비밀번호는 절대 내보내지 않는다 — 종류/리전/DB명만 노출한다.
    """
    url = engine.url
    host = url.host or ""
    database = url.database or ""

    if url.drivername.startswith("sqlite"):
        # ALLOW_SQLITE_FALLBACK=1 로 켜지는 임시 모드 — 공유 DB에 안 쌓인다는 뜻이라 눈에 띄어야 한다
        return {"provider": "SQLite (로컬 폴백)", "region": "", "database": database}

    if "neon.tech" in host:
        # 호스트 모양이 두 가지다:
        #   ep-xxxx-pooler.ap-southeast-1.aws.neon.tech
        #   ep-xxxx-pooler.c-3.ap-southeast-1.aws.neon.tech   ← 'c-N'은 컴퓨트 번호지 리전이 아니다
        # 그냥 두 번째 라벨을 집으면 리전이 'c-3'으로 찍힌다. 리전 모양(xx-yyyy-N)을 찾는다.
        labels = host.split(".")
        region = next(
            (p for p in labels if re.fullmatch(r"[a-z]{2}-[a-z]+-\d+", p)),
            "",
        )
        return {"provider": "Neon PostgreSQL", "region": region, "database": database}

    if host in ("localhost", "127.0.0.1", ""):
        return {"provider": "로컬 PostgreSQL", "region": "", "database": database}

    return {"provider": "PostgreSQL", "region": "", "database": database}


@app.get("/health")
async def health() -> dict:
    """구성요소별 상태 — 관리자 콘솔의 '시스템 상태'가 읽는다.

    예전엔 {"status":"ok"}만 돌려줘서 화면이 볼 게 없었고, 그래서 DB는 API 상태를 그대로
    베껴 쓰고 OCR은 아예 '대기'로 하드코딩돼 있었다. 실제로 확인해서 알려준다.

    OCR은 켜 둘 프로세스가 없다 — Gemini REST 호출이라 API 키만 있으면 바로 쓸 수 있다.
    (로컬 VLM 서빙 시절에는 llama-server 예열을 기다려야 해서 '대기'가 의미 있었다.)
    """
    from app.core.database import SessionLocal, engine
    from app.services.ai import ocr_service

    db_ok = False
    db_detail = ""
    try:
        with SessionLocal() as session:
            session.execute(text("SELECT 1"))
        db_ok = True
    except Exception as e:
        db_detail = str(e)[:120]

    ocr_ready = bool(ocr_service.GEMINI_API_KEY)
    return {
        "status": "ok" if db_ok else "degraded",
        "components": {
            "api": {"ok": True},
            "db": {"ok": db_ok, "detail": db_detail, **_db_identity()},
            "ocr": {
                "ok": ocr_ready,
                # 키가 없으면 업로드해도 502가 나므로 그 사실을 그대로 말한다
                "detail": ocr_service.GEMINI_MODEL if ocr_ready else "GEMINI_API_KEY 미설정",
                "backend": ocr_service.OCR_BACKEND,
            },
        },
    }


# [웹 앱 서빙 — 반드시 파일 맨 끝에 둘 것] frontend/dist(expo export --platform web 산출물)가
# 있으면 루트에서 SPA로 제공한다 — 아이폰 등 앱 미설치 사용자용 웹 버전.
# Mount("/")는 모든 경로를 삼키므로, 위의 /api/v1·/legal·/health가 먼저 등록된 뒤에 와야 한다.
_WEB_DIST = Path(__file__).resolve().parents[2] / "frontend" / "dist"
if _WEB_DIST.exists():
    app.mount("/", StaticFiles(directory=str(_WEB_DIST), html=True), name="webapp")
else:
    @app.get("/")
    def read_root():
        return {
            "message": "브루노트 카페 통합 플랫폼 백엔드 서버에 오신 것을 환영합니다!",
            "status": "online",
        }
