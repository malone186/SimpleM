# c:\Users\USER\Documents\본 프로젝트\SimpleM\backend\alembic\versions\e1f234567890_add_review_curation_columns.py
"""add review curation columns and curation_snapshot

Revision ID: e1f234567890
Revises: d9f12a345679
Create Date: 2026-07-21 15:50:00.000000

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'e1f234567890'
down_revision = 'd9f12a345679'
branch_labels = None
depends_on = None


def upgrade():
    # [한글 주석] bean_reviews 테이블에 큐레이션 속성 컬럼 및 processed 인덱스 플래그 추가
    op.add_column('bean_reviews', sa.Column('acidity', sa.Integer(), nullable=True))
    op.add_column('bean_reviews', sa.Column('body', sa.Integer(), nullable=True))
    op.add_column('bean_reviews', sa.Column('sweetness', sa.Integer(), nullable=True))
    op.add_column('bean_reviews', sa.Column('bitterness', sa.Integer(), nullable=True))
    
    op.add_column('bean_reviews', sa.Column('roast_level', sa.String(length=30), nullable=True))
    op.add_column('bean_reviews', sa.Column('process', sa.String(length=30), nullable=True))
    op.add_column('bean_reviews', sa.Column('origin', sa.String(length=30), nullable=True))
    op.add_column('bean_reviews', sa.Column('caffeine', sa.String(length=30), nullable=True))
    
    op.add_column('bean_reviews', sa.Column('evidence', sa.Text(), nullable=True))
    op.add_column('bean_reviews', sa.Column('processed', sa.Boolean(), server_default='false', nullable=False))
    
    op.create_index(op.f('ix_bean_reviews_processed'), 'bean_reviews', ['processed'], unique=False)

    # [한글 주석] roastery_beans 테이블에 큐레이션 스냅샷 캐시 컬럼 추가
    op.add_column('roastery_beans', sa.Column('curation_snapshot', sa.JSON(), nullable=True))


def downgrade():
    op.drop_column('roastery_beans', 'curation_snapshot')
    op.drop_index(op.f('ix_bean_reviews_processed'), table_name='bean_reviews')
    op.drop_column('bean_reviews', 'processed')
    op.drop_column('bean_reviews', 'evidence')
    op.drop_column('bean_reviews', 'caffeine')
    op.drop_column('bean_reviews', 'origin')
    op.drop_column('bean_reviews', 'process')
    op.drop_column('bean_reviews', 'roast_level')
    op.drop_column('bean_reviews', 'bitterness')
    op.drop_column('bean_reviews', 'sweetness')
    op.drop_column('bean_reviews', 'body')
    op.drop_column('bean_reviews', 'acidity')
