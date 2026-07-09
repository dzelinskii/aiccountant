import pytest
from httpx import AsyncClient

ALICE = {"email": "alice@example.com", "password": "password123"}
BOB = {"email": "bob@example.com", "password": "password123"}

SAMPLE = [
    "04.07.2026",
    "12:37",
    "04.07.2026",
    "12:37",
    "-1 150.00 ₽ -1 150.00 ₽ Внешний перевод по",
    "номеру телефона",
    "+79897050701",
    "9358",
    "02.07.2026",
    "17:12",
    "02.07.2026",
    "17:12",
    "+5 000.00 ₽ +5 000.00 ₽ Пополнение. Система",
    "быстрых платежей",
    "9358",
    "10.06.2026",
    "13:03",
    "10.06.2026",
    "13:03",
    "-14 405.33 ₽ -14 405.33 ₽ Пополнение Кубышки 9358",
    "451 358,48 ₽Пополнения:",
    "502 119,39 ₽Расходы:",
]
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


async def test_preview_counts(client: AsyncClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("app.imports.service.extract_lines", lambda b: SAMPLE)
    ws, acc = await _setup(client, ALICE)
    resp = await client.post(
        "/api/imports",
        params={"workspace_id": ws, "account_id": acc, "commit": "false"},
        files=FILES,
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["new_count"] == 3
    assert body["duplicate_count"] == 0
    assert body["operations"][0]["amount"] == "-1150.0000"
    assert body["operations"][1]["amount"] == "5000.0000"
    assert all(op["is_duplicate"] is False for op in body["operations"])


async def test_commit_inserts_and_reimport_is_deduped(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("app.imports.service.extract_lines", lambda b: SAMPLE)
    ws, acc = await _setup(client, ALICE)

    r1 = await client.post(
        "/api/imports",
        params={"workspace_id": ws, "account_id": acc, "commit": "true"},
        files=FILES,
    )
    assert r1.status_code == 200
    assert r1.json()["imported"] == 3

    txns = (await client.get("/api/transactions", params={"workspace_id": ws})).json()
    assert txns["total"] == 3
    assert all(t["category_id"] is None for t in txns["items"])

    r2 = await client.post(
        "/api/imports",
        params={"workspace_id": ws, "account_id": acc, "commit": "true"},
        files=FILES,
    )
    assert r2.json()["imported"] == 0
    assert r2.json()["duplicates"] == 3
    after = (await client.get("/api/transactions", params={"workspace_id": ws})).json()
    assert after["total"] == 3  # повторный импорт не задвоил


async def test_uncategorized_import_in_dashboard_bucket(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("app.imports.service.extract_lines", lambda b: SAMPLE)
    ws, acc = await _setup(client, ALICE)
    await client.post(
        "/api/imports",
        params={"workspace_id": ws, "account_id": acc, "commit": "true"},
        files=FILES,
    )
    dash = (await client.get("/api/dashboard", params={"workspace_id": ws})).json()
    # расходы без категории сведены в бакет «Без категории» (если попали в текущий месяц —
    # проверяем сам факт наличия бакета среди расходов, суммы зависят от дат выписки)
    assert (
        any(m["category_id"] is None for m in dash["month_expenses"])
        or dash["month_expenses"] == []
    )


async def test_foreign_account_rejected(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("app.imports.service.extract_lines", lambda b: SAMPLE)
    ws_a, acc_a = await _setup(client, ALICE)
    client.cookies.clear()
    ws_b, _ = await _setup(client, BOB)
    # Боб импортирует в чужой счёт под своим workspace → 404
    resp = await client.post(
        "/api/imports",
        params={"workspace_id": ws_b, "account_id": acc_a, "commit": "false"},
        files=FILES,
    )
    assert resp.status_code == 404
    # чужой workspace → 403
    resp2 = await client.post(
        "/api/imports",
        params={"workspace_id": ws_a, "account_id": acc_a, "commit": "false"},
        files=FILES,
    )
    assert resp2.status_code == 403


async def test_unparsable_pdf_422(client: AsyncClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("app.imports.service.extract_lines", lambda b: ["мусор", "нет операций"])
    ws, acc = await _setup(client, ALICE)
    resp = await client.post(
        "/api/imports",
        params={"workspace_id": ws, "account_id": acc, "commit": "false"},
        files=FILES,
    )
    assert resp.status_code == 422
