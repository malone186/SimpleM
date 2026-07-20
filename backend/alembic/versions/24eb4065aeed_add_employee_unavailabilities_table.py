"""Add employee_unavailabilities table

Revision ID: 24eb4065aeed
Revises: 5f74cb88c050
Create Date: 2026-07-20 14:09:20.594175

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '24eb4065aeed'
down_revision: Union[str, Sequence[str], None] = '5f74cb88c050'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    # [한글 주석] 공용 DB에 신규 employee_unavailabilities 테이블만 안전하게 생성합니다.
    op.create_table('employee_unavailabilities',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('employee_id', sa.Integer(), nullable=False),
        sa.Column('unavailability_type', sa.String(length=30), nullable=False),
        sa.Column('day_of_week', sa.Integer(), nullable=True),
        sa.Column('specific_date', sa.String(length=10), nullable=True),
        sa.Column('start_hour', sa.Integer(), nullable=False),
        sa.Column('end_hour', sa.Integer(), nullable=False),
        sa.Column('restriction_level', sa.String(length=10), nullable=False),
        sa.Column('reason', sa.String(length=255), nullable=True),
        sa.Column('created_at', sa.DateTime(), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
        sa.ForeignKeyConstraint(['employee_id'], ['employees.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_employee_unavailabilities_id'), 'employee_unavailabilities', ['id'], unique=False)


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index(op.f('ix_employee_unavailabilities_id'), table_name='employee_unavailabilities')
    op.drop_table('employee_unavailabilities')
