import uuid
from datetime import date
from decimal import Decimal
from typing import Any

import pytest
from httpx import AsyncClient
from pydantic import ValidationError
from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.category_hints import CATEGORY_HINTS, HINT_DEFAULTS, HintTarget
from app.imports import service
from app.imports.models import Import
from app.imports.schemas import ParsedOperationIn
from app.ledger import service as ledger_service
from app.ledger.models import Category
from app.ledger.repository import DEFAULT_CATEGORIES

ALICE = {"email": "alice@example.com", "password": "password123"}
BOB = {"email": "bob@example.com", "password": "password123"}

OPERATION = {
    "occurred_at": "2026-09-01",
    "amount": "-100.00",
    "currency": "RUB",
    "description": "Пятёрочка",
    "external_id": "bank-1",
}

# без описания и external_id: их тесты подтверждения задают сами — на них
# и держится разница между строками пачки
OP = {
    "occurred_at": "2026-09-01",
    "amount": "-450.00",
    "currency": "RUB",
    "kind": "purchase",
}


def test_schema_accepts_hint_from_vocabulary() -> None:
    op = ParsedOperationIn(**OPERATION, category_hint="groceries")
    assert op.category_hint == "groceries"


def test_schema_rejects_hint_outside_vocabulary() -> None:
    """Слово вне словаря — баг коллектора или разъехавшиеся версии; лучше 422,
    чем категория, которой ни одна операция не соответствует."""
    with pytest.raises(ValidationError):
        ParsedOperationIn(**OPERATION, category_hint="самолёты")


def test_hint_is_optional() -> None:
    """Разбор PDF-выписки о категории ничего не знает."""
    assert ParsedOperationIn(**OPERATION).category_hint is None


async def test_hint_survives_the_trip_into_parsed_payload(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """Три теста выше проверяют только схему на входе. Само применение подсказки —
    задача следующего этапа, но между приёмом и подтверждением она лежит в JSONB
    (parsed_payload) неопределённое время, и именно там её легче всего потерять
    молча. Проверяем этот участок пути напрямую, а не через побочный эффект
    в ledger, которого на этом этапе ещё нет."""
    ws, acc = await _register(client, ALICE)
    resp = await client.post(
        "/api/imports/parsed",
        params={"workspace_id": ws, "account_id": acc},
        json={
            "parser": "tbank_collector",
            "operations": [{**OPERATION, "category_hint": "groceries"}],
        },
    )
    assert resp.status_code == 201

    imp = await db_session.get(Import, uuid.UUID(resp.json()["import_id"]))
    assert imp is not None
    assert isinstance(imp.parsed_payload, dict)
    operations = imp.parsed_payload["operations"]
    assert isinstance(operations, list)
    assert operations[0]["category_hint"] == "groceries"


def test_missing_hint_key_deserializes_to_none_not_the_string_none() -> None:
    """Подсказка нигде не читается после разбора (следующая задача) и не видна
    ни в одном ответе API — поэтому чёрным ящиком порчу на чтении не заметить,
    и она требует прямой проверки. Ради этого и написана _optional_str:
    str(None) даёт строку "None", которая ни одной подсказке не соответствует,
    но выглядит как значение и не упала бы ни на одной проверке ниже по цепочке."""
    payload: dict[str, object] = {
        "operations": [
            {
                "occurred_at": "2026-09-01",
                "amount": "-100.00",
                "currency": "RUB",
                "description": "Пятёрочка",
                "kind": "unknown",
                # ключа category_hint нет — так выглядит payload, созданный до этой правки
            }
        ],
        "total_income": None,
        "total_expense": None,
        "warnings": [],
    }
    statement = service._payload_to_statement(payload)  # noqa: SLF001 — внутреннее чтение JSONB больше нигде не наблюдаемо
    assert statement.operations[0].category_hint is None


def test_every_hint_has_a_target() -> None:
    """Раскладка неполна — подсказка молча перестанет срабатывать; лишняя
    запись — опечатка в имени подсказки."""
    assert set(HINT_DEFAULTS) == set(CATEGORY_HINTS)


def test_target_carries_parent_name_and_direction() -> None:
    assert HINT_DEFAULTS["groceries"] == HintTarget("Еда", "Продукты", "expense")


def test_salary_lands_in_parent_without_subcategory() -> None:
    """Дробить «Зарплату» не на что, и лишний уровень там был бы шумом."""
    assert HINT_DEFAULTS["salary"] == HintTarget("Зарплата", None, "income")


def test_parents_come_from_default_tree() -> None:
    """Родителя, которого нет в дефолтном наборе, подсказка не найдёт никогда."""
    known = {name for name, _ in DEFAULT_CATEGORIES}
    assert {t.parent for t in HINT_DEFAULTS.values()} - known == set()


def test_hint_direction_matches_parent_direction() -> None:
    """Доходная подсказка под расходным родителем не сработает ни разу:
    знак суммы не совпадёт."""
    kind_of = dict(DEFAULT_CATEGORIES)
    assert [h for h, t in HINT_DEFAULTS.items() if kind_of[t.parent] != t.kind] == []


def test_subcategory_names_are_unique_within_parent() -> None:
    """Две подсказки с одним именем под одним родителем сядут в одну категорию
    и будут перетирать отметку друг друга на каждой операции."""
    pairs = [(t.parent, t.sub) for t in HINT_DEFAULTS.values()]
    assert len(pairs) == len(set(pairs))


def test_only_salary_lands_in_the_parent_itself() -> None:
    """`sub is None` помечает подсказкой саму категорию верхнего уровня.
    Случайный None увёл бы туда чужую подсказку и занял бы родителя навсегда."""
    assert [h for h, t in HINT_DEFAULTS.items() if t.sub is None] == ["salary"]


async def _register(client: AsyncClient, credentials: dict[str, str]) -> tuple[str, str]:
    """Зарегистрировать пользователя и вернуть его workspace со счётом."""
    await client.post("/api/auth/register", json=credentials)
    me = await client.get("/api/me")
    ws = str(me.json()["workspaces"][0]["id"])
    acc = (
        await client.post(
            "/api/accounts",
            params={"workspace_id": ws},
            json={"name": "Карта", "type": "card", "currency": "RUB"},
        )
    ).json()["id"]
    return ws, acc


async def _resolve(db: AsyncSession, ws: str, hint: str, amount: str) -> uuid.UUID | None:
    # сумма строкой: деньги в этом проекте не проходят через float нигде,
    # включая тесты
    return await ledger_service.resolve_hint_category(db, uuid.UUID(ws), hint, Decimal(amount))


async def test_hint_creates_subcategory_under_right_parent(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    ws, _ = await _register(client, ALICE)
    category_id = await _resolve(db_session, ws, "groceries", "-100.00")
    assert category_id is not None
    created = await db_session.get(Category, category_id)
    assert created is not None
    assert created.name == "Продукты"
    assert created.hint == "groceries"
    parent = await db_session.get(Category, created.parent_id)
    assert parent is not None
    assert parent.name == "Еда"


async def test_income_hint_creates_income_subcategory(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """Заведённая подсказкой подкатегория наследует направление подсказки:
    расходная категория под «Прочими доходами» не приняла бы ни одного прихода."""
    ws, _ = await _register(client, ALICE)
    category_id = await _resolve(db_session, ws, "cashback", "100.00")
    assert category_id is not None
    created = await db_session.get(Category, category_id)
    assert created is not None
    assert created.name == "Бонусы"
    assert created.kind == "income"
    parent = await db_session.get(Category, created.parent_id)
    assert parent is not None
    assert parent.name == "Прочие доходы"


async def test_second_operation_reuses_the_same_category(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """Дерево пополняется один раз, а не на каждую операцию."""
    ws, _ = await _register(client, ALICE)
    first = await _resolve(db_session, ws, "groceries", "-100.00")
    second = await _resolve(db_session, ws, "groceries", "-200.00")
    assert first == second


async def test_different_hints_land_in_different_categories(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """Ищем категорию по значению подсказки, а не по факту отметки: иначе весь
    банк съехал бы в одну категорию — ту, что помечена первой."""
    ws, _ = await _register(client, ALICE)
    groceries = await _resolve(db_session, ws, "groceries", "-100.00")
    dining = await _resolve(db_session, ws, "dining", "-200.00")
    assert groceries is not None
    assert dining is not None
    assert groceries != dining

    first = await db_session.get(Category, groceries)
    second = await db_session.get(Category, dining)
    assert first is not None
    assert second is not None
    assert first.name == "Продукты"
    assert second.name == "Кафе и рестораны"


async def test_renaming_category_keeps_it_as_target(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """Отметка живёт на категории, а не в имени: переименование соответствие
    не рвёт — ради этого она и на категории."""
    ws, _ = await _register(client, ALICE)
    category_id = await _resolve(db_session, ws, "groceries", "-100.00")
    created = await db_session.get(Category, category_id)
    assert created is not None
    created.name = "Еда домой"
    await db_session.flush()

    assert await _resolve(db_session, ws, "groceries", "-100.00") == category_id


async def test_income_hint_on_expense_does_not_fire(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """Подсказка «зарплата» на расходе — признак того, что операцию поняли
    неверно, а не повод положить расход в доходы."""
    ws, _ = await _register(client, ALICE)
    assert await _resolve(db_session, ws, "salary", "-100.00") is None


async def test_expense_hint_on_income_does_not_fire(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """Возврат в магазин приходит плюсом и с той же меткой «Супермаркеты»:
    расходную категорию ему давать нельзя — операция с ней не проведётся."""
    ws, _ = await _register(client, ALICE)
    assert await _resolve(db_session, ws, "groceries", "100.00") is None


async def test_salary_marks_parent_instead_of_creating_child(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    ws, _ = await _register(client, ALICE)
    category_id = await _resolve(db_session, ws, "salary", "5000.00")
    created = await db_session.get(Category, category_id)
    assert created is not None
    assert created.name == "Зарплата"
    assert created.parent_id is None
    assert created.hint == "salary"


async def test_renaming_parent_keeps_it_as_target(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """Подсказка, севшая в самого родителя, держится той же отметкой: имя
    родителя человек меняет так же свободно, как имя подкатегории."""
    ws, _ = await _register(client, ALICE)
    category_id = await _resolve(db_session, ws, "salary", "5000.00")
    created = await db_session.get(Category, category_id)
    assert created is not None
    created.name = "Оклад"
    await db_session.flush()

    assert await _resolve(db_session, ws, "salary", "5000.00") == category_id


async def test_hint_takes_over_category_the_person_already_made(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """Человек завёл «Продукты» сам — подсказка садится в неё, а не заводит
    вторую с тем же именем под тем же родителем."""
    ws, _ = await _register(client, ALICE)
    parent = await ledger_service.find_category_by_name(db_session, uuid.UUID(ws), "Еда")
    assert parent is not None
    mine = (
        await client.post(
            "/api/categories",
            params={"workspace_id": ws},
            json={"name": "Продукты", "kind": "expense", "parent_id": str(parent.id)},
        )
    ).json()["id"]

    assert await _resolve(db_session, ws, "groceries", "-100.00") == uuid.UUID(mine)

    listed = (await client.get("/api/categories", params={"workspace_id": ws})).json()
    assert [c["name"] for c in listed].count("Продукты") == 1

    # захват без отметки — половина дела: следующая же операция искала бы
    # категорию по имени заново, и переименование порвало бы соответствие
    taken = await db_session.get(Category, uuid.UUID(mine))
    assert taken is not None
    assert taken.hint == "groceries"


async def test_hint_does_not_take_over_category_of_other_direction(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """Человек волен завести доходные «Продукты» под расходной «Едой».
    Подсказка расхода в них не садится: операция с такой категорией не
    проведётся, а импорт этот отказ не ловит и уронил бы всю пачку."""
    ws, _ = await _register(client, ALICE)
    parent = await ledger_service.find_category_by_name(db_session, uuid.UUID(ws), "Еда")
    assert parent is not None
    mine = (
        await client.post(
            "/api/categories",
            params={"workspace_id": ws},
            json={"name": "Продукты", "kind": "income", "parent_id": str(parent.id)},
        )
    ).json()["id"]

    assert await _resolve(db_session, ws, "groceries", "-100.00") is None

    # и отметку на чужой категории не оставили: иначе следующая операция
    # получила бы её уже готовой, минуя проверку направления
    theirs = await db_session.get(Category, uuid.UUID(mine))
    assert theirs is not None
    await db_session.refresh(theirs)
    assert theirs.hint is None


async def test_parent_is_looked_up_at_top_level(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """Родитель подсказки — категория верхнего уровня. Своё дерево человек
    строит как хочет, и одноимённая ветка внутри него подсказку не перехватывает."""
    ws, _ = await _register(client, ALICE)
    other = await ledger_service.find_category_by_name(db_session, uuid.UUID(ws), "Прочее")
    assert other is not None
    nested_food = (
        await client.post(
            "/api/categories",
            params={"workspace_id": ws},
            json={"name": "Еда", "kind": "expense", "parent_id": str(other.id)},
        )
    ).json()["id"]
    nested_groceries = (
        await client.post(
            "/api/categories",
            params={"workspace_id": ws},
            json={"name": "Продукты", "kind": "expense", "parent_id": nested_food},
        )
    ).json()["id"]

    category_id = await _resolve(db_session, ws, "groceries", "-100.00")
    assert category_id is not None
    assert category_id != uuid.UUID(nested_groceries)
    created = await db_session.get(Category, category_id)
    assert created is not None
    top = await db_session.get(Category, created.parent_id)
    assert top is not None
    assert top.name == "Еда"
    assert top.parent_id is None


async def test_deleted_parent_is_not_resurrected(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    ws, _ = await _register(client, ALICE)
    parent = await ledger_service.find_category_by_name(db_session, uuid.UUID(ws), "Еда")
    assert parent is not None
    await db_session.delete(parent)
    await db_session.flush()

    assert await _resolve(db_session, ws, "groceries", "-100.00") is None


async def test_hint_outside_vocabulary_does_not_fire(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """Разошлись версии коннектора и приложения — операция остаётся без
    категории, а не получает случайную."""
    ws, _ = await _register(client, ALICE)
    assert await _resolve(db_session, ws, "самолёты", "-100.00") is None


async def test_hint_of_another_workspace_is_invisible(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    ws_alice, _ = await _register(client, ALICE)
    mine = await _resolve(db_session, ws_alice, "groceries", "-100.00")
    ws_bob, _ = await _register(client, BOB)
    theirs = await _resolve(db_session, ws_bob, "groceries", "-100.00")
    assert mine is not None
    assert theirs is not None
    assert mine != theirs


# Подсказка при подтверждении импорта — там, где она наконец раскладывает
# операции. Выше проверялось только разрешение подсказки в категорию.


async def _import(client: AsyncClient, ws: str, acc: str, *operations: dict[str, Any]) -> int:
    started = await client.post(
        "/api/imports/parsed",
        params={"workspace_id": ws, "account_id": acc},
        json={"parser": "test_collector", "operations": list(operations)},
    )
    assert started.status_code == 201
    committed = await client.post(
        f"/api/imports/{started.json()['import_id']}/commit", params={"workspace_id": ws}
    )
    assert committed.status_code == 200
    imported: int = committed.json()["imported"]
    return imported


async def _transactions(client: AsyncClient, ws: str) -> list[dict[str, Any]]:
    resp = await client.get("/api/transactions", params={"workspace_id": ws})
    assert resp.status_code == 200
    items: list[dict[str, Any]] = resp.json()["items"]
    return items


async def _category_names(client: AsyncClient, ws: str) -> list[str]:
    resp = await client.get("/api/categories", params={"workspace_id": ws})
    assert resp.status_code == 200
    return [str(c["name"]) for c in resp.json()]


async def _category_name(client: AsyncClient, ws: str, category_id: str) -> str:
    resp = await client.get("/api/categories", params={"workspace_id": ws})
    return str(next(c for c in resp.json() if str(c["id"]) == category_id)["name"])


async def test_hint_puts_operation_into_subcategory(client: AsyncClient) -> None:
    ws, acc = await _register(client, ALICE)
    await _import(
        client,
        ws,
        acc,
        {**OP, "description": "Пятёрочка", "external_id": "op-1", "category_hint": "groceries"},
    )

    item = (await _transactions(client, ws))[0]
    assert await _category_name(client, ws, item["category_id"]) == "Продукты"
    # решение машинное: эту конкретную операцию человек не смотрел
    assert item["category_confirmed"] is False
    # подсказка детерминирована; приписать ей уверенность значило бы выдать
    # таблицу за оценку модели
    assert item["category_confidence"] is None


async def test_human_rule_beats_bank_hint(client: AsyncClient, db_session: AsyncSession) -> None:
    """Порядок конвейера: решение человека сильнее подсказки банка."""
    ws, acc = await _register(client, ALICE)
    own = (
        await client.post(
            "/api/categories",
            params={"workspace_id": ws},
            json={"name": "Моя еда", "kind": "expense"},
        )
    ).json()["id"]
    await ledger_service.create_description_rule(
        db_session, uuid.UUID(ws), "Пятёрочка", uuid.UUID(own)
    )

    await _import(
        client,
        ws,
        acc,
        {**OP, "description": "Пятёрочка", "external_id": "op-1", "category_hint": "groceries"},
    )

    assert (await _transactions(client, ws))[0]["category_id"] == own


async def test_operation_without_hint_stays_uncategorized(client: AsyncClient) -> None:
    """Банк не подсказал — операция ждёт модель, как ждала до этой работы."""
    ws, acc = await _register(client, ALICE)
    await _import(client, ws, acc, {**OP, "description": "Что-то", "external_id": "op-1"})

    assert (await _transactions(client, ws))[0]["category_id"] is None


async def test_hint_does_not_create_a_learned_rule(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """Правило — след решения человека. Заводись оно от подсказки, машинная
    догадка стала бы неотличима от подтверждения и пережила бы её отмену."""
    ws, acc = await _register(client, ALICE)
    await _import(
        client,
        ws,
        acc,
        {**OP, "description": "Пятёрочка", "external_id": "op-1", "category_hint": "groceries"},
    )

    assert await ledger_service.load_description_rules(db_session, uuid.UUID(ws)) == {}


async def test_subcategory_is_created_once_per_batch(client: AsyncClient) -> None:
    ws, acc = await _register(client, ALICE)
    imported = await _import(
        client,
        ws,
        acc,
        {**OP, "description": "Пятёрочка", "external_id": "op-1", "category_hint": "groceries"},
        {**OP, "description": "Магнит", "external_id": "op-2", "category_hint": "groceries"},
    )
    assert imported == 2

    ids = {item["category_id"] for item in await _transactions(client, ws)}
    assert len(ids) == 1
    # ровно одна «Продукты», а не по одной на операцию
    assert (await _category_names(client, ws)).count("Продукты") == 1


async def test_hint_asks_the_database_once_per_hint(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """Подсказок в словаре 37, а операций в пачке до 25 000: спрашивать базу
    на каждую строку — тот же N+1, от которого выше спасает чтение правил разом
    (см. комментарий в commit_from_import). Считаем запросы к categories с
    условием на hint (category_by_hint) — "categories.hint =" в WHERE, а не
    просто наличие столбца hint в SELECT-списке: он есть в любой выборке
    Category, включая SELECT по id внутри validate_posting, который честно
    нужен на каждую операцию и здесь не в счёт."""
    ws, acc = await _register(client, ALICE)
    seen: list[str] = []

    def record(conn, cursor, statement, parameters, context, executemany):  # type: ignore[no-untyped-def]
        if "categories" in statement and "categories.hint =" in statement:
            seen.append(statement)

    engine = db_session.get_bind()
    sync_engine = getattr(engine, "sync_engine", engine)
    event.listen(sync_engine, "before_cursor_execute", record)
    try:
        await _import(
            client,
            ws,
            acc,
            *[
                {
                    **OP,
                    "description": f"Магазин {i}",
                    "external_id": f"op-{i}",
                    "category_hint": "groceries",
                }
                for i in range(20)
            ],
        )
    finally:
        event.remove(sync_engine, "before_cursor_execute", record)

    # без памятки запросов было бы 20 (по одному на операцию); с ней — не
    # больше двух на всю пачку с одной подсказкой (первый — проверить, что
    # категории ещё нет, второй теоретически возможен при повторном чтении)
    assert len(seen) <= 2, seen


async def test_hint_asks_the_database_once_per_hint_even_when_it_never_resolves(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """Тест выше проверяет удачный путь, а «groceries» там резолвится в
    реальную категорию: и key not in hint_categories, и hint_categories.get(key)
    is None ведут себя одинаково, потому что закешированное значение не None.
    Разница видна только там, где подсказка не срабатывает раз за разом
    (здесь — удалённый родитель, как в test_deleted_parent_is_not_resurrected):
    не кешируя сам None, мы бы снова спрашивали базу на каждую строку —
    ровно в том случае, где не найденных подсказок больше всего."""
    ws, acc = await _register(client, ALICE)
    parent = await ledger_service.find_category_by_name(db_session, uuid.UUID(ws), "Еда")
    assert parent is not None
    await db_session.delete(parent)
    await db_session.flush()

    seen: list[str] = []

    def record(conn, cursor, statement, parameters, context, executemany):  # type: ignore[no-untyped-def]
        if "categories" in statement and "categories.hint =" in statement:
            seen.append(statement)

    engine = db_session.get_bind()
    sync_engine = getattr(engine, "sync_engine", engine)
    event.listen(sync_engine, "before_cursor_execute", record)
    try:
        imported = await _import(
            client,
            ws,
            acc,
            *[
                {
                    **OP,
                    "description": f"Магазин {i}",
                    "external_id": f"op-{i}",
                    "category_hint": "groceries",
                }
                for i in range(20)
            ],
        )
    finally:
        event.remove(sync_engine, "before_cursor_execute", record)

    assert imported == 20
    assert len(seen) <= 2, seen


# Свёртка расходов месяца к категориям верхнего уровня. Смотрим через дашборд:
# считает свёртку запрос в repository, но видит её человек именно там, и границы
# месяца тогда не приходится вычислять в тесте заново.


async def _month_expenses(client: AsyncClient, ws: str) -> list[dict[str, Any]]:
    resp = await client.get("/api/dashboard", params={"workspace_id": ws})
    assert resp.status_code == 200
    rows: list[dict[str, Any]] = resp.json()["month_expenses"]
    return rows


async def _spend(
    client: AsyncClient, ws: str, acc: str, category_id: str | None, amount: str
) -> None:
    body: dict[str, Any] = {
        "account_id": acc,
        "amount": amount,
        "occurred_at": date.today().isoformat(),
    }
    if category_id is not None:
        body["category_id"] = category_id
    resp = await client.post("/api/transactions", params={"workspace_id": ws}, json=body)
    assert resp.status_code == 201


async def test_subcategory_spending_counts_in_parent(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """Без свёртки первый же сбор с подсказками опустошил бы «Еду», разложив
    её по «Продуктам» и «Кафе»."""
    ws, acc = await _register(client, ALICE)
    # commit не нужен: у теста и у приложения сессия одна, flush внутри
    # resolve_hint_category делает категории видимыми для следующего запроса
    groceries = await _resolve(db_session, ws, "groceries", "-1.00")
    dining = await _resolve(db_session, ws, "dining", "-1.00")
    await _spend(client, ws, acc, str(groceries), "-100.00")
    await _spend(client, ws, acc, str(dining), "-50.00")

    rows = await _month_expenses(client, ws)
    assert [(r["category_name"], r["total"]) for r in rows] == [("Еда", "150.0000")]


async def test_top_level_category_counts_on_its_own(client: AsyncClient) -> None:
    """У категории верхнего уровня родителя нет, и считаться она должна сама
    по себе, а не пропасть из свёртки."""
    ws, acc = await _register(client, ALICE)
    cats = (await client.get("/api/categories", params={"workspace_id": ws})).json()
    food = next(c for c in cats if c["name"] == "Еда")
    await _spend(client, ws, acc, food["id"], "-70.00")

    rows = await _month_expenses(client, ws)
    assert [(r["category_id"], r["category_name"]) for r in rows] == [(food["id"], "Еда")]


async def test_month_expenses_do_not_leak_between_workspaces(client: AsyncClient) -> None:
    """Свёртка отбирает операции своего workspace сама, а не полагается на
    проверку доступа в роутере: чужие расходы на дашборде — не лишняя строка,
    а утечка между домохозяйствами. Прикрыт этим тестом и один только он:
    остальные тесты дашборда живут в одном workspace и снятый фильтр
    не заметили бы."""
    ws_alice, acc_alice = await _register(client, ALICE)
    alice_cats = (await client.get("/api/categories", params={"workspace_id": ws_alice})).json()
    alice_food = next(c for c in alice_cats if c["name"] == "Еда")["id"]
    await _spend(client, ws_alice, acc_alice, alice_food, "-100.00")

    ws_bob, acc_bob = await _register(client, BOB)
    bob_cats = (await client.get("/api/categories", params={"workspace_id": ws_bob})).json()
    bob_food = next(c for c in bob_cats if c["name"] == "Еда")["id"]
    await _spend(client, ws_bob, acc_bob, bob_food, "-777.00")

    rows = await _month_expenses(client, ws_bob)
    assert [(r["category_id"], r["total"]) for r in rows] == [(bob_food, "777.0000")]

    client.cookies.clear()
    await client.post("/api/auth/login", json=ALICE)
    rows = await _month_expenses(client, ws_alice)
    assert [(r["category_id"], r["total"]) for r in rows] == [(alice_food, "100.0000")]
