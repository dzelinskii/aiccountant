import asyncio
from datetime import UTC, datetime

from app.core.celery_app import celery_app
from app.core.db import session_factory
from app.recurring import service


# decorator без типов из celery (ignore_missing_imports) → помечаем явно
@celery_app.task(name="recurring.scan_due")  # type: ignore[untyped-decorator]
def scan_due() -> int:
    """Тонкая обёртка: beat зовёт задачу, доменная логика — в service."""
    return asyncio.run(_scan())


async def _scan() -> int:
    async with session_factory() as db:
        today = datetime.now(UTC).date()
        return await service.process_due_rules(db, today)
