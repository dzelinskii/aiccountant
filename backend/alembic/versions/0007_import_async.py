"""Асинхронный импорт: parser/parsed_payload/error/raw_text в imports"""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0007"
down_revision = "0006"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("imports", sa.Column("parser", sa.String(30), nullable=True))
    op.add_column(
        "imports",
        sa.Column("parsed_payload", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    )
    op.add_column("imports", sa.Column("error", sa.String(500), nullable=True))
    op.add_column("imports", sa.Column("raw_text", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("imports", "raw_text")
    op.drop_column("imports", "error")
    op.drop_column("imports", "parsed_payload")
    op.drop_column("imports", "parser")
