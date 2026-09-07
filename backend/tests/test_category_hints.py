import uuid
from decimal import Decimal

import pytest
from httpx import AsyncClient
from pydantic import ValidationError
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
