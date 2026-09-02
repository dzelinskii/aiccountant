import json
import uuid

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession
from structlog.testing import capture_logs

from app.imports import service
from app.imports.models import Import
from app.imports.parser import StatementParseError
from app.imports.schemas import MAX_PARSED_OPERATIONS

ALICE = {"email": "alice@example.com", "password": "password123"}
BOB = {"email": "bob@example.com", "password": "password123"}

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


async def test_collector_import_is_listed_as_pending(client: AsyncClient) -> None:
    """Импорт от коллектора приходит без участия браузера — увидеть и подтвердить
    его можно только через список ожидающих."""
    ws, acc = await _ws_and_account(client)
    started = await client.post(
        "/api/imports/parsed",
        params={"workspace_id": ws, "account_id": acc},
        json={"parser": "tbank_collector", "operations": OPS},
    )

    pending = await client.get("/api/imports", params={"workspace_id": ws})
    assert pending.status_code == 200
    items = pending.json()
    assert len(items) == 1
    assert items[0]["import_id"] == started.json()["import_id"]
    assert items[0]["account_id"] == acc
    assert items[0]["status"] == "ready"
    assert items[0]["parser"] == "tbank_collector"
    assert items[0]["operations_count"] == 2


async def test_committed_import_leaves_pending_list(client: AsyncClient) -> None:
    ws, acc = await _ws_and_account(client)
    started = await client.post(
        "/api/imports/parsed",
        params={"workspace_id": ws, "account_id": acc},
        json={"parser": "tbank_collector", "operations": OPS},
    )
    await client.post(
        f"/api/imports/{started.json()['import_id']}/commit", params={"workspace_id": ws}
    )

    pending = await client.get("/api/imports", params={"workspace_id": ws})
    assert pending.json() == []  # подтверждённый импорт больше ничего не ждёт


async def test_pending_imports_isolated_between_workspaces(client: AsyncClient) -> None:
    ws_a, acc = await _ws_and_account(client)
    await client.post(
        "/api/imports/parsed",
        params={"workspace_id": ws_a, "account_id": acc},
        json={"parser": "tbank_collector", "operations": OPS},
    )

    client.cookies.clear()
    await client.post("/api/auth/register", json=BOB)
    me = await client.get("/api/me")
    ws_b = str(me.json()["workspaces"][0]["id"])

    assert (await client.get("/api/imports", params={"workspace_id": ws_b})).json() == []
    # и чужой workspace не отдаётся, даже если запросить его напрямую
    foreign = await client.get("/api/imports", params={"workspace_id": ws_a})
    assert foreign.status_code == 403


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


async def _commit(client: AsyncClient, ws: str, acc: str, operations: list[dict[str, str]]) -> None:
    started = await client.post(
        "/api/imports/parsed",
        params={"workspace_id": ws, "account_id": acc},
        json={"parser": "tbank_collector", "operations": operations},
    )
    assert started.status_code == 201
    committed = await client.post(
        f"/api/imports/{started.json()['import_id']}/commit", params={"workspace_id": ws}
    )
    assert committed.json()["imported"] == len(operations)


async def test_kind_reaches_transaction(client: AsyncClient) -> None:
    """Вид — факт от банка, и он должен пережить путь до транзакции: разбор
    лежит в JSONB между созданием импорта и подтверждением, и вид, не попавший
    в payload, потерялся бы там молча."""
    ws, acc = await _ws_and_account(client)
    await _commit(client, ws, acc, [{**OPS[0], "kind": "transfer_self"}])

    txns = (await client.get("/api/transactions", params={"workspace_id": ws})).json()
    assert [t["operation_kind"] for t in txns["items"]] == ["transfer_self"]


async def test_operation_without_kind_is_unknown(client: AsyncClient) -> None:
    """Поле необязательное: выписка из PDF классификации не даёт вовсе, да и
    коллектор старой версии его не шлёт — такой запрос валиден, вид unknown."""
    ws, acc = await _ws_and_account(client)
    await _commit(client, ws, acc, [OPS[0]])

    txns = (await client.get("/api/transactions", params={"workspace_id": ws})).json()
    assert [t["operation_kind"] for t in txns["items"]] == ["unknown"]


async def test_bank_own_kind_word_rejected(client: AsyncClient) -> None:
    """PAY — слово Т-Банка, а не наше: переводить свой словарь в общий обязан
    коннектор, и граница API это проверяет, а не принимает на веру."""
    ws, acc = await _ws_and_account(client)
    resp = await client.post(
        "/api/imports/parsed",
        params={"workspace_id": ws, "account_id": acc},
        json={"parser": "tbank_collector", "operations": [{**OPS[0], "kind": "PAY"}]},
    )
    assert resp.status_code == 422


async def _rewrite_payload_kinds(
    db_session: AsyncSession, import_id: str, kinds: list[str | None]
) -> None:
    """Подменить вид в сохранённом разборе — так к подтверждению приезжает payload,
    которого текущий код не пишет: с чужим словом (порча данных) или вовсе без
    ключа kind (импорт, созданный до его появления). None — убрать ключ."""
    imp = await db_session.get(Import, uuid.UUID(import_id))
    assert imp is not None
    assert isinstance(imp.parsed_payload, dict)
    payload = dict(imp.parsed_payload)
    raw_ops = payload["operations"]
    assert isinstance(raw_ops, list)
    operations: list[dict[str, object]] = []
    for raw_op, kind in zip(raw_ops, kinds, strict=True):
        op = dict(raw_op)
        op.pop("kind")
        if kind is not None:
            op["kind"] = kind
        operations.append(op)
    payload["operations"] = operations
    imp.parsed_payload = payload
    await db_session.commit()


async def test_unknown_kind_in_payload_becomes_unknown(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """Слово не из словаря могло попасть в JSONB только порчей данных. Ронять из-за
    одной строки весь импорт хуже, чем принять её: операция приезжает как unknown —
    в статистике она видна, а не пропала, как случилось бы при догадке в пользу
    transfer_self. Молча это не проходит: импорт с мусором виден в логе. Строка
    со знакомым видом рядом при этом доезжает как есть."""
    ws, acc = await _ws_and_account(client)
    started = await client.post(
        "/api/imports/parsed",
        params={"workspace_id": ws, "account_id": acc},
        json={"parser": "tbank_collector", "operations": OPS},
    )
    import_id = started.json()["import_id"]
    await _rewrite_payload_kinds(db_session, import_id, ["PAY", "income"])

    with capture_logs() as logs:
        committed = await client.post(
            f"/api/imports/{import_id}/commit", params={"workspace_id": ws}
        )
    assert committed.json()["imported"] == 2

    txns = (await client.get("/api/transactions", params={"workspace_id": ws})).json()
    assert {t["merchant"]: t["operation_kind"] for t in txns["items"]} == {
        "Кофейня": "unknown",
        "Зарплата": "income",
    }
    # по логу должно быть видно, какой импорт принёс мусор; самого значения там
    # нет намеренно — оно может оказаться куском данных выписки
    assert [e["import_id"] for e in logs if e["event"] == "import_unknown_operation_kind"] == [
        import_id
    ]


async def test_payload_without_kind_key_still_commits(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """Разбор импортов, созданных до появления вида, лежит в JSONB без ключа kind:
    подтверждать их нужно по-прежнему, операции получают unknown."""
    ws, acc = await _ws_and_account(client)
    started = await client.post(
        "/api/imports/parsed",
        params={"workspace_id": ws, "account_id": acc},
        json={"parser": "tbank_collector", "operations": OPS},
    )
    import_id = started.json()["import_id"]
    await _rewrite_payload_kinds(db_session, import_id, [None, None])

    committed = await client.post(f"/api/imports/{import_id}/commit", params={"workspace_id": ws})
    assert committed.status_code == 200
    assert committed.json()["imported"] == 2

    txns = (await client.get("/api/transactions", params={"workspace_id": ws})).json()
    assert [t["operation_kind"] for t in txns["items"]] == ["unknown", "unknown"]


async def test_empty_operations_rejected(client: AsyncClient) -> None:
    ws, acc = await _ws_and_account(client)
    resp = await client.post(
        "/api/imports/parsed",
        params={"workspace_id": ws, "account_id": acc},
        json={"parser": "tbank_collector", "operations": []},
    )
    assert resp.status_code == 422


async def test_float_amount_rejected(client: AsyncClient) -> None:
    """Число JSON вместо строки теряет разряды ещё до валидации — отвергаем на входе."""
    ws, acc = await _ws_and_account(client)
    resp = await client.post(
        "/api/imports/parsed",
        params={"workspace_id": ws, "account_id": acc},
        content=json.dumps(
            {
                "parser": "tbank_collector",
                "operations": [{**OPS[0], "amount": 12345678901234.5678}],
            }
        ),
        headers={"Content-Type": "application/json"},
    )
    assert resp.status_code == 422


async def test_too_many_operations_rejected(client: AsyncClient) -> None:
    ws, acc = await _ws_and_account(client)
    operations = [{**OPS[0], "external_id": f"op-{i}"} for i in range(MAX_PARSED_OPERATIONS + 1)]
    resp = await client.post(
        "/api/imports/parsed",
        params={"workspace_id": ws, "account_id": acc},
        json={"parser": "tbank_collector", "operations": operations},
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


async def test_currency_check_is_case_insensitive(client: AsyncClient) -> None:
    # AccountCreate регистр валюты не нормализует — счёт "rub" и операция "RUB"
    # это одна и та же валюта, а не повод для 422
    await client.post("/api/auth/register", json=ALICE)
    me = await client.get("/api/me")
    ws = str(me.json()["workspaces"][0]["id"])
    acc = (
        await client.post(
            "/api/accounts",
            params={"workspace_id": ws},
            json={"name": "Карта", "type": "card", "currency": "rub"},
        )
    ).json()["id"]

    resp = await client.post(
        "/api/imports/parsed",
        params={"workspace_id": ws, "account_id": acc},
        json={"parser": "tbank_collector", "operations": OPS},
    )
    assert resp.status_code == 201


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
    # префикс отделяет id банка от наших sha256-хешей (см. BANK_EXTERNAL_ID_PREFIX) —
    # инвариант держится и на длине поля в схеме, но здесь фиксируем сам факт
    assert imp.parsed_payload["external_ids"] == ["bank:bank-op-1", "bank:bank-op-2"]
    external_ids = imp.parsed_payload["external_ids"]
    assert isinstance(external_ids, list)
    payload = dict(imp.parsed_payload)
    payload["external_ids"] = external_ids[:1]  # укоротили — порча данных
    imp.parsed_payload = payload
    await db_session.commit()

    with pytest.raises(StatementParseError):
        await service.commit_from_import(db_session, uuid.UUID(ws), imp.id, uuid.uuid4())
