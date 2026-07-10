import asyncio
import uuid

import structlog

from app.ai.client import build_llm_client
from app.core.celery_app import celery_app
from app.core.db import session_factory
from app.core.settings import get_settings
from app.ledger import categorization

logger = structlog.get_logger()


# decorator без типов из celery (ignore_missing_imports) → помечаем явно
@celery_app.task(name="ledger.categorize_workspace")  # type: ignore[untyped-decorator]
def categorize_workspace(workspace_id: str) -> int:
    """Тонкая обёртка: доменная логика — в categorization."""
    return asyncio.run(_run(uuid.UUID(workspace_id)))


async def _run(workspace_id: uuid.UUID) -> int:
    settings = get_settings()
    llm = build_llm_client()
    logger.info("categorize_workspace_started", workspace_id=str(workspace_id))
    async with session_factory() as db:
        processed = await categorization.categorize_uncategorized(
            db,
            workspace_id,
            llm,
            threshold=settings.categorize_confidence_threshold,
            fewshot_limit=settings.categorize_fewshot_limit,
        )
    logger.info("categorize_workspace_done", workspace_id=str(workspace_id), processed=processed)
    return processed


def enqueue_categorize(workspace_id: uuid.UUID) -> None:
    """Поставить фоновую категоризацию workspace в очередь Celery."""
    categorize_workspace.delay(str(workspace_id))
