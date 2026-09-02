import uuid
from decimal import Decimal
from typing import Any

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.ledger import repository as ledger_repository
from app.ledger import service as ledger_service
from app.ledger.service import normalize_description

ALICE = {"email": "alice@example.com", "password": "password123"}
BOB = {"email": "bob@example.com", "password": "password123"}


def test_normalization_is_simple_and_predictable() -> None:
    """Нормализация намеренно простая: регистр и лишние пробелы. Вычищать «шум»
    банковских описаний регулярками значит подгонять систему под один банк."""
    assert normalize_description("  Анастасия   С.  ") == "анастасия с."
    assert normalize_description("КОФЕЙНЯ") == "кофейня"


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


async def _categories(client: AsyncClient, ws: str, kind: str) -> list[str]:
    resp = await client.get("/api/categories", params={"workspace_id": ws})
    assert resp.status_code == 200
    return [str(c["id"]) for c in resp.json() if c["kind"] == kind]


async def _category_id(client: AsyncClient, ws: str, kind: str) -> str:
    return (await _categories(client, ws, kind))[0]


async def _add_rule(db: AsyncSession, ws: str, text: str, category_id: str) -> None:
    """Правило через сервис: ручка управления правилами появляется следующим
    шагом плана, а сама подстановка категории работает уже здесь."""
    await ledger_service.create_description_rule(db, uuid.UUID(ws), text, uuid.UUID(category_id))


async def _import_one(
    client: AsyncClient, ws: str, acc: str, description: str, amount: str = "-450.00"
) -> None:
    started = await client.post(
        "/api/imports/parsed",
        params={"workspace_id": ws, "account_id": acc},
        json={
            "parser": "test_collector",
            "operations": [
                {
                    "occurred_at": "2026-09-01",
                    "amount": amount,
                    "currency": "RUB",
                    "description": description,
                    "external_id": f"op-{description}-{amount}",
                    "kind": "transfer_person",
                }
            ],
        },
    )
    assert started.status_code == 201
    committed = await client.post(
        f"/api/imports/{started.json()['import_id']}/commit", params={"workspace_id": ws}
    )
    assert committed.status_code == 200
    assert committed.json()["imported"] == 1


async def _first_transaction(client: AsyncClient, ws: str) -> dict[str, Any]:
    resp = await client.get("/api/transactions", params={"workspace_id": ws})
    assert resp.status_code == 200
    item: dict[str, Any] = resp.json()["items"][0]
    return item


async def test_rule_sets_category_on_import(client: AsyncClient, db_session: AsyncSession) -> None:
    """Перевод близкому попадает в свою категорию сам — ради этого правила и
    заводятся. Описание совпадает с правилом после нормализации, а не буквально."""
    ws, acc = await _register(client, ALICE)
    cat = await _category_id(client, ws, "expense")
    await _add_rule(db_session, ws, "Анастасия С.", cat)

    await _import_one(client, ws, acc, "анастасия   с.")

    item = await _first_transaction(client, ws)
    assert item["category_id"] == cat
    # правило подтвердил человек, а не эту конкретную операцию
    assert item["category_confirmed"] is False


async def test_import_without_rule_leaves_category_empty(client: AsyncClient) -> None:
    ws, acc = await _register(client, ALICE)
    await _import_one(client, ws, acc, "Незнакомый контрагент")

    assert (await _first_transaction(client, ws))["category_id"] is None


async def test_rule_skipped_when_sign_contradicts_category(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """Тому же человеку и переводят в ответ. Категория расходов на поступление
    не встаёт — и весь импорт из-за этой строки не падает."""
    ws, acc = await _register(client, ALICE)
    cat = await _category_id(client, ws, "expense")
    await _add_rule(db_session, ws, "Анастасия С.", cat)

    await _import_one(client, ws, acc, "Анастасия С.", amount="450.00")

    assert (await _first_transaction(client, ws))["category_id"] is None


async def test_rule_does_not_apply_to_manual_transaction(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """При ручном вводе человек выбирает категорию сам: подставлять за него
    правило незачем, а тем более подменять уже выбранное."""
    ws, acc = await _register(client, ALICE)
    # категории правила и ручного выбора разные — иначе подмена была бы незаметна
    rule_cat, chosen = (await _categories(client, ws, "expense"))[:2]
    await _add_rule(db_session, ws, "Кофейня", rule_cat)

    without_category = await client.post(
        "/api/transactions",
        params={"workspace_id": ws},
        json={
            "account_id": acc,
            "amount": "-100.00",
            "occurred_at": "2026-09-01",
            "merchant": "Кофейня",
        },
    )
    assert without_category.status_code == 201
    assert without_category.json()["category_id"] is None

    with_category = await client.post(
        "/api/transactions",
        params={"workspace_id": ws},
        json={
            "account_id": acc,
            "amount": "-200.00",
            "occurred_at": "2026-09-01",
            "merchant": "Кофейня",
            "category_id": chosen,
        },
    )
    assert with_category.status_code == 201
    assert with_category.json()["category_id"] == chosen


async def test_rules_are_isolated_between_workspaces(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """Правило чужого workspace не должно доставать до наших операций: утечка
    между workspace — критический баг, а не косметика."""
    ws_a, _ = await _register(client, ALICE)
    cat_a = await _category_id(client, ws_a, "expense")
    await _add_rule(db_session, ws_a, "Анастасия С.", cat_a)

    client.cookies.clear()
    ws_b, acc_b = await _register(client, BOB)
    await _import_one(client, ws_b, acc_b, "Анастасия С.")

    assert (await _first_transaction(client, ws_b))["category_id"] is None
    # и сам поиск чужого правила не находит: фильтр по workspace живёт в
    # repository, поэтому спрашиваем прямо его. По одной пустой категории
    # операции этого не видно — правило чужого workspace ссылается и на чужую
    # категорию, и она отсеется следующей проверкой, даже если правило нашлось
    assert (
        await ledger_repository.find_description_rule(db_session, uuid.UUID(ws_b), "анастасия с.")
        is None
    )


async def test_rule_rejects_category_of_another_workspace(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    ws_a, _ = await _register(client, ALICE)
    cat_a = await _category_id(client, ws_a, "expense")

    client.cookies.clear()
    ws_b, _ = await _register(client, BOB)
    with pytest.raises(ledger_service.NotFoundError):
        await _add_rule(db_session, ws_b, "Анастасия С.", cat_a)


async def test_duplicate_rule_is_rejected(client: AsyncClient, db_session: AsyncSession) -> None:
    """Одно описание — одна категория: иначе поиск по ключу отвечал бы
    по-разному. Другой регистр нормализуется в тот же ключ."""
    ws, _ = await _register(client, ALICE)
    cat = await _category_id(client, ws, "expense")
    await _add_rule(db_session, ws, "Анастасия С.", cat)

    with pytest.raises(ledger_service.DuplicateRuleError):
        await _add_rule(db_session, ws, "анастасия с.", cat)


# Ручки управления правилами появляются следующим шагом плана (Task 7). Договор
# с ними описан здесь заранее, поэтому до него эти три теста красные.


async def test_rule_created_through_api_applies_on_import(client: AsyncClient) -> None:
    ws, acc = await _register(client, ALICE)
    cat = await _category_id(client, ws, "expense")
    created = await client.post(
        "/api/description-rules",
        params={"workspace_id": ws},
        json={"text": "Анастасия С.", "category_id": cat},
    )
    assert created.status_code == 201

    await _import_one(client, ws, acc, "анастасия   с.")

    item = await _first_transaction(client, ws)
    assert item["category_id"] == cat
    assert Decimal(item["amount"]) == Decimal("-450.00")


async def test_api_rejects_duplicate_rule(client: AsyncClient) -> None:
    ws, _ = await _register(client, ALICE)
    cat = await _category_id(client, ws, "expense")
    body = {"text": "Анастасия С.", "category_id": cat}
    first = await client.post("/api/description-rules", params={"workspace_id": ws}, json=body)
    assert first.status_code == 201

    again = await client.post(
        "/api/description-rules",
        params={"workspace_id": ws},
        json={"text": "анастасия с.", "category_id": cat},
    )
    assert again.status_code == 409


async def test_api_does_not_show_rules_of_another_workspace(client: AsyncClient) -> None:
    ws_a, _ = await _register(client, ALICE)

    client.cookies.clear()
    await _register(client, BOB)
    foreign = await client.get("/api/description-rules", params={"workspace_id": ws_a})
    assert foreign.status_code == 403
