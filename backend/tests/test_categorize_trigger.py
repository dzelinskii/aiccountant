import uuid
from datetime import date
from decimal import Decimal

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.imports import service
from app.imports.parser import ParsedOperation, ParsedStatement
from tests.fixtures import fixed_parse

ALICE = {"email": "alice@example.com", "password": "password123"}

# минимальная выписка с одной операцией — для проверки триггера после коммита импорта
IMPORT_SAMPLE_STATEMENT = ParsedStatement(
    operations=[
        ParsedOperation(
            occurred_at=date(2026, 7, 4),
            amount=Decimal("-1150.00"),
            currency="RUB",
            description="Внешний перевод по номеру телефона",
        )
    ],
    total_income=None,
    total_expense=None,
)
IMPORT_FILE = {"file": ("statement.pdf", b"%PDF-dummy", "application/pdf")}


async def _ws_and_account(client: AsyncClient) -> tuple[str, str]:
    await client.post("/api/auth/register", json=ALICE)
    me = await client.get("/api/me")
    ws = me.json()["workspaces"][0]["id"]
    acc = (
        await client.post(
            "/api/accounts",
            params={"workspace_id": ws},
            json={"name": "Карта", "type": "card", "currency": "RUB"},
        )
    ).json()["id"]
    return ws, acc


async def test_manual_create_without_category_enqueues(
    client: AsyncClient, stub_categorize_enqueue: list[uuid.UUID]
) -> None:
    ws, acc = await _ws_and_account(client)
    await client.post(
        "/api/transactions",
        params={"workspace_id": ws},
        json={"account_id": acc, "amount": "-100.00", "occurred_at": "2026-07-05"},
    )
    assert uuid.UUID(ws) in stub_categorize_enqueue


async def test_manual_create_with_category_does_not_enqueue(
    client: AsyncClient, stub_categorize_enqueue: list[uuid.UUID]
) -> None:
    ws, acc = await _ws_and_account(client)
    cats = (await client.get("/api/categories", params={"workspace_id": ws})).json()
    food = next(c["id"] for c in cats if c["name"] == "Еда")
    await client.post(
        "/api/transactions",
        params={"workspace_id": ws},
        json={
            "account_id": acc,
            "category_id": food,
            "amount": "-100.00",
            "occurred_at": "2026-07-05",
        },
    )
    assert stub_categorize_enqueue == []


async def test_import_commit_enqueues(
    client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    stub_categorize_enqueue: list[uuid.UUID],
) -> None:
    # разбор выписки подменяем готовым результатом — важен сам факт коммита ≥1 операции,
    # а не то, как именно был получен разбор (детерминированный парсер или LLM)
    monkeypatch.setattr("app.imports.router.extract_lines", lambda b: ["строка выписки"])
    ws, acc = await _ws_and_account(client)
    started = (
        await client.post(
            "/api/imports", params={"workspace_id": ws, "account_id": acc}, files=IMPORT_FILE
        )
    ).json()
    await service.run_parse(
        db_session,
        uuid.UUID(started["import_id"]),
        parse=fixed_parse(IMPORT_SAMPLE_STATEMENT, "tbank_statement"),
    )

    resp = await client.post(
        f"/api/imports/{started['import_id']}/commit", params={"workspace_id": ws}
    )
    assert resp.json()["imported"] == 1
    assert uuid.UUID(ws) in stub_categorize_enqueue


async def test_categorize_endpoint_enqueues(
    client: AsyncClient, stub_categorize_enqueue: list[uuid.UUID]
) -> None:
    ws, _ = await _ws_and_account(client)
    resp = await client.post("/api/transactions/categorize", params={"workspace_id": ws})
    assert resp.status_code == 202
    assert uuid.UUID(ws) in stub_categorize_enqueue
