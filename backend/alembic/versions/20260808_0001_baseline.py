"""전체 스키마 베이스라인 — Base.metadata를 단일 진실로 삼는 새 루트

Revision ID: 0001_baseline
Revises:
Create Date: 2026-08-08

왜 다시 만들었나
----------------
예전 체인은 루트 리비전이 어떤 마이그레이션도 만들지 않는 employees 테이블을 FK로
참조해 신규 DB에서 upgrade가 아예 불가능했고, 전체 테이블의 9할이 마이그레이션 없이
create_all + main.py 자가치유로만 만들어졌다. 즉 '마이그레이션 체계'가 실제로는
존재하지 않았다. 그래서 깨진 체인을 걷어내고, 모델 메타데이터 전체를 checkfirst로
생성하는 이 베이스라인 하나에서 다시 시작한다.

- 신규 DB: 이 리비전 하나로 전체 스키마가 생긴다 (제약·인덱스는 모델 __table_args__).
- 기존 운영 DB: 테이블이 이미 있으므로 checkfirst가 전부 건너뛴다 — 실질 no-op이며
  alembic_version만 채워진다. 이후 스키마 변경은 autogenerate 리비전으로 쌓는다.
"""
from typing import Sequence, Union

from alembic import op

revision: str = "0001_baseline"
down_revision: Union[str, Sequence[str], None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    import app.models  # noqa: F401 — 모든 모델을 Base.metadata에 등록
    from app.core.database import Base

    Base.metadata.create_all(bind=op.get_bind(), checkfirst=True)


def downgrade() -> None:
    # 베이스라인은 되돌릴 대상이 없다 — 전체 스키마 삭제는 마이그레이션으로 하지 않는다.
    raise NotImplementedError("베이스라인은 downgrade를 지원하지 않습니다.")
