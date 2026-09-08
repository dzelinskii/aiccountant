"""Отметка подсказки банка на категории"""

import sqlalchemy as sa

from alembic import op

revision = "0012"
down_revision = "0011"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("categories", sa.Column("hint", sa.String(30), nullable=True))
    # одна подсказка — одна категория внутри workspace: иначе разрешение
    # подсказки перестало бы быть однозначным. NULL уникальности не мешает,
    # так что категорий без отметки может быть сколько угодно
    op.create_index(
        "ix_categories_workspace_hint",
        "categories",
        ["workspace_id", "hint"],
        unique=True,
    )


def downgrade() -> None:
    op.drop_index("ix_categories_workspace_hint", table_name="categories")
    op.drop_column("categories", "hint")
