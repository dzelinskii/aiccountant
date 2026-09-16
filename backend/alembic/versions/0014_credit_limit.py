"""Кредитный лимит счёта: история наблюдений"""

import sqlalchemy as sa

from alembic import op

revision = "0014"
down_revision = "0013"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "credit_limit_observations",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("workspace_id", sa.Uuid(), nullable=False),
        sa.Column("account_id", sa.Uuid(), nullable=False),
        sa.Column("value", sa.Numeric(20, 4), nullable=False),
        # когда значение замечено впервые — по нему читается история изменений
        sa.Column("observed_at", sa.DateTime(timezone=True), nullable=False),
        # когда банк называл его в последний раз — по нему проверяется свежесть
        sa.Column("confirmed_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(
            ["workspace_id"],
            ["workspaces.id"],
            name=op.f("fk_credit_limit_observations_workspace_id_workspaces"),
        ),
        # счёт удалили — его наблюдения смысла не имеют
        sa.ForeignKeyConstraint(
            ["account_id"],
            ["accounts.id"],
            name=op.f("fk_credit_limit_observations_account_id_accounts"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_credit_limit_observations")),
    )
    op.create_index(
        "ix_credit_limit_observations_latest",
        "credit_limit_observations",
        ["workspace_id", "account_id", "confirmed_at"],
    )


def downgrade() -> None:
    op.drop_index("ix_credit_limit_observations_latest", table_name="credit_limit_observations")
    op.drop_table("credit_limit_observations")
