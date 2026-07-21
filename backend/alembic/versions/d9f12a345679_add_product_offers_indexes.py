# c:\Users\USER\Documents\본 프로젝트\SimpleM\backend\alembic\versions\d9f12a345679_add_product_offers_indexes.py
"""add_product_offers_indexes

Revision ID: d9f12a345679
Revises: c8f12a345678
Create Date: 2026-07-21 14:40:00.000000

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'd9f12a345679'
down_revision = 'c8f12a345678'
branch_labels = None
depends_on = None


def upgrade():
    # [한글 주석] product_offers 테이블 조회 최적화를 위한 인덱스 생성
    op.create_index('ix_product_offers_price_stock', 'product_offers', ['price', 'in_stock'], unique=False)
    op.create_index('ix_product_offers_review_rating', 'product_offers', ['review_count', 'rating'], unique=False)
    op.create_index('ix_product_offers_bean_updated', 'product_offers', ['bean_id', 'updated_at'], unique=False)


def downgrade():
    # [한글 주석] 인덱스 삭제
    op.drop_index('ix_product_offers_bean_updated', table_name='product_offers')
    op.drop_index('ix_product_offers_review_rating', table_name='product_offers')
    op.drop_index('ix_product_offers_price_stock', table_name='product_offers')
