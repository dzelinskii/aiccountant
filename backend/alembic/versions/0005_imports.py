"""Таблица imports; поля дедупа external_id/import_id в transactions"""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "imports",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("workspace_id", sa.Uuid(), nullable=False),
        sa.Column("account_id", sa.Uuid(), nullable=False),
        sa.Column("file_name", sa.String(300), nullable=False),
        sa.Column("bank_profile", sa.String(30), nullable=False),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("stats", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("created_by", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.ForeignKeyConstraint(
            ["account_id"], ["accounts.id"], name=op.f("fk_imports_account_id_accounts")
        ),
        sa.ForeignKeyConstraint(
            ["created_by"], ["users.id"], name=op.f("fk_imports_created_by_users")
        ),
        sa.ForeignKeyConstraint(
            ["workspace_id"], ["workspaces.id"], name=op.f("fk_imports_workspace_id_workspaces")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_imports")),
    )
    op.add_column("transactions", sa.Column("external_id", sa.String(64), nullable=True))
    op.add_column("transactions", sa.Column("import_id", sa.Uuid(), nullable=True))
    op.create_index(
        "uq_transactions_account_external",
        "transactions",
        ["account_id", "external_id"],
        unique=True,
        postgresql_where=sa.text("external_id IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index(
        "uq_transactions_account_external",
        table_name="transactions",
        postgresql_where=sa.text("external_id IS NOT NULL"),
    )
    op.drop_column("transactions", "import_id")
    op.drop_column("transactions", "external_id")
    op.drop_table("imports")
