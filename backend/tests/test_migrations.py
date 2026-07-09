from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine


async def test_migrations_create_identity_tables(database_url: str) -> None:
    engine = create_async_engine(database_url)
    async with engine.connect() as conn:
        result = await conn.execute(
            text(
                "SELECT table_name FROM information_schema.tables "
                "WHERE table_schema = 'public' ORDER BY table_name"
            )
        )
        tables = {row[0] for row in result}
    await engine.dispose()
    assert {"users", "workspaces", "memberships"} <= tables


async def test_migrations_create_ledger_tables(database_url: str) -> None:
    engine = create_async_engine(database_url)
    async with engine.connect() as conn:
        for table in ("accounts", "categories", "transactions"):
            result = await conn.execute(text("SELECT to_regclass(:name)"), {"name": table})
            assert result.scalar() == table
    await engine.dispose()


async def test_migrations_create_recurring_tables(database_url: str) -> None:
    engine = create_async_engine(database_url)
    async with engine.connect() as conn:
        for table in ("recurring_rules", "recurring_occurrences"):
            result = await conn.execute(text("SELECT to_regclass(:name)"), {"name": table})
            assert result.scalar() == table
    await engine.dispose()


async def test_recurring_category_is_nullable(database_url: str) -> None:
    engine = create_async_engine(database_url)
    async with engine.connect() as conn:
        result = await conn.execute(
            text(
                "SELECT is_nullable FROM information_schema.columns "
                "WHERE table_name = 'recurring_rules' AND column_name = 'category_id'"
            )
        )
        assert result.scalar() == "YES"
    await engine.dispose()
