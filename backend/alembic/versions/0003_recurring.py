"""Таблицы recurring: recurring_rules, recurring_occurrences"""

import sqlalchemy as sa

from alembic import op

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "recurring_rules",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("workspace_id", sa.Uuid(), nullable=False),
        sa.Column("account_id", sa.Uuid(), nullable=False),
        sa.Column("category_id", sa.Uuid(), nullable=False),
        sa.Column("amount", sa.Numeric(20, 4), nullable=False),
        sa.Column("currency", sa.String(3), nullable=False),
        sa.Column("period", sa.String(10), nullable=False),
        sa.Column("interval", sa.Integer(), nullable=False),
        sa.Column("anchor_day", sa.Integer(), nullable=True),
        sa.Column("start_date", sa.Date(), nullable=False),
        sa.Column("next_run_at", sa.Date(), nullable=False),
        sa.Column("mode", sa.String(10), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False),
        sa.Column("end_date", sa.Date(), nullable=True),
        sa.Column("note", sa.String(1000), nullable=True),
        sa.Column("created_by", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.ForeignKeyConstraint(
            ["account_id"], ["accounts.id"], name=op.f("fk_recurring_rules_account_id_accounts")
        ),
        sa.ForeignKeyConstraint(
            ["category_id"],
            ["categories.id"],
            name=op.f("fk_recurring_rules_category_id_categories"),
        ),
        sa.ForeignKeyConstraint(
            ["created_by"], ["users.id"], name=op.f("fk_recurring_rules_created_by_users")
        ),
        sa.ForeignKeyConstraint(
            ["workspace_id"],
            ["workspaces.id"],
            name=op.f("fk_recurring_rules_workspace_id_workspaces"),
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_recurring_rules")),
    )
    op.create_index(
        "ix_recurring_rules_active_next", "recurring_rules", ["is_active", "next_run_at"]
    )
    op.create_table(
        "recurring_occurrences",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("workspace_id", sa.Uuid(), nullable=False),
        sa.Column("rule_id", sa.Uuid(), nullable=False),
        sa.Column("due_date", sa.Date(), nullable=False),
        sa.Column("amount", sa.Numeric(20, 4), nullable=False),
        sa.Column("status", sa.String(10), nullable=False),
        sa.Column("transaction_id", sa.Uuid(), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.ForeignKeyConstraint(
            ["rule_id"],
            ["recurring_rules.id"],
            name=op.f("fk_recurring_occurrences_rule_id_recurring_rules"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["transaction_id"],
            ["transactions.id"],
            name=op.f("fk_recurring_occurrences_transaction_id_transactions"),
        ),
        sa.ForeignKeyConstraint(
            ["workspace_id"],
            ["workspaces.id"],
            name=op.f("fk_recurring_occurrences_workspace_id_workspaces"),
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_recurring_occurrences")),
        sa.UniqueConstraint("rule_id", "due_date", name="uq_recurring_occurrences_rule_due"),
    )
    op.create_index(
        "ix_recurring_occurrences_workspace_status",
        "recurring_occurrences",
        ["workspace_id", "status"],
    )


def downgrade() -> None:
    op.drop_index("ix_recurring_occurrences_workspace_status", table_name="recurring_occurrences")
    op.drop_table("recurring_occurrences")
    op.drop_index("ix_recurring_rules_active_next", table_name="recurring_rules")
    op.drop_table("recurring_rules")
