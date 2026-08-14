import asyncio

from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool


def test_worker_engine_survives_repeated_asyncio_run(database_url: str) -> None:
    """Регресс на прод-баг: Celery-воркер гоняет каждую задачу через отдельный
    asyncio.run — event loop закрывается по завершении задачи, а обычный пул
    (как у app.core.db.engine) продолжает хранить соединение, привязанное к уже
    закрытому циклу. На втором запуске это соединение мертво (AttributeError:
    'NoneType' object has no attribute 'send'), pool_pre_ping не спасает, так как
    это не сетевой обрыв. worker_engine/worker_session_factory используют
    NullPool именно поэтому — соединение живёт ровно одну задачу, не переживает
    закрытие цикла. Движок здесь строится на URL тестового контейнера (fixture
    database_url), а не на настройках — чтобы тест реально бил в Postgres."""
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
