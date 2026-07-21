"""Add law_articles table for Law RAG system

Revision ID: a7c8910d54b2
Revises: 24eb4065aeed
Create Date: 2026-07-21 10:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'a7c8910d54b2'
down_revision: Union[str, Sequence[str], None] = '24eb4065aeed'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    # [한글 주석] 공용 DB에 영향이 없도록 신규 law_articles 테이블만 추가합니다.
    op.create_table(
        'law_articles',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('law_name', sa.String(length=100), nullable=False),
        sa.Column('article_no', sa.String(length=50), nullable=False),
        sa.Column('category', sa.String(length=50), nullable=False),
        sa.Column('content', sa.Text(), nullable=False),
        sa.Column('summary', sa.Text(), nullable=True),
        sa.Column('source', sa.String(length=255), nullable=False),
        sa.Column('effective_date', sa.String(length=20), nullable=False, server_default='2026-01-01'),
        sa.Column('content_hash', sa.String(length=64), nullable=False),
        sa.Column('created_at', sa.DateTime(), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
        sa.Column('updated_at', sa.DateTime(), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
        sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_law_articles_id'), 'law_articles', ['id'], unique=False)
    op.create_index(op.f('ix_law_articles_law_name'), 'law_articles', ['law_name'], unique=False)
    op.create_index(op.f('ix_law_articles_article_no'), 'law_articles', ['article_no'], unique=False)
    op.create_index(op.f('ix_law_articles_category'), 'law_articles', ['category'], unique=False)
    op.create_index(op.f('ix_law_articles_content_hash'), 'law_articles', ['content_hash'], unique=False)


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index(op.f('ix_law_articles_content_hash'), table_name='law_articles')
    op.drop_index(op.f('ix_law_articles_category'), table_name='law_articles')
    op.drop_index(op.f('ix_law_articles_article_no'), table_name='law_articles')
    op.drop_index(op.f('ix_law_articles_law_name'), table_name='law_articles')
    op.drop_index(op.f('ix_law_articles_id'), table_name='law_articles')
    op.drop_table('law_articles')
