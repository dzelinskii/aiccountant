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


async def test_migrations_create_imports_and_dedup(database_url: str) -> None:
    engine = create_async_engine(database_url)
    async with engine.connect() as conn:
        assert (await conn.execute(text("SELECT to_regclass('imports')"))).scalar() == "imports"
        cols = await conn.execute(
            text(
                "SELECT column_name FROM information_schema.columns "
                "WHERE table_name = 'transactions' "
                "AND column_name IN ('external_id', 'import_id')"
            )
        )
        assert {r[0] for r in cols} == {"external_id", "import_id"}
    await engine.dispose()


async def test_migrations_add_categorization_columns(database_url: str) -> None:
    engine = create_async_engine(database_url)
    async with engine.connect() as conn:
        cols = await conn.execute(
            text(
                "SELECT column_name FROM information_schema.columns "
                "WHERE table_name = 'transactions' "
                "AND column_name IN ('category_confirmed', 'category_confidence', "
                "'suggested_category_id')"
            )
        )
        assert {r[0] for r in cols} == {
            "category_confirmed",
            "category_confidence",
            "suggested_category_id",
        }
    await engine.dispose()


async def test_migrations_add_import_async_columns(database_url: str) -> None:
    engine = create_async_engine(database_url)
    async with engine.connect() as conn:
        rows = await conn.execute(
            text("SELECT column_name FROM information_schema.columns WHERE table_name = 'imports'")
        )
        columns = {name for (name,) in rows.all()}
    await engine.dispose()
    assert {"parser", "parsed_payload", "error", "raw_text"} <= columns


async def test_migrations_add_operation_kind_columns(database_url: str) -> None:
    engine = create_async_engine(database_url)
    async with engine.connect() as conn:
        rows = await conn.execute(
            text(
                "SELECT column_name, is_nullable FROM information_schema.columns "
                "WHERE table_name = 'transactions' "
                "AND column_name IN ('operation_kind', 'spending_override')"
            )
        )
        columns = {name: nullable for name, nullable in rows.all()}
    await engine.dispose()
    # на ненулевом виде держится правило участия в статистике: NULL не попадает
    # в notin_(NON_SPENDING_KINDS), и такие строки молча выпали бы из расходов.
    # spending_override, наоборот, обязан быть nullable — NULL это «человек не решал»
    assert columns == {"operation_kind": "NO", "spending_override": "YES"}


async def test_migrations_create_api_tokens(database_url: str) -> None:
    engine = create_async_engine(database_url)
    async with engine.connect() as conn:
        rows = await conn.execute(
            text(
                "SELECT column_name FROM information_schema.columns WHERE table_name = 'api_tokens'"
            )
        )
        columns = {name for (name,) in rows.all()}
    await engine.dispose()
    assert {"id", "workspace_id", "name", "token_hash", "revoked_at"} <= columns
