"""Контрагент: объединяет разные написания одного и того же"""

import sqlalchemy as sa

from alembic import op

revision = "0013"
down_revision = "0012"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "counterparties",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("workspace_id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("kind", sa.String(20), nullable=False),
        # категория необязательна: контрагент без неё — просто имя вместо
        # банковской строки, и это уже полезно
        sa.Column("category_id", sa.Uuid(), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.ForeignKeyConstraint(
            ["workspace_id"],
            ["workspaces.id"],
            name=op.f("fk_counterparties_workspace_id_workspaces"),
        ),
        # удалили категорию — контрагент остаётся, просто без категории
        sa.ForeignKeyConstraint(
            ["category_id"],
            ["categories.id"],
            name=op.f("fk_counterparties_category_id_categories"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_counterparties")),
    )
    op.create_index("ix_counterparties_workspace", "counterparties", ["workspace_id"])

    op.add_column("description_rules", sa.Column("counterparty_id", sa.Uuid(), nullable=True))
    # правило без цели бессмысленно: удалили контрагента — удалились его подписи
    op.create_foreign_key(
        op.f("fk_description_rules_counterparty_id_counterparties"),
        "description_rules",
        "counterparties",
        ["counterparty_id"],
        ["id"],
        ondelete="CASCADE",
    )
    # существующие правила ведут прямо в категорию, и такими остаются;
    # послабление нужно, чтобы появились правила, ведущие в контрагента
    op.alter_column("description_rules", "category_id", existing_type=sa.Uuid(), nullable=True)
    op.create_check_constraint(
        op.f("ck_description_rules_target"),
        "description_rules",
        "(category_id IS NULL) <> (counterparty_id IS NULL)",
    )


def downgrade() -> None:
    op.drop_constraint(op.f("ck_description_rules_target"), "description_rules", type_="check")
    # обратно в NOT NULL можно только выбросив правила, ведущие в контрагента:
    # категории у них нет, и подставить её неоткуда
    op.execute("DELETE FROM description_rules WHERE category_id IS NULL")
    op.alter_column("description_rules", "category_id", existing_type=sa.Uuid(), nullable=False)
    op.drop_constraint(
        op.f("fk_description_rules_counterparty_id_counterparties"),
        "description_rules",
        type_="foreignkey",
    )
    op.drop_column("description_rules", "counterparty_id")
    op.drop_index("ix_counterparties_workspace", table_name="counterparties")
    op.drop_table("counterparties")
