import uuid
from datetime import datetime

from sqlalchemy import select, update
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


async def fail_stuck(db: AsyncSession, older_than: datetime, message: str) -> list[uuid.UUID]:
    """Пометить зависшие разборы failed одним UPDATE: условие перепроверяется под
    блокировкой строки, поэтому только что завершившийся разбор (воркер успел
    закоммитить ready между выборкой и обновлением) не будет затёрт задним числом.
    Заодно не тянем raw_text (PII) в память воркера. Для фоновой задачи — без
    фильтра по workspace, охват намеренно кросс-workspace."""
    stmt = (
        update(Import)
        .where(Import.status == "processing", Import.created_at < older_than)
        .values(status="failed", error=message, raw_text=None)
        .returning(Import.id)
    )
    rows = await db.execute(stmt)
    return [row_id for (row_id,) in rows.all()]
