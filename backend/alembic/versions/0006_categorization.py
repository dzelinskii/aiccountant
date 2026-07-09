"""Поля AI-категоризации в transactions"""

import sqlalchemy as sa

from alembic import op

revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "transactions",
        sa.Column(
            "category_confirmed",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
    )
    op.add_column(
        "transactions",
        sa.Column("category_confidence", sa.Numeric(4, 3), nullable=True),
    )
    op.add_column(
        "transactions",
        sa.Column("suggested_category_id", sa.Uuid(), nullable=True),
    )
    op.create_foreign_key(
        op.f("fk_transactions_suggested_category_id_categories"),
        "transactions",
        "categories",
        ["suggested_category_id"],
        ["id"],
    )


def downgrade() -> None:
    op.drop_constraint(
        op.f("fk_transactions_suggested_category_id_categories"),
        "transactions",
        type_="foreignkey",
    )
    op.drop_column("transactions", "suggested_category_id")
    op.drop_column("transactions", "category_confidence")
    op.drop_column("transactions", "category_confirmed")
