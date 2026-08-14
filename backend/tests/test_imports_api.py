import uuid

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.imports import service
from tests.test_import_async_service import SAMPLE, _fixed_parse

ALICE = {"email": "alice@example.com", "password": "password123"}
BOB = {"email": "bob@example.com", "password": "password123"}

FILES = {"file": ("statement.pdf", b"%PDF-dummy", "application/pdf")}


async def _setup(client: AsyncClient, creds: dict[str, str]) -> tuple[str, str]:
    await client.post("/api/auth/register", json=creds)
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


async def test_start_import_returns_202_and_enqueues_parse(
    client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
    stub_parse_enqueue: list[uuid.UUID],
) -> None:
    monkeypatch.setattr("app.imports.router.extract_lines", lambda b: ["строка выписки"])
    ws, acc = await _setup(client, ALICE)

    resp = await client.post(
        "/api/imports", params={"workspace_id": ws, "account_id": acc}, files=FILES
    )

    assert resp.status_code == 202
    body = resp.json()
    assert body["status"] == "processing"
    assert uuid.UUID(body["import_id"]) in stub_parse_enqueue


async def test_full_flow_status_and_commit(
    client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    # разбор в бою асинхронный (LLM ходит по сети): брокер в тестах заглушен,
    # поэтому фоновую задачу здесь имитируем прямым вызовом service.run_parse
    monkeypatch.setattr("app.imports.router.extract_lines", lambda b: ["строка выписки"])
    ws, acc = await _setup(client, ALICE)

    started = (
        await client.post(
            "/api/imports", params={"workspace_id": ws, "account_id": acc}, files=FILES
        )
    ).json()
    import_id = started["import_id"]

    await service.run_parse(
        db_session, uuid.UUID(import_id), parse=_fixed_parse(SAMPLE, "tbank_statement")
    )

    status = (await client.get(f"/api/imports/{import_id}", params={"workspace_id": ws})).json()
    assert status["status"] == "ready"
    assert status["parser"] == "tbank_statement"
    assert status["preview"]["new_count"] == 2
    assert status["preview"]["duplicate_count"] == 0

    commit = await client.post(f"/api/imports/{import_id}/commit", params={"workspace_id": ws})
    assert commit.status_code == 200
    assert commit.json()["imported"] == 2

    txns = (await client.get("/api/transactions", params={"workspace_id": ws})).json()
    assert txns["total"] == 2


async def test_status_of_foreign_workspace_is_404(
    client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("app.imports.router.extract_lines", lambda b: ["строка выписки"])
    ws, acc = await _setup(client, ALICE)
    started = (
        await client.post(
            "/api/imports", params={"workspace_id": ws, "account_id": acc}, files=FILES
        )
    ).json()

    client.cookies.clear()
    ws_bob, _ = await _setup(client, BOB)

    resp = await client.get(f"/api/imports/{started['import_id']}", params={"workspace_id": ws_bob})
    assert resp.status_code == 404


async def test_commit_of_foreign_workspace_is_404(
    client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    # тот же код, что и у GET /imports/{id} — иначе расхождение 404-vs-409
    # раскрыло бы сам факт существования чужого импорта
    monkeypatch.setattr("app.imports.router.extract_lines", lambda b: ["строка выписки"])
    ws, acc = await _setup(client, ALICE)
    started = (
        await client.post(
            "/api/imports", params={"workspace_id": ws, "account_id": acc}, files=FILES
        )
    ).json()
    await service.run_parse(
        db_session, uuid.UUID(started["import_id"]), parse=_fixed_parse(SAMPLE, "tbank_statement")
    )

    client.cookies.clear()
    ws_bob, _ = await _setup(client, BOB)

    resp = await client.post(
        f"/api/imports/{started['import_id']}/commit", params={"workspace_id": ws_bob}
    )
    assert resp.status_code == 404


async def test_commit_while_still_processing_is_409(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("app.imports.router.extract_lines", lambda b: ["строка выписки"])
    ws, acc = await _setup(client, ALICE)
    started = (
        await client.post(
            "/api/imports", params={"workspace_id": ws, "account_id": acc}, files=FILES
        )
    ).json()

    resp = await client.post(
        f"/api/imports/{started['import_id']}/commit", params={"workspace_id": ws}
    )
    assert resp.status_code == 409


async def test_wrong_content_type_rejected(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("app.imports.router.extract_lines", lambda b: ["строка выписки"])
    ws, acc = await _setup(client, ALICE)
    resp = await client.post(
        "/api/imports",
        params={"workspace_id": ws, "account_id": acc},
        files={"file": ("statement.txt", b"hello", "text/plain")},
    )
    assert resp.status_code == 415


async def test_too_large_rejected(client: AsyncClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("app.imports.router.MAX_UPLOAD_BYTES", 4)
    ws, acc = await _setup(client, ALICE)
    resp = await client.post(
        "/api/imports",
        params={"workspace_id": ws, "account_id": acc},
        files={"file": ("statement.pdf", b"%PDF-too-big", "application/pdf")},
    )
    assert resp.status_code == 413


async def test_unknown_account_rejected(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("app.imports.router.extract_lines", lambda b: ["строка выписки"])
    ws, _ = await _setup(client, ALICE)
    resp = await client.post(
        "/api/imports",
        params={"workspace_id": ws, "account_id": str(uuid.uuid4())},
        files=FILES,
    )
    assert resp.status_code == 404
