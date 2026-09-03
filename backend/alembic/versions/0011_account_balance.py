"""Остаток счёта от источника, поправка к сумме операций и метки карт"""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0011"
down_revision = "0010"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("accounts", sa.Column("reported_balance", sa.Numeric(20, 4), nullable=True))
    op.add_column("accounts", sa.Column("reported_at", sa.DateTime(timezone=True), nullable=True))
    # существующие счета продолжают показывать сумму операций: поправка нулевая
    op.add_column(
        "accounts",
        sa.Column(
            "balance_adjustment",
            sa.Numeric(20, 4),
            nullable=False,
            server_default=sa.text("0"),
        ),
    )
    op.add_column(
        "accounts",
        sa.Column(
            "card_masks",
            postgresql.JSONB(),
            nullable=False,
            server_default=sa.text("'[]'"),
        ),
    )


def downgrade() -> None:
    op.drop_column("accounts", "card_masks")
    op.drop_column("accounts", "balance_adjustment")
    op.drop_column("accounts", "reported_at")
    op.drop_column("accounts", "reported_balance")
