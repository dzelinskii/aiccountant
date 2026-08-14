import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.imports.models import Import


def add_import(db: AsyncSession, imp: Import) -> None:
    db.add(imp)


async def get_import(
    db: AsyncSession, workspace_id: uuid.UUID, import_id: uuid.UUID
) -> Import | None:
    result: Import | None = await db.scalar(
        select(Import).where(Import.id == import_id, Import.workspace_id == workspace_id)
    )
    return result


async def get_import_any_workspace(db: AsyncSession, import_id: uuid.UUID) -> Import | None:
    """Для фоновой задачи: workspace берём из самой записи, а не из запроса."""
    result: Import | None = await db.scalar(select(Import).where(Import.id == import_id))
    return result
