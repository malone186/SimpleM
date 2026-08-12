"""ocr_documents.truncated 추가 — 응답 절단 표시를 다시 불러와도 유지

Revision ID: 0002_ocr_truncated
Revises: 0001_baseline
Create Date: 2026-08-12

왜 필요한가
----------
모델 응답 꼬리가 잘리면 마지막 완전한 품목까지 살려 복구하는데, 잘린 뒤쪽에
합계·공급가액이 있어서 전부 None이 된다. 그러면 총액 대조가 비교 기준을 못 찾아
통째로 건너뛰므로, 품목이 빠진 문서가 아무 경고 없이 정상으로 보인다.
그래서 result.truncated 표식을 만들어 검증에서 경고를 내게 했는데, 저장할 컬럼이
없어 목록을 다시 부르면 표식이 사라졌다 (경고도 함께 사라진다).
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0002_ocr_truncated"
down_revision: Union[str, Sequence[str], None] = "0001_baseline"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 기존 행은 절단이 아니었던 것으로 본다 (server_default=false 뒤 기본값은 떼지 않는다 —
    # 예전 코드가 아직 도는 동안 INSERT가 이 컬럼을 안 채워도 NOT NULL을 지키게).
    op.add_column(
        "ocr_documents",
        sa.Column("truncated", sa.Boolean(), nullable=False, server_default=sa.false()),
    )


def downgrade() -> None:
    op.drop_column("ocr_documents", "truncated")
