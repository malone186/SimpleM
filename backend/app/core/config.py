# c:\STUDY\SimpleM\backend\app\core\config.py
import os
from pathlib import Path

def load_env_file() -> None:
    """루트 폴더에 위치한 .env 파일을 수동으로 찾아서 환경변수로 로드합니다.
    외부 라이브러리(python-dotenv 등) 없이도 한글 주석을 포함해 안전하게 읽을 수 있게 설계되었습니다.
    """
    # config.py 기준으로 프로젝트 루트 폴더에 있는 .env 파일 주소를 계산합니다.
    env_file = Path(__file__).resolve().parents[3] / ".env"
    if not env_file.exists():
        return
        
    with open(env_file, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            # 빈 줄, 주석(#)이거나 등호(=)가 없는 줄은 건너뜁니다.
            if not line or line.startswith("#") or "=" not in line:
                continue
            # key와 value를 등호 기준으로 안전하게 쪼갭니다.
            key, _, value = line.partition("=")
            # 이미 시스템 환경변수에 등록되어 있지 않다면 채워 넣습니다.
            os.environ.setdefault(key.strip(), value.strip())

# 환경변수 로딩 작업을 시작합니다.
load_env_file()

# [Square POS 연동 핵심 변수들]
# 사장님이 Connect API v2에 접속할 때 쓰는 출입 주소 및 자격증명 정보입니다.
SQUARE_APP_ID = os.getenv("SQUARE_APP_ID", "")
SQUARE_ACCESS_TOKEN = os.getenv("SQUARE_ACCESS_TOKEN", "")
SQUARE_ENVIRONMENT = os.getenv("SQUARE_ENVIRONMENT", "sandbox").lower()
