"""Add bean_reviews and product_offers tables and bean summary columns

Revision ID: b8d9921e65f3
Revises: a7c8910d54b2
Create Date: 2026-07-21 11:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'b8d9921e65f3'
down_revision: Union[str, Sequence[str], None] = 'a7c8910d54b2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    # [한글 주석] 1. 기존 roastery_beans 테이블에 집계 및 속성 컬럼을 안전하게 추가합니다.
    op.add_column('roastery_beans', sa.Column('avg_rating', sa.Float(), server_default='0.0', nullable=False))
    op.add_column('roastery_beans', sa.Column('review_count', sa.Integer(), server_default='0', nullable=False))
    op.add_column('roastery_beans', sa.Column('positive_ratio', sa.Float(), server_default='0.0', nullable=False))
    op.add_column('roastery_beans', sa.Column('top_keywords', sa.JSON(), nullable=True))

    # [한글 주석] 2. 외부 원두 리뷰 수집 및 감성 분석 데이터 보관용 신규 bean_reviews 테이블 생성
    op.create_table(
        'bean_reviews',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('bean_id', sa.Integer(), sa.ForeignKey('roastery_beans.id', ondelete='CASCADE'), nullable=False),
        sa.Column('source_site', sa.String(length=50), server_default='Naver Shopping', nullable=False),
        sa.Column('source_url', sa.Text(), nullable=True),
        sa.Column('rating', sa.Float(), server_default='5.0', nullable=False),
        sa.Column('content', sa.Text(), nullable=False),
        sa.Column('sentiment', sa.String(length=20), server_default='neutral', nullable=False),
        sa.Column('keywords', sa.JSON(), nullable=True),
        sa.Column('helpful_count', sa.Integer(), server_default='0', nullable=False),
        sa.Column('collected_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
        sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_bean_reviews_id'), 'bean_reviews', ['id'], unique=False)
    op.create_index(op.f('ix_bean_reviews_bean_id'), 'bean_reviews', ['bean_id'], unique=False)

    # [한글 주석] 3. 외부 판매처별 실시간 원두 가격 및 재고 오퍼 보관용 신규 product_offers 테이블 생성
    op.create_table(
        'product_offers',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('bean_id', sa.Integer(), sa.ForeignKey('roastery_beans.id', ondelete='CASCADE'), nullable=False),
        sa.Column('source_site', sa.String(length=50), nullable=False),
        sa.Column('product_url', sa.Text(), nullable=False),
        sa.Column('price', sa.Integer(), server_default='0', nullable=False),
        sa.Column('in_stock', sa.Boolean(), server_default='1', nullable=False),
        sa.Column('rating', sa.Float(), nullable=True),
        sa.Column('review_count', sa.Integer(), server_default='0', nullable=True),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
        sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_product_offers_id'), 'product_offers', ['id'], unique=False)
    op.create_index(op.f('ix_product_offers_bean_id'), 'product_offers', ['bean_id'], unique=False)


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index(op.f('ix_product_offers_bean_id'), table_name='product_offers')
    op.drop_index(op.f('ix_product_offers_id'), table_name='product_offers')
    op.drop_table('product_offers')

    op.drop_index(op.f('ix_bean_reviews_bean_id'), table_name='bean_reviews')
    op.drop_index(op.f('ix_bean_reviews_id'), table_name='bean_reviews')
    op.drop_table('bean_reviews')

    op.drop_column('roastery_beans', 'top_keywords')
    op.drop_column('roastery_beans', 'positive_ratio')
    op.drop_column('roastery_beans', 'review_count')
    op.drop_column('roastery_beans', 'avg_rating')
