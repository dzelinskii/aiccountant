import uuid

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

from app.identity.models import Workspace
from app.ledger.models import Account, Category, Counterparty, DescriptionRule, DiscoveredAccount


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


async def test_migrations_add_account_balance_columns(database_url: str) -> None:
    engine = create_async_engine(database_url)
    async with engine.connect() as conn:
        rows = await conn.execute(
            text(
                "SELECT column_name, is_nullable, column_default "
                "FROM information_schema.columns WHERE table_name = 'accounts' "
                "AND column_name IN ('reported_balance', 'reported_at', "
                "'balance_adjustment', 'card_masks')"
            )
        )
        columns = {name: (nullable, default) for name, nullable, default in rows.all()}
    await engine.dispose()
    # на умолчаниях держится обещание «счета, заведённые до этой миграции,
    # продолжают показывать сумму операций»: NULL в поправке отравил бы
    # сложение, а NULL в метках — список на экране
    assert columns["balance_adjustment"] == ("NO", "0")
    assert columns["card_masks"] == ("NO", "'[]'::jsonb")
    # а вот сообщённый остаток обязан быть nullable: пусто — источника нет,
    # и это не то же самое, что остаток, равный нулю
    assert columns["reported_balance"][0] == "YES"
    assert columns["reported_at"][0] == "YES"


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


async def test_migrations_add_category_hint(database_url: str) -> None:
    engine = create_async_engine(database_url)
    async with engine.connect() as conn:
        rows = await conn.execute(
            text(
                "SELECT is_nullable FROM information_schema.columns "
                "WHERE table_name = 'categories' AND column_name = 'hint'"
            )
        )
        nullable = rows.scalar()
        indexes = await conn.execute(
            text("SELECT indexdef FROM pg_indexes WHERE indexname = :name"),
            {"name": "ix_categories_workspace_hint"},
        )
        indexdef = indexes.scalar()
    await engine.dispose()
    # отметка обязана быть nullable: категорий без подсказки — большинство
    assert nullable == "YES"
    # уникальность именно по паре: одна подсказка — одна категория внутри
    # workspace, иначе разрешение подсказки перестаёт быть однозначным
    assert indexdef is not None
    assert "UNIQUE" in indexdef
    assert "workspace_id" in indexdef and "hint" in indexdef


async def test_migrations_add_counterparties(database_url: str) -> None:
    engine = create_async_engine(database_url)
    async with engine.connect() as conn:
        cols = await conn.execute(
            text(
                "SELECT column_name, is_nullable FROM information_schema.columns "
                "WHERE table_name = 'counterparties'"
            )
        )
        counterparty = {name: nullable for name, nullable in cols.all()}
        rule_cols = await conn.execute(
            text(
                "SELECT column_name, is_nullable FROM information_schema.columns "
                "WHERE table_name = 'description_rules' "
                "AND column_name IN ('category_id', 'counterparty_id')"
            )
        )
        rule = {name: nullable for name, nullable in rule_cols.all()}
        check = await conn.execute(
            text(
                "SELECT count(*) FROM pg_constraint "
                "WHERE conname = 'ck_description_rules_target' AND contype = 'c'"
            )
        )
        has_check = check.scalar()
    await engine.dispose()
    # категория у контрагента необязательна: он может быть просто именем
    assert counterparty["category_id"] == "YES"
    assert counterparty["name"] == "NO"
    assert counterparty["kind"] == "NO"
    # у правила обе цели необязательны по отдельности, а «ровно одна из двух»
    # держится ограничением — без него строка без обеих молча ничего не делала бы
    assert rule == {"category_id": "YES", "counterparty_id": "YES"}
    assert has_check == 1


async def test_rule_leads_to_exactly_one_target(db_session: AsyncSession) -> None:
    """Одного факта, что ограничение есть, мало: «хотя бы одна цель пуста» —
    такая же однострочная запись, и она пропускает правило вообще без целей.
    Проверяем обе границы: и обе цели сразу, и ни одной, отбиваются базой."""
    workspace = Workspace(name="Дом", type="personal")
    db_session.add(workspace)
    await db_session.flush()
    category = Category(workspace_id=workspace.id, name="Переводы", kind="expense")
    counterparty = Counterparty(workspace_id=workspace.id, name="Денис З.", kind="person")
    db_session.add_all([category, counterparty])
    await db_session.flush()

    def rule(
        key: str, category_id: uuid.UUID | None, counterparty_id: uuid.UUID | None
    ) -> DescriptionRule:
        return DescriptionRule(
            workspace_id=workspace.id,
            normalized_text=key,
            category_id=category_id,
            counterparty_id=counterparty_id,
        )

    # ровно одна цель — правило ведёт куда-то, и база его принимает
    async with db_session.begin_nested():
        db_session.add(rule("пятёрочка", category.id, None))
        db_session.add(rule("денис з.", None, counterparty.id))
        await db_session.flush()

    # обе сразу: непонятно, чья категория побеждает
    with pytest.raises(IntegrityError):
        async with db_session.begin_nested():
            db_session.add(rule("обе цели", category.id, counterparty.id))
            await db_session.flush()

    # ни одной: описание совпадёт, а категория не проставится — молчаливая дыра
    with pytest.raises(IntegrityError):
        async with db_session.begin_nested():
            db_session.add(rule("без целей", None, None))
            await db_session.flush()


async def test_migrations_add_bank_columns(database_url: str) -> None:
    engine = create_async_engine(database_url)
    async with engine.connect() as conn:
        rows = await conn.execute(
            text(
                "SELECT column_name, is_nullable FROM information_schema.columns "
                "WHERE table_name = 'accounts' "
                "AND column_name IN ('bank_code', 'bank_account_fingerprint')"
            )
        )
        columns = dict(rows.all())
    await engine.dispose()
    # счёт без банка — законное состояние (наличные, банк без плагина), и
    # счета, заведённые до этой миграции, обязаны остаться рабочими
    assert columns == {"bank_code": "YES", "bank_account_fingerprint": "YES"}


async def test_one_bank_account_maps_to_one_app_account(db_session: AsyncSession) -> None:
    """Два счёта приложения на один счёт банка — это разъехавшиеся операции:
    какой из них получит импорт, решал бы порядок, в котором коллектор
    перечислил счета.

    Первая половина теста стережёт обратное: счетов без отпечатка бывает
    сколько угодно, и уникальность не должна их задевать. Держится это не
    предикатом индекса, а тем, что Postgres считает NULL различными, — предикат
    здесь экономия и объявление намерения, а не то, на чём стоит правило."""
    workspace = Workspace(name="Дом", type="personal")
    db_session.add(workspace)
    await db_session.flush()

    def account(name: str, fingerprint: str | None) -> Account:
        return Account(
            workspace_id=workspace.id,
            name=name,
            type="card",
            currency="RUB",
            bank_code="alfa" if fingerprint else None,
            bank_account_fingerprint=fingerprint,
        )

    async with db_session.begin_nested():
        db_session.add_all([account("Наличные", None), account("Кошелёк", None)])
        await db_session.flush()

    with pytest.raises(IntegrityError):
        async with db_session.begin_nested():
            db_session.add_all([account("Первый", "a" * 64), account("Второй", "a" * 64)])
            await db_session.flush()


async def test_fingerprint_without_bank_is_rejected(db_session: AsyncSession) -> None:
    """Отпечаток считается от банка, и без банка не значит ничего: такую строку
    отбивает база, а не только сервис."""
    workspace = Workspace(name="Дом", type="personal")
    db_session.add(workspace)
    await db_session.flush()

    with pytest.raises(IntegrityError):
        async with db_session.begin_nested():
            db_session.add(
                Account(
                    workspace_id=workspace.id,
                    name="Ничей",
                    type="card",
                    currency="RUB",
                    bank_account_fingerprint="b" * 64,
                )
            )
            await db_session.flush()


async def test_discovered_account_is_unique_per_workspace(db_session: AsyncSession) -> None:
    """Повторный сбор не должен плодить строки об одном счёте банка."""
    workspace = Workspace(name="Дом", type="personal")
    db_session.add(workspace)
    await db_session.flush()

    with pytest.raises(IntegrityError):
        async with db_session.begin_nested():
            for _ in range(2):
                db_session.add(
                    DiscoveredAccount(
                        workspace_id=workspace.id,
                        bank_code="sber",
                        fingerprint="c" * 64,
                        name="Накопительный",
                        currency="RUB",
                    )
                )
            await db_session.flush()
