"""Neon 리전 이전 스크립트 — us-east-1 → 가까운 리전(싱가포르 등) 프로젝트로 전체 복사.

사용법:
  1) Neon 콘솔에서 새 프로젝트 생성 (Region: AWS Asia Pacific (Singapore) 권장)
  2) 새 프로젝트의 연결 문자열(postgresql://...sslmode=require)을 받아서:
       python db_migrate_neon.py "<새 DATABASE_URL>"
  3) 스크립트가 덤프 → 복원 → 테이블별 행 수 대조까지 마치면,
     backend/.env 와 GitHub Secret(GCP_ENV_YAML)의 DATABASE_URL을 새 URL로 교체 후 재배포.

원본 DB는 건드리지 않는다(읽기만) — 문제가 생기면 URL을 되돌리면 끝.
"""

import os
import subprocess
import sys
from pathlib import Path

PG_BIN = Path(r"C:\Program Files\PostgreSQL\18\bin")
BACKEND = Path(__file__).resolve().parent
DUMP_FILE = BACKEND / "neon_migration.dump"


def _old_url() -> str:
    for line in (BACKEND / ".env").read_text(encoding="utf-8").splitlines():
        if line.strip().startswith("DATABASE_URL="):
            return line.split("=", 1)[1].strip()
    raise SystemExit("backend/.env에서 DATABASE_URL을 찾지 못했습니다")


def _run(cmd: list[str]) -> None:
    print("$", " ".join(str(c) if "://" not in str(c) else "<connection-url>" for c in cmd))
    subprocess.run(cmd, check=True)


def _table_counts(url: str) -> dict[str, int]:
    import psycopg2

    conn = psycopg2.connect(url)
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename"
            )
            tables = [r[0] for r in cur.fetchall()]
            counts = {}
            for t in tables:
                cur.execute(f'SELECT count(*) FROM "{t}"')
                counts[t] = cur.fetchone()[0]
            return counts
    finally:
        conn.close()


def main() -> None:
    new_url = (sys.argv[1] if len(sys.argv) > 1 else os.getenv("NEW_DATABASE_URL", "")).strip()
    if not new_url.startswith("postgresql://"):
        raise SystemExit("사용법: python db_migrate_neon.py \"<새 DATABASE_URL>\"")
    old_url = _old_url()

    print("[1/4] 원본 덤프 (pg_dump -Fc)…")
    _run([str(PG_BIN / "pg_dump"), "-Fc", "--no-owner", "--no-privileges",
          "-f", str(DUMP_FILE), old_url])
    print(f"      덤프 완료: {DUMP_FILE} ({DUMP_FILE.stat().st_size // 1024} KB)")

    print("[2/4] 새 프로젝트로 복원 (pg_restore)…")
    _run([str(PG_BIN / "pg_restore"), "--no-owner", "--no-privileges",
          "--if-exists", "--clean", "-d", new_url, str(DUMP_FILE)])

    print("[3/4] 행 수 대조…")
    old_counts, new_counts = _table_counts(old_url), _table_counts(new_url)
    mismatch = [
        f"  {t}: 원본 {old_counts.get(t)} vs 새 DB {new_counts.get(t)}"
        for t in sorted(set(old_counts) | set(new_counts))
        if old_counts.get(t) != new_counts.get(t)
    ]
    if mismatch:
        print("!! 행 수 불일치 — 전환 중단, 아래 테이블 확인 필요:")
        print("\n".join(mismatch))
        raise SystemExit(1)
    total = sum(old_counts.values())
    print(f"      전 테이블({len(old_counts)}개) 행 수 일치 — 총 {total:,}행")

    print("[4/4] 남은 일:")
    print("  1. backend/.env의 DATABASE_URL을 새 URL로 교체 (기존 줄은 주석으로 보존 권장)")
    print("  2. GitHub → Settings → Secrets → GCP_ENV_YAML의 DATABASE_URL 교체")
    print("  3. git push(빈 커밋도 OK) 또는 Actions 수동 실행으로 재배포")
    print("  ※ 팀원들에게 새 DATABASE_URL 공지 (각자 backend/.env 교체)")


if __name__ == "__main__":
    main()
