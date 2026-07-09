"""recurring_rules.category_id становится опциональным"""

import sqlalchemy as sa

from alembic import op

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.alter_column("recurring_rules", "category_id", existing_type=sa.Uuid(), nullable=True)


def downgrade() -> None:
    op.alter_column("recurring_rules", "category_id", existing_type=sa.Uuid(), nullable=False)
