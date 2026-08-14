import asyncio
import uuid
from datetime import UTC, datetime, timedelta

from app.ai.client import build_llm_client
from app.core.celery_app import celery_app
from app.core.db import session_factory
from app.core.settings import get_settings
from app.imports import service
from app.imports.llm_parser import LLMStatementParser
from app.imports.parser import ParsedStatement, TBankStatementParser
from app.imports.routing import route_statement

# детерминированные парсеры банков в порядке проверки; новый банк = ещё один элемент
DETERMINISTIC_PARSERS = (TBankStatementParser(),)
# запас больше самого долгого разумного LLM-разбора
STUCK_AFTER = timedelta(minutes=15)


async def parse_lines(lines: list[str]) -> tuple[ParsedStatement, str]:
    """Реестр форматов: сначала детерминированные парсеры, затем LLM-фолбэк."""
    settings = get_settings()
    llm = LLMStatementParser(
        build_llm_client(settings.llm_model_parse), settings.import_max_text_chars
    )
    return await route_statement(lines, list(DETERMINISTIC_PARSERS), llm)


# decorator без типов из celery (ignore_missing_imports) → помечаем явно
@celery_app.task(name="imports.parse_statement_job")  # type: ignore[untyped-decorator]
def parse_statement_job(import_id: str) -> None:
    """Тонкая обёртка: доменная логика — в service.run_parse."""
    asyncio.run(_run(uuid.UUID(import_id)))


async def _run(import_id: uuid.UUID) -> None:
    async with session_factory() as db:
        await service.run_parse(db, import_id, parse=parse_lines)


@celery_app.task(name="imports.reap_stuck")  # type: ignore[untyped-decorator]
def reap_stuck_imports() -> int:
    """Добить разборы, зависшие из-за смерти воркера или потери сообщения."""
    return asyncio.run(_reap())


async def _reap() -> int:
    async with session_factory() as db:
        return await service.fail_stuck_imports(db, datetime.now(UTC) - STUCK_AFTER)


def enqueue_parse(import_id: uuid.UUID) -> None:
    """Поставить разбор выписки в очередь Celery."""
    parse_statement_job.delay(str(import_id))
