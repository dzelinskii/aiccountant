import uuid
from typing import Any

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.ledger import repository as ledger_repository

ALICE = {"email": "alice@example.com", "password": "password123"}


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


async def _add_transaction(
    client: AsyncClient,
    ws: str,
    acc: str,
    merchant: str | None,
    *,
    category_id: str | None = None,
) -> str:
    body: dict[str, Any] = {"account_id": acc, "amount": "-450.00", "occurred_at": "2026-09-01"}
    if merchant is not None:
        body["merchant"] = merchant
    if category_id is not None:
        body["category_id"] = category_id
    created = await client.post("/api/transactions", params={"workspace_id": ws}, json=body)
    assert created.status_code == 201
    return str(created.json()["id"])


async def _confirm_category(
    client: AsyncClient, ws: str, transaction_id: str, category_id: str
) -> dict[str, Any]:
    """Человек явно выбрал категорию у операции — то самое подтверждение."""
    resp = await client.patch(
        f"/api/transactions/{transaction_id}",
        params={"workspace_id": ws},
        json={"category_id": category_id},
    )
    assert resp.status_code == 200
    item: dict[str, Any] = resp.json()
    return item


async def _rules(client: AsyncClient, ws: str) -> list[tuple[str, str, str]]:
    """Правила workspace тройками «ключ, категория, происхождение»."""
    resp = await client.get("/api/description-rules", params={"workspace_id": ws})
    assert resp.status_code == 200
    return [(r["normalized_text"], r["category_id"], r["source"]) for r in resp.json()]


async def test_confirmation_learns_rule(client: AsyncClient) -> None:
    """Подтвердил категорию — система запомнила. Ключом идёт нормализованное
    описание: правило обязано сработать и на «КОФЕЙНЯ  У  ДОМА» из следующей
    выписки, а не только на буквально ту же строку."""
    ws, acc = await _register(client, ALICE)
    cat = await _category_id(client, ws, "expense")
    transaction = await _add_transaction(client, ws, acc, "  Кофейня   У Дома ")

    await _confirm_category(client, ws, transaction, cat)

    assert await _rules(client, ws) == [("кофейня у дома", cat, "learned")]


async def test_next_confirmation_updates_learned_rule(client: AsyncClient) -> None:
    """Последнее подтверждение и есть текущее намерение человека: выученное
    правило обновляется, а не превращается во второе для того же описания."""
    ws, acc = await _register(client, ALICE)
    first, second = (await _categories(client, ws, "expense"))[:2]
    transaction = await _add_transaction(client, ws, acc, "Кофейня")

    await _confirm_category(client, ws, transaction, first)
    await _confirm_category(client, ws, transaction, second)

    assert await _rules(client, ws) == [("кофейня", second, "learned")]


async def test_manual_rule_is_not_overwritten(client: AsyncClient) -> None:
    """Кто завёл правило сам, не ждёт, что оно поменяется от правки одной
    операции. Правку это не отменяет — она касается только этой операции."""
    ws, acc = await _register(client, ALICE)
    by_hand, chosen = (await _categories(client, ws, "expense"))[:2]
    created = await client.post(
        "/api/description-rules",
        params={"workspace_id": ws},
        json={"text": "Кофейня", "category_id": by_hand},
    )
    assert created.status_code == 201
    transaction = await _add_transaction(client, ws, acc, "Кофейня")

    confirmed = await _confirm_category(client, ws, transaction, chosen)

    assert confirmed["category_id"] == chosen
    assert await _rules(client, ws) == [("кофейня", by_hand, "manual")]


async def test_dismissing_suggestion_learns_nothing(client: AsyncClient) -> None:
    """Отклонение подсказки — отказ от категории, а не выбор: учиться нечему.

    Категория у операции при этом стоит: без неё правило не вышло бы в любом
    случае, и проверка ничего бы не стерегла.
    """
    ws, acc = await _register(client, ALICE)
    cat = await _category_id(client, ws, "expense")
    transaction = await _add_transaction(client, ws, acc, "Кофейня", category_id=cat)

    dismissed = await client.post(
        f"/api/transactions/{transaction}/dismiss-suggestion", params={"workspace_id": ws}
    )
    assert dismissed.status_code == 200

    assert await _rules(client, ws) == []


async def test_transaction_without_description_learns_nothing(client: AsyncClient) -> None:
    ws, acc = await _register(client, ALICE)
    cat = await _category_id(client, ws, "expense")
    transaction = await _add_transaction(client, ws, acc, None)

    confirmed = await _confirm_category(client, ws, transaction, cat)

    assert confirmed["category_id"] == cat
    assert await _rules(client, ws) == []


async def test_blank_description_learns_nothing(client: AsyncClient) -> None:
    """Из одних пробелов вышел бы пустой ключ — он ловил бы любую операцию
    с пробельным описанием и занимал бы уникальную пару."""
    ws, acc = await _register(client, ALICE)
    cat = await _category_id(client, ws, "expense")
    transaction = await _add_transaction(client, ws, acc, "   ")

    confirmed = await _confirm_category(client, ws, transaction, cat)

    assert confirmed["category_id"] == cat
    assert await _rules(client, ws) == []


async def test_racing_confirmation_does_not_break_the_edit(
    client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Окно гонки: правило для описания уже есть, но поиск его не увидел —
    отвечает уникальный индекс. Правка операции обязана уцелеть: выученное
    правило не настолько важно, чтобы из-за него провалилось подтверждение."""
    ws, acc = await _register(client, ALICE)
    existing_cat, chosen = (await _categories(client, ws, "expense"))[:2]
    created = await client.post(
        "/api/description-rules",
        params={"workspace_id": ws},
        json={"text": "Кофейня", "category_id": existing_cat},
    )
    assert created.status_code == 201
    transaction = await _add_transaction(client, ws, acc, "Кофейня")

    async def blind(*args: object, **kwargs: object) -> None:
        return None

    monkeypatch.setattr(ledger_repository, "find_description_rule", blind)
    confirmed = await _confirm_category(client, ws, transaction, chosen)

    assert confirmed["category_id"] == chosen
    monkeypatch.undo()
    assert await _rules(client, ws) == [("кофейня", existing_cat, "manual")]
    stored = await ledger_repository.get_transaction(
        db_session, uuid.UUID(ws), uuid.UUID(transaction)
    )
    assert stored is not None
    assert str(stored.category_id) == chosen
