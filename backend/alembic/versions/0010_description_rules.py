"""Правила «описание операции → категория»"""

import sqlalchemy as sa

from alembic import op

revision = "0010"
down_revision = "0009"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "description_rules",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("workspace_id", sa.Uuid(), nullable=False),
        sa.Column("normalized_text", sa.String(300), nullable=False),
        sa.Column("category_id", sa.Uuid(), nullable=False),
        sa.Column("source", sa.String(20), nullable=False, server_default=sa.text("'manual'")),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.ForeignKeyConstraint(
            ["workspace_id"],
            ["workspaces.id"],
            name=op.f("fk_description_rules_workspace_id_workspaces"),
        ),
        # правило без категории бессмысленно: удалили категорию — удалилось правило
        sa.ForeignKeyConstraint(
            ["category_id"],
            ["categories.id"],
            name=op.f("fk_description_rules_category_id_categories"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_description_rules")),
        sa.UniqueConstraint(
            "workspace_id", "normalized_text", name=op.f("uq_description_rules_text")
        ),
    )


def downgrade() -> None:
    op.drop_table("description_rules")
