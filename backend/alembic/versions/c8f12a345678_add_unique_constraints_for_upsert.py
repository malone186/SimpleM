"""Add unique constraints for product_offers and bean_reviews for idempotent upsert

Revision ID: c8f12a345678
Revises: b8d9921e65f3
Create Date: 2026-07-21 13:40:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'c8f12a345678'
down_revision: Union[str, Sequence[str], None] = 'b8d9921e65f3'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    # [한글 주석] 1. product_offers 테이블에 (bean_id, source_site) 복합 멱등 유니크 제약 조건 추가
    op.create_unique_constraint(
        'uq_product_offers_bean_source',
        'product_offers',
        ['bean_id', 'source_site']
    )

    # [한글 주석] 2. bean_reviews 테이블에 (source_url) 멱등 유니크 제약 조건 추가 (null 값 예외 처리)
    op.create_unique_constraint(
        'uq_bean_reviews_source_url',
        'bean_reviews',
        ['source_url']
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_constraint('uq_bean_reviews_source_url', 'bean_reviews', type_='unique')
    op.drop_constraint('uq_product_offers_bean_source', 'product_offers', type_='unique')
