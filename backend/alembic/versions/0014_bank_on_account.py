"""Банк у счёта, отпечаток счёта банка и увиденные счета"""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0014"
down_revision = "0013"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # существующие счета остаются без банка: это законное состояние (наличные,
    # банк без плагина), и поведение задним числом не меняется
    op.add_column("accounts", sa.Column("bank_code", sa.String(20), nullable=True))
    op.add_column("accounts", sa.Column("bank_account_fingerprint", sa.String(64), nullable=True))
    # один счёт банка — один счёт приложения. Частичный индекс: счетов без
    # отпечатка сколько угодно, и NULL уникальности не мешает
    op.create_index(
        "uq_accounts_bank_fingerprint",
        "accounts",
        ["workspace_id", "bank_account_fingerprint"],
        unique=True,
        postgresql_where=sa.text("bank_account_fingerprint IS NOT NULL"),
    )
    op.create_check_constraint(
        op.f("ck_accounts_bank_for_fingerprint"),
        "accounts",
        "bank_account_fingerprint IS NULL OR bank_code IS NOT NULL",
    )

    # счета банка, которых в приложении нет. Отдельная таблица, а не строки в
    # accounts: счёт приложения попал бы в остатки, в дашборд и в выбор счёта
    # при импорте, хотя человек его не заводил
    op.create_table(
        "discovered_accounts",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("workspace_id", sa.Uuid(), nullable=False),
        sa.Column("bank_code", sa.String(20), nullable=False),
        sa.Column("fingerprint", sa.String(64), nullable=False),
        sa.Column("name", sa.String(200), nullable=False),
        # валюта необязательна: плагин её не всегда распознаёт, и это не повод
        # скрывать счёт от человека
        sa.Column("currency", sa.String(3), nullable=True),
        sa.Column("balance", sa.Numeric(20, 4), nullable=True),
        sa.Column("card_masks", postgresql.JSONB(), nullable=False, server_default=sa.text("'[]'")),
        sa.Column(
            "seen_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.ForeignKeyConstraint(
            ["workspace_id"],
            ["workspaces.id"],
            name=op.f("fk_discovered_accounts_workspace_id_workspaces"),
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_discovered_accounts")),
    )
    op.create_index(
        "uq_discovered_accounts_fingerprint",
        "discovered_accounts",
        ["workspace_id", "fingerprint"],
        unique=True,
    )


def downgrade() -> None:
    op.drop_table("discovered_accounts")
    op.drop_constraint(op.f("ck_accounts_bank_for_fingerprint"), "accounts", type_="check")
    op.drop_index("uq_accounts_bank_fingerprint", table_name="accounts")
    op.drop_column("accounts", "bank_account_fingerprint")
    op.drop_column("accounts", "bank_code")
