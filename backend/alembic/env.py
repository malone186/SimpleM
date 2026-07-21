# c:\Users\USER\Documents\본 프로젝트\SimpleM\backend\alembic\env.py
"""
[한글 주석] Alembic 마이그레이션 환경 설정 (simplem 전용 스키마 격리 및 타 서비스 테이블 보존 필터)
"""

import os
import sys
from logging.config import fileConfig

from sqlalchemy import engine_from_config, pool
from alembic import context

# 백엔드 최상위 디렉터리를 sys.path에 추가하여 app 모듈 접근 허용
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

# .env 환경 변수를 로드합니다.
from dotenv import load_dotenv
load_dotenv()

config = context.config

db_url = os.getenv("DATABASE_URL", "sqlite:///./simplem.db")
if db_url and not db_url.startswith("driver"):
    config.set_main_option("sqlalchemy.url", db_url)

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# [한글 주석] simplem 스키마 지정 메타데이터 불러오기
from app.core.database import Base
import app.models  
target_metadata = Base.metadata


# [한글 주석] 타 서비스 테이블 자동 삭제(DROP TABLE)를 방지하는 안전 필터 함수
def include_object(object, name, type_, reflected, compare_to):
    """
    - type_ == 'table' 인 경우, 스키마가 'simplem'이 아닌 다른 서비스/public 스키마의 테이블은 autogenerate에서 배제합니다.
    """
    if type_ == "table":
        # object의 schema가 simplem이 아니거나 None이면 제외 (simplem 스키마 전용 대상)
        if getattr(object, 'schema', None) != "simplem":
            return False
    return True


import os
db_schema = os.getenv("DB_SCHEMA", None)

def run_migrations_offline() -> None:
    """Run migrations in 'offline' mode."""
    url = config.get_main_option("sqlalchemy.url")
    opts = {
        "url": url,
        "target_metadata": target_metadata,
        "literal_binds": True,
        "dialect_opts": {"paramstyle": "named"},
        "include_object": include_object,
    }
    if db_schema:
        opts["version_table_schema"] = db_schema
        opts["include_schemas"] = True

    context.configure(**opts)

    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    """Run migrations in 'online' mode."""
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )

    with connectable.connect() as connection:
        opts = {
            "connection": connection,
            "target_metadata": target_metadata,
            "include_object": include_object,
        }
        if db_schema:
            opts["version_table_schema"] = db_schema
            opts["include_schemas"] = True

        context.configure(**opts)

        with context.begin_transaction():
            context.run_migrations()



if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
