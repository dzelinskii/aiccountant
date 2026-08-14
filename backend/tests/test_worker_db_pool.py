"""Прод-баг: Celery-воркер гоняет каждую задачу через отдельный asyncio.run — event
loop закрывается по завершении задачи, а обычный пул (как у app.core.db.engine)
продолжает хранить соединение, привязанное к уже закрытому циклу. На втором запуске
это соединение мертво (AttributeError: 'NoneType' object has no attribute 'send'),
pool_pre_ping не спасает, так как это не сетевой обрыв. worker_engine/worker_session_factory
используют NullPool именно поэтому — соединение живёт ровно одну задачу, не переживает
закрытие цикла."""

import asyncio

from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool


def test_worker_engine_has_no_pool() -> None:
    """Пул держал бы соединения от закрытого event loop: каждый второй запуск задачи падал."""
    from app.core.db import worker_engine

    assert isinstance(worker_engine.pool, NullPool)


def test_background_tasks_use_worker_session_factory() -> None:
    """Задачи обязаны ходить в БД через беспуловую фабрику, а не через API-шную."""
    from app.core.db import worker_session_factory
    from app.imports import tasks as imports_tasks
    from app.ledger import tasks as ledger_tasks
    from app.recurring import tasks as recurring_tasks

    for module in (imports_tasks, ledger_tasks, recurring_tasks):
        assert getattr(module, "worker_session_factory", None) is worker_session_factory, (
            module.__name__
        )


def test_worker_engine_survives_repeated_asyncio_run(database_url: str) -> None:
    """Поведенческое дополнение к двум проверкам выше: движок на URL тестового
    контейнера (не настройках, чтобы реально бить в Postgres) переживает два
    независимых asyncio.run подряд, как это происходит в реальном воркере."""
    engine = create_async_engine(database_url, poolclass=NullPool)
    factory = async_sessionmaker(engine, expire_on_commit=False)

    async def _select_one() -> int:
        async with factory() as session:
            result = await session.execute(text("SELECT 1"))
            return int(result.scalar_one())

    # каждый asyncio.run — свой event loop, как для отдельной Celery-задачи
    first = asyncio.run(_select_one())
    second = asyncio.run(_select_one())

    assert first == 1
    assert second == 1

    asyncio.run(engine.dispose())
