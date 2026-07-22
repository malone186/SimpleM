"""로컬 PostgreSQL → Neon(또는 임의의 Postgres) 데이터 이관 스크립트.

pg_dump 없이 SQLAlchemy만으로 스키마 생성 + 전체 데이터 복사 + 시퀀스 재설정까지 처리한다.

사용법 (backend 폴더에서):
    # 대상(Neon) 주소만 넘기면, 소스는 .env의 DATABASE_URL(로컬)을 사용
    TARGET_DATABASE_URL="postgresql://user:pw@ep-xxx-pooler.region.aws.neon.tech/db?sslmode=require" \
        ./.venv/Scripts/python.exe scripts/migrate_to_neon.py

    # 소스도 명시하고 싶으면
    SOURCE_DATABASE_URL="postgresql://Blaze:simpleM@127.0.0.1:5432/simpleM" \
    TARGET_DATABASE_URL="postgresql://...neon.../db?sslmode=require" \
        ./.venv/Scripts/python.exe scripts/migrate_to_neon.py

    # 대상 테이블을 먼저 비우고(재이관) 복사하려면
    WIPE_TARGET=1 TARGET_DATABASE_URL="..." ./.venv/Scripts/python.exe scripts/migrate_to_neon.py

주의:
  - 대상에 이미 데이터가 있으면 PK 충돌이 날 수 있다. 재이관 시 WIPE_TARGET=1 을 쓸 것.
  - Neon 주소에는 반드시 ?sslmode=require 를 붙일 것.
"""
import os
import sys

# scripts/ 에서 직접 실행해도 backend 패키지를 찾도록 상위 디렉터리를 경로에 추가
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# 모든 모델 모듈을 로드해 Base.metadata에 전체 테이블을 등록한다.
import app.models  # noqa: F401,E402  (side-effect import)
from app.core.database import Base
from sqlalchemy import create_engine, text


def main() -> None:
    source_url = os.getenv("SOURCE_DATABASE_URL") or os.getenv("DATABASE_URL")
    target_url = os.getenv("TARGET_DATABASE_URL")

    if not target_url:
        print("[오류] TARGET_DATABASE_URL 환경변수가 필요합니다 (Neon 연결 문자열).")
        sys.exit(1)
    if not source_url:
        print("[오류] SOURCE_DATABASE_URL 또는 DATABASE_URL 이 필요합니다 (원본 로컬 DB).")
        sys.exit(1)
    if source_url == target_url:
        print("[오류] 소스와 대상이 동일합니다. 서로 다른 DB를 지정하세요.")
        sys.exit(1)

    print(f"[소스]  {source_url.split('@')[-1]}")
    print(f"[대상]  {target_url.split('@')[-1]}")

    src = create_engine(source_url, connect_args={"connect_timeout": 10})
    tgt = create_engine(target_url, connect_args={"connect_timeout": 15})

    # 연결 확인
    with src.connect():
        pass
    with tgt.connect():
        pass
    print("[연결] 소스·대상 모두 연결 성공.")

    tables = Base.metadata.sorted_tables  # FK 의존성 순서 (부모 → 자식)

    # 1) 대상에 스키마 생성 (이미 있으면 건너뜀)
    Base.metadata.create_all(tgt)
    print(f"[스키마] 대상에 테이블 {len(tables)}개 생성/확인 완료.")

    # 2) (선택) 대상 데이터 비우기 — 자식 → 부모 역순으로 삭제
    if os.getenv("WIPE_TARGET") == "1":
        with tgt.begin() as conn:
            for table in reversed(tables):
                conn.execute(table.delete())
        print("[초기화] WIPE_TARGET=1 — 대상 테이블 데이터 전부 삭제함.")

    # 3) 데이터 복사 (부모 → 자식 순서라 FK 위반 없음)
    total = 0
    for table in tables:
        with src.connect() as sconn:
            rows = [dict(r._mapping) for r in sconn.execute(table.select())]
        if not rows:
            print(f"  - {table.name}: 0건 (건너뜀)")
            continue
        with tgt.begin() as tconn:
            tconn.execute(table.insert(), rows)
        total += len(rows)
        print(f"  - {table.name}: {len(rows)}건 복사")
    print(f"[복사] 총 {total}건 이관 완료.")

    # 4) Postgres 시퀀스 재설정 — 명시적 id 삽입 후 시퀀스가 안 올라가면
    #    다음 INSERT에서 중복 PK 오류가 나므로 각 테이블 시퀀스를 max(id)로 맞춘다.
    if tgt.dialect.name == "postgresql":
        fixed = 0
        with tgt.begin() as conn:
            for table in tables:
                for col in table.primary_key.columns:
                    seq = conn.execute(
                        text("SELECT pg_get_serial_sequence(:t, :c)"),
                        {"t": table.name, "c": col.name},
                    ).scalar()
                    if not seq:
                        continue
                    conn.execute(
                        text(
                            f"SELECT setval('{seq}', "
                            f"GREATEST(COALESCE((SELECT MAX({col.name}) FROM {table.name}), 1), 1))"
                        )
                    )
                    fixed += 1
        print(f"[시퀀스] 자동증가 시퀀스 {fixed}개 재설정 완료.")

    print("\n✅ Neon 이관이 끝났습니다. 이제 서버의 DATABASE_URL을 대상(Neon) 주소로 바꾸면 됩니다.")


if __name__ == "__main__":
    main()
