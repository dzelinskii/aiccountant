import uuid

from httpx import AsyncClient

ALICE = {"email": "alice@example.com", "password": "password123"}

OPS = [
    {
        "occurred_at": "2026-07-05",
        "amount": "-1150.00",
        "currency": "RUB",
        "description": "Кофейня",
        "external_id": "bank-op-1",
    },
    {
        "occurred_at": "2026-07-06",
        "amount": "5000.00",
        "currency": "RUB",
        "description": "Зарплата",
        "external_id": "bank-op-2",
    },
]


async def _ws_and_account(client: AsyncClient) -> tuple[str, str]:
    await client.post("/api/auth/register", json=ALICE)
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


async def test_parsed_import_is_ready_immediately(client: AsyncClient) -> None:
    ws, acc = await _ws_and_account(client)
    resp = await client.post(
        "/api/imports/parsed",
        params={"workspace_id": ws, "account_id": acc},
        json={"parser": "tbank_collector", "operations": OPS},
    )
    assert resp.status_code == 200
    import_id = resp.json()["import_id"]
    assert resp.json()["status"] == "ready"

    status = await client.get(f"/api/imports/{import_id}", params={"workspace_id": ws})
    body = status.json()
    assert body["status"] == "ready"
    assert body["parser"] == "tbank_collector"
    assert body["preview"]["new_count"] == 2


async def test_commit_uses_bank_external_id_for_dedup(client: AsyncClient) -> None:
    ws, acc = await _ws_and_account(client)
    first = await client.post(
        "/api/imports/parsed",
        params={"workspace_id": ws, "account_id": acc},
        json={"parser": "tbank_collector", "operations": OPS},
    )
    committed = await client.post(
        f"/api/imports/{first.json()['import_id']}/commit", params={"workspace_id": ws}
    )
    assert committed.json()["imported"] == 2

    # тот же набор второй раз: дедуп по external_id от банка, ничего не создаём
    second = await client.post(
        "/api/imports/parsed",
        params={"workspace_id": ws, "account_id": acc},
        json={"parser": "tbank_collector", "operations": OPS},
    )
    again = await client.post(
        f"/api/imports/{second.json()['import_id']}/commit", params={"workspace_id": ws}
    )
    assert again.json()["imported"] == 0
    assert again.json()["duplicates"] == 2


async def test_second_import_preview_marks_duplicates(client: AsyncClient) -> None:
    """Дедуп виден уже в превью, до подтверждения."""
    ws, acc = await _ws_and_account(client)
    first = await client.post(
        "/api/imports/parsed",
        params={"workspace_id": ws, "account_id": acc},
        json={"parser": "tbank_collector", "operations": OPS},
    )
    await client.post(
        f"/api/imports/{first.json()['import_id']}/commit", params={"workspace_id": ws}
    )
    second = await client.post(
        "/api/imports/parsed",
        params={"workspace_id": ws, "account_id": acc},
        json={"parser": "tbank_collector", "operations": OPS},
    )
    status = await client.get(
        f"/api/imports/{second.json()['import_id']}", params={"workspace_id": ws}
    )
    assert status.json()["preview"]["new_count"] == 0
    assert status.json()["preview"]["duplicate_count"] == 2


async def test_amounts_survive_round_trip(client: AsyncClient) -> None:
    """Суммы не должны терять точность: строка на входе — строка на выходе."""
    ws, acc = await _ws_and_account(client)
    resp = await client.post(
        "/api/imports/parsed",
        params={"workspace_id": ws, "account_id": acc},
        json={
            "parser": "tbank_collector",
            "operations": [{**OPS[0], "amount": "-1234.5678", "external_id": "op-precise"}],
        },
    )
    status = await client.get(
        f"/api/imports/{resp.json()['import_id']}", params={"workspace_id": ws}
    )
    assert status.json()["preview"]["operations"][0]["amount"] == "-1234.5678"


async def test_empty_operations_rejected(client: AsyncClient) -> None:
    ws, acc = await _ws_and_account(client)
    resp = await client.post(
        "/api/imports/parsed",
        params={"workspace_id": ws, "account_id": acc},
        json={"parser": "tbank_collector", "operations": []},
    )
    assert resp.status_code == 422


async def test_foreign_account_rejected(client: AsyncClient) -> None:
    ws, _ = await _ws_and_account(client)
    resp = await client.post(
        "/api/imports/parsed",
        params={"workspace_id": ws, "account_id": str(uuid.uuid4())},
        json={"parser": "tbank_collector", "operations": OPS},
    )
    assert resp.status_code == 404
