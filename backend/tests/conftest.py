"""테스트 전역 설정 — 앱 모듈을 불러오기 전에 먼저 해둬야 하는 것들.

pytest는 테스트 모듈보다 conftest를 먼저 읽는다. 그래서 import 시점에 부수효과가
있는 코드를 막으려면 여기서, 모듈 수준으로 처리해야 한다.
"""
import os
from pathlib import Path

# 사진 합성 배경 예열은 app.api.v1.chatbot을 부르는 순간 스레드를 띄워
# 배경 5장을 외부(Pollinations)에 생성 요청한다. 서버 기동에는 필요한 동작이지만
# 테스트에서는 매번 나갈 이유가 없다 — 검증하는 것도 아니고, 오프라인이면 그냥 기다린다.
os.environ.setdefault("PHOTO_BG_WARM", "0")

# ── 테스트 DB는 로컬 sqlite ────────────────────────────────────────────────
#
# 예전엔 app.core.database의 SessionLocal/engine을 그대로 쓰는 테스트가 5개 있었고,
# 그게 곧 '운영 Neon에 붙는다'는 뜻이었다. 결과가 셋 다 나빴다:
#   · 전체 실행이 8분 10초 (대부분 서울↔싱가포르 왕복 대기)
#   · 네트워크가 흔들리면 OperationalError로 우수수 실패 — 실제로 12건 났다
#   · 테스트가 운영 DB에 행을 쓰고 지운다 (전용 store_id를 쓰지만 위험은 위험이다)
# 그래서 여기서 주소를 sqlite로 바꾼다. conftest는 테스트 모듈보다 먼저 읽히므로
# app.core.database가 import되기 전에 갈아끼울 수 있다 (load_dotenv는 이미 있는
# 환경변수를 덮지 않으므로 .env의 Neon 주소를 이긴다).
#
# 파일 기반인 이유: SessionLocal()을 여러 번 여는 테스트가 있는데 :memory:는 연결마다
# 빈 DB라 서로 못 본다. 매 실행 처음에 지워 앞선 실행의 찌꺼기를 물려받지 않는다.
_TEST_DB = Path(__file__).resolve().parent.parent / ".test_local.db"
_TEST_DB.unlink(missing_ok=True)
os.environ["DATABASE_URL"] = f"sqlite:///{_TEST_DB}"
os.environ["ALLOW_SQLITE_FALLBACK"] = "1"

# 운영에서는 app.main이 기동하며 create_all로 만든다. 테스트는 app.main을 안 띄우는
# 경우가 많아 여기서 한 번 만들어 둔다 (모델을 전부 import해야 메타데이터가 찬다).
from app.core.database import Base, engine  # noqa: E402
import app.models  # noqa: E402,F401  — 모든 모델을 메타데이터에 등록

Base.metadata.create_all(bind=engine)
