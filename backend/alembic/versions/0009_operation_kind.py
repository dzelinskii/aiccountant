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
    # кроме строк перевода между своими счетами: вид у них известен и без
    # источника — по группе. Без этого они остались бы unknown, вернулись бы
    # в расходы задним числом, и правилу пришлось бы знать про группу отдельно
    op.execute(
        "UPDATE transactions SET operation_kind = 'transfer_self' "
        "WHERE transfer_group_id IS NOT NULL"
    )


def downgrade() -> None:
    op.drop_column("transactions", "spending_override")
    op.drop_column("transactions", "operation_kind")
