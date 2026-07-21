# c:\Users\USER\Documents\본 프로젝트\SimpleM\backend\scripts\test_db_connection.py
"""
[한글 주석] PostgreSQL 데이터베이스 통신 및 simplem 스키마 격리 안심 검증 스크립트
"""

import sys
import os

# 백엔드 최상위 디렉터리를 sys.path에 추가하여 app 모듈 접근 허용
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from sqlalchemy import text
from app.core.database import engine, SessionLocal, DATABASE_URL


def test_db_connection():
    print("\n" + "=" * 75)
    print("      [SimpleM PostgreSQL 데이터베이스 연결 & 스키마 검증 시작]")
    print("=" * 75)

    # 1. DATABASE_URL 시크릿 마스킹 출력
    masked_url = DATABASE_URL
    if "@" in masked_url:
        prefix, rest = masked_url.split("@", 1)
        masked_url = f"{prefix.split(':')[0]}:****@{rest}"
    print(f" - 연결 시도 URL: {masked_url}")

    # 2. SELECT 1 basic query test (pool_pre_ping 동작 검증)
    print("\n[검증 1] SELECT 1 기초 통신 테스트 (pool_pre_ping)")
    print("-" * 75)
    try:
        with engine.connect() as conn:
            result = conn.execute(text("SELECT 1;")).scalar()
            print(f" - 응답 결과: {result} (연결 100% 정상)")
            assert result == 1, "SELECT 1 응답이 1이어야 합니다."
    except Exception as e:
        print(f" ❌ DB 기본 연결 실패: {e}")
        return

    # 3. simplem 스키마 존재 및 권한 확인
    print("\n\n[검증 2] simplem 전용 스키마 존재 여부 및 권한 테스트")
    print("-" * 75)
    try:
        with engine.connect() as conn:
            # simplem 스키마 시도 (권한 없을 시 쿼리 오류 포획)
            try:
                conn.execute(text("CREATE SCHEMA IF NOT EXISTS simplem;"))
                conn.commit()
            except Exception:
                conn.rollback()

            # 스키마 목록 조회
            schemas = conn.execute(text("SELECT schema_name FROM information_schema.schemata WHERE schema_name = 'simplem';")).fetchall()
            print(f" - simplem 스키마 존재 여부 확인: {schemas}")
            if not schemas:
                print(" [알림] simplem 스키마가 아직 생성되지 않았습니다.")
                print(" -> pgAdmin Query Tool에서 'scripts/init_simplem_schema.sql'을 관리자 권한으로 1회 실행하세요.")
    except Exception as e:
        print(f" [ERROR] simplem 스키마 접근 주의: {e}")
        return

    # 4. simplem 스키마 내부 임시 검증 테이블 CRUD 테스트
    print("\n\n[검증 3] simplem 스키마 내부 안전 CRUD 테스트")
    print("-" * 75)
    try:
        with engine.connect() as conn:
            conn.execute(text("""
                CREATE TABLE IF NOT EXISTS simplem.test_schema_isolation (
                    id SERIAL PRIMARY KEY,
                    message VARCHAR(100) NOT NULL
                );
            """))
            conn.commit()

            # Insert
            conn.execute(text("INSERT INTO simplem.test_schema_isolation (message) VALUES ('schema_isolation_ok');"))
            conn.commit()

            # Select
            msg = conn.execute(text("SELECT message FROM simplem.test_schema_isolation ORDER BY id DESC LIMIT 1;")).scalar()
            print(f" - simplem 스키마 내 CRUD 읽기 결과: '{msg}'")

            # Cleanup test table
            conn.execute(text("DROP TABLE simplem.test_schema_isolation;"))
            conn.commit()
            print(" - 임시 검증 테이블 자원 정리 완료")
    except Exception as e:
        print(f" [INFO] simplem 스키마 CRUD 생성 권한 대기 중: {e}")
        print(" -> pgAdmin에서 'GRANT ALL ON SCHEMA simplem TO [계정명];' 권한 부여를 완료하면 즉시 활성화됩니다.")


    print("\n" + "=" * 75)
    print("      [팀 공용 PostgreSQL 연동 및 simplem 스키마 연동 안내 테스트 완료!]")

    print("=" * 75)


if __name__ == "__main__":
    test_db_connection()
