"""Вид операции и переопределение «считать тратой»"""

import sqlalchemy as sa

from alembic import op

revision = "0009"
down_revision = "0008"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # существующие строки получают unknown: остаются тратами, поведение
    # задним числом не меняется
    op.add_column(
        "transactions",
        sa.Column(
            "operation_kind",
            sa.String(20),
            nullable=False,
            server_default=sa.text("'unknown'"),
        ),
    )
    op.add_column("transactions", sa.Column("spending_override", sa.Boolean(), nullable=True))


def downgrade() -> None:
    op.drop_column("transactions", "spending_override")
    op.drop_column("transactions", "operation_kind")
