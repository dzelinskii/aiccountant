import uuid

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.imports import service
from app.imports.models import Import
from app.imports.parser import StatementParseError

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
    assert resp.status_code == 201  # создан ресурс, а не поставлен в фоновую очередь (202)
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


async def test_settled_amount_change_is_still_a_duplicate(client: AsyncClient) -> None:
    """Ради этого и заводили id банка: холд провёлся с другой суммой — операция та же."""
    ws, acc = await _ws_and_account(client)
    first = await client.post(
        "/api/imports/parsed",
        params={"workspace_id": ws, "account_id": acc},
        json={
            "parser": "tbank_collector",
            "operations": [{**OPS[0], "amount": "-1150.00", "external_id": "bank-op-1"}],
        },
    )
    await client.post(
        f"/api/imports/{first.json()['import_id']}/commit", params={"workspace_id": ws}
    )

    second = await client.post(
        "/api/imports/parsed",
        params={"workspace_id": ws, "account_id": acc},
        json={
            "parser": "tbank_collector",
            "operations": [{**OPS[0], "amount": "-1150.12", "external_id": "bank-op-1"}],
        },
    )
    again = await client.post(
        f"/api/imports/{second.json()['import_id']}/commit", params={"workspace_id": ws}
    )
    assert again.json()["imported"] == 0
    assert again.json()["duplicates"] == 1


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


async def test_zero_amount_rejected(client: AsyncClient) -> None:
    # банки штатно шлют 0.00 (проверочные холды, отмены) — в ledger это запрещённый
    # знак (SignMismatchError); отклонять нужно на входе, а не 500-кой на коммите
    ws, acc = await _ws_and_account(client)
    resp = await client.post(
        "/api/imports/parsed",
        params={"workspace_id": ws, "account_id": acc},
        json={"parser": "tbank_collector", "operations": [{**OPS[0], "amount": "0.00"}]},
    )
    assert resp.status_code == 422


async def test_overflow_amount_rejected(client: AsyncClient) -> None:
    # больше NUMERIC(20,4) в ledger — без проверки на входе это DBAPIError на вставке
    ws, acc = await _ws_and_account(client)
    resp = await client.post(
        "/api/imports/parsed",
        params={"workspace_id": ws, "account_id": acc},
        json={"parser": "tbank_collector", "operations": [{**OPS[0], "amount": "1E+30"}]},
    )
    assert resp.status_code == 422


async def test_control_char_in_description_rejected(client: AsyncClient) -> None:
    ws, acc = await _ws_and_account(client)
    resp = await client.post(
        "/api/imports/parsed",
        params={"workspace_id": ws, "account_id": acc},
        json={
            "parser": "tbank_collector",
            "operations": [{**OPS[0], "description": "Кофейня\x00"}],
        },
    )
    assert resp.status_code == 422


async def test_control_char_in_external_id_rejected(client: AsyncClient) -> None:
    ws, acc = await _ws_and_account(client)
    resp = await client.post(
        "/api/imports/parsed",
        params={"workspace_id": ws, "account_id": acc},
        json={
            "parser": "tbank_collector",
            "operations": [{**OPS[0], "external_id": "bank-op-1\x00"}],
        },
    )
    assert resp.status_code == 422


async def test_duplicate_external_id_in_request_rejected(client: AsyncClient) -> None:
    # одинаковые id в одном запросе — payload машинный, значит это баг коллектора,
    # а не законный ввод: без проверки вторая операция молча теряется как "дубль"
    ws, acc = await _ws_and_account(client)
    dup_ops = [
        {**OPS[0], "external_id": "same-id"},
        {**OPS[1], "external_id": "same-id"},
    ]
    resp = await client.post(
        "/api/imports/parsed",
        params={"workspace_id": ws, "account_id": acc},
        json={"parser": "tbank_collector", "operations": dup_ops},
    )
    assert resp.status_code == 422


async def test_invalid_parser_name_rejected(client: AsyncClient) -> None:
    # parser уезжает в file_name/bank_profile и в бейдж на фронте — не произвольная строка
    ws, acc = await _ws_and_account(client)
    resp = await client.post(
        "/api/imports/parsed",
        params={"workspace_id": ws, "account_id": acc},
        json={"parser": "T-Bank Collector!", "operations": OPS},
    )
    assert resp.status_code == 422


async def test_currency_mismatch_rejected(client: AsyncClient) -> None:
    # счёт в RUB, операция в USD — иначе превью в USD, а транзакция в RUB
    ws, acc = await _ws_and_account(client)
    resp = await client.post(
        "/api/imports/parsed",
        params={"workspace_id": ws, "account_id": acc},
        json={"parser": "tbank_collector", "operations": [{**OPS[0], "currency": "USD"}]},
    )
    assert resp.status_code == 422


async def test_corrupted_external_ids_raises(client: AsyncClient, db_session: AsyncSession) -> None:
    """external_ids в payload пишем сами (create_parsed_import) — несовпадение длины
    с operations означает порчу данных и должно падать явно, а не тихо
    откатываться на хеш (как порча остального parsed_payload в _payload_to_statement)."""
    ws, acc = await _ws_and_account(client)
    started = await client.post(
        "/api/imports/parsed",
        params={"workspace_id": ws, "account_id": acc},
        json={"parser": "tbank_collector", "operations": OPS},
    )
    imp = await db_session.get(Import, uuid.UUID(started.json()["import_id"]))
    assert imp is not None
    assert isinstance(imp.parsed_payload, dict)
    external_ids = imp.parsed_payload["external_ids"]
    assert isinstance(external_ids, list)
    payload = dict(imp.parsed_payload)
    payload["external_ids"] = external_ids[:1]  # укоротили — порча данных
    imp.parsed_payload = payload
    await db_session.commit()

    with pytest.raises(StatementParseError):
        await service.commit_from_import(db_session, uuid.UUID(ws), imp.id, uuid.uuid4())
