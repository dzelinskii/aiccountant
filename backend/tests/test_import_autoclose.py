"""Импорт из одних дублей закрывается сам; ожидающий импорт можно отклонить."""

import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from decimal import Decimal
from typing import Any

import pytest
from httpx import AsyncClient, Response
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from structlog.testing import capture_logs

from app.imports import repository, service
from app.imports.models import Import
from app.imports.parser import ParsedStatement, StatementParseError
from tests.fixtures import fixed_parse
from tests.test_import_async_service import SAMPLE

ALICE = {"email": "alice@example.com", "password": "password123"}
BOB = {"email": "bob@example.com", "password": "password123"}


def _op(external_id: str, amount: str = "-100.00") -> dict[str, str]:
    return {
        "occurred_at": "2026-09-01",
        "amount": amount,
        "currency": "RUB",
        "description": "Кофейня",
        "external_id": external_id,
    }


async def _ws_and_account(client: AsyncClient, creds: dict[str, str]) -> tuple[str, str]:
    await client.post("/api/auth/register", json=creds)
    me = await client.get("/api/me")
    ws = str(me.json()["workspaces"][0]["id"])
    account_id = (
        await client.post(
            "/api/accounts",
            params={"workspace_id": ws},
            json={"name": "Кредитка", "type": "card", "currency": "RUB"},
        )
    ).json()["id"]
    return ws, str(account_id)


async def _send(
    client: AsyncClient,
    ws: str,
    account_id: str,
    operations: list[dict[str, str]],
    account: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Коллектор прислал разбор — без подтверждения."""
    body: dict[str, Any] = {"parser": "tbank_collector", "operations": operations}
    if account is not None:
        body["account"] = account
    resp = await client.post(
        "/api/imports/parsed", params={"workspace_id": ws, "account_id": account_id}, json=body
    )
    assert resp.status_code == 201, resp.text
    result: dict[str, Any] = resp.json()
    return result


async def _commit(client: AsyncClient, ws: str, import_id: str) -> Response:
    return await client.post(f"/api/imports/{import_id}/commit", params={"workspace_id": ws})


async def _reject(client: AsyncClient, ws: str, import_id: str) -> Response:
    return await client.post(f"/api/imports/{import_id}/reject", params={"workspace_id": ws})


async def _status(client: AsyncClient, ws: str, import_id: str) -> dict[str, Any]:
    resp = await client.get(f"/api/imports/{import_id}", params={"workspace_id": ws})
    assert resp.status_code == 200
    result: dict[str, Any] = resp.json()
    return result


async def _pending_ids(client: AsyncClient, ws: str) -> list[str]:
    pending = (await client.get("/api/imports", params={"workspace_id": ws})).json()
    return [item["import_id"] for item in pending]


async def _account(client: AsyncClient, ws: str) -> dict[str, Any]:
    accounts: list[dict[str, Any]] = (
        await client.get("/api/accounts", params={"workspace_id": ws})
    ).json()
    return accounts[0]


@asynccontextmanager
async def _other_connection(database_url: str) -> AsyncIterator[Any]:
    """Своё соединение мимо сессии теста: HTTP-запросы в тестах идут через одну
    сессию, и незакоммиченное ею было бы видно им, но не базе."""
    engine = create_async_engine(database_url)
    try:
        async with engine.connect() as conn:
            yield conn
    finally:
        await engine.dispose()


async def _stored(database_url: str, import_id: str) -> tuple[str, bool]:
    """Статус и «разбор стёрт (SQL NULL)» — как они записаны в базе."""
    async with _other_connection(database_url) as conn:
        row = (
            await conn.execute(
                text("SELECT status, parsed_payload IS NULL FROM imports WHERE id = :id"),
                {"id": uuid.UUID(import_id)},
            )
        ).one()
    return str(row[0]), bool(row[1])


async def _stale_copy(db_session: AsyncSession, import_id: str) -> Import:
    """Готовый импорт с тем же разбором, что у подтверждённого, — как те, что
    копились до автозакрытия."""
    source = await db_session.get(Import, uuid.UUID(import_id))
    assert source is not None and source.parsed_payload is not None
    stale = Import(
        workspace_id=source.workspace_id,
        account_id=source.account_id,
        file_name="tbank_collector.json",
        bank_profile="tbank_collector",
        parser="tbank_collector",
        status="ready",
        stats={},
        created_by=source.created_by,
        parsed_payload=dict(source.parsed_payload),
    )
    db_session.add(stale)
    await db_session.commit()
    return stale


async def _transactions_total(client: AsyncClient, ws: str) -> int:
    txns = (await client.get("/api/transactions", params={"workspace_id": ws})).json()
    total: int = txns["total"]
    return total


# --- закрывается сам ---


async def test_collector_import_of_duplicates_closes_itself(
    client: AsyncClient, database_url: str
) -> None:
    """Повторный сбор, где всё дубли: в ожидающих не остаётся, а остаток и лимит
    из него доезжают до счёта — ради этого прежде и не хватало подтверждения."""
    ws, acc = await _ws_and_account(client, ALICE)
    first = await _send(client, ws, acc, [_op("op-1")], {"balance": "-100.00"})
    assert (await _commit(client, ws, first["import_id"])).status_code == 200

    again = await _send(
        client,
        ws,
        acc,
        [_op("op-1")],
        {"balance": "-2000.47", "credit_limit": "142000.00", "card_masks": ["1234"]},
    )

    assert again["status"] == "completed"
    # закрытие записано в базу, а не только видно сессии, через которую идут запросы
    assert (await _stored(database_url, again["import_id"]))[0] == "completed"
    assert await _pending_ids(client, ws) == []
    account = await _account(client, ws)
    assert Decimal(account["balance"]) == Decimal("-2000.47")
    assert Decimal(account["credit_limit"]) == Decimal("142000.00")
    assert account["card_masks"] == ["1234"]
    assert await _transactions_total(client, ws) == 1
    # повторный commit отвечает сохранёнными числами закрытия
    result = (await _commit(client, ws, again["import_id"])).json()
    assert (result["imported"], result["duplicates"]) == (0, 1)


async def test_import_with_new_operations_waits(client: AsyncClient) -> None:
    ws, acc = await _ws_and_account(client, ALICE)
    first = await _send(client, ws, acc, [_op("op-1")])
    await _commit(client, ws, first["import_id"])

    # один дубль и одна новая: решать человеку
    mixed = await _send(client, ws, acc, [_op("op-1"), _op("op-2")], {"balance": "5.00"})

    assert mixed["status"] == "ready"
    assert await _pending_ids(client, ws) == [mixed["import_id"]]
    assert (await _account(client, ws))["reported_at"] is None


async def test_statement_of_duplicates_closes_itself(
    client: AsyncClient, db_session: AsyncSession, database_url: str
) -> None:
    """Та же выписка второй раз: разбор кончился — и ждать нечего."""
    ws, acc = await _ws_and_account(client, ALICE)
    user_id = uuid.UUID((await client.get("/api/me")).json()["id"])

    async def _upload() -> uuid.UUID:
        imp = await service.start_import(
            db_session, uuid.UUID(ws), uuid.UUID(acc), user_id, "s.pdf", ["текст"]
        )
        await service.run_parse(db_session, imp.id, parse=fixed_parse(SAMPLE, "tbank_statement"))
        return imp.id

    first = await _upload()
    assert (await _status(client, ws, str(first)))["status"] == "ready"
    await _commit(client, ws, str(first))

    second = await _upload()

    assert (await _stored(database_url, str(second)))[0] == "completed"
    assert await _pending_ids(client, ws) == []
    assert await _transactions_total(client, ws) == 2


async def test_neighbour_commit_closes_import_left_with_duplicates(
    client: AsyncClient, database_url: str
) -> None:
    """Два сбора за пересекающийся период ждут оба; подтвердили свежий —
    в старом новых не осталось, и он закрывается, не откатывая остаток."""
    ws, acc = await _ws_and_account(client, ALICE)
    older = await _send(client, ws, acc, [_op("op-1")], {"balance": "-100.00"})
    newer = await _send(client, ws, acc, [_op("op-1"), _op("op-2")], {"balance": "-300.00"})
    assert older["status"] == newer["status"] == "ready"

    await _commit(client, ws, newer["import_id"])

    assert (await _stored(database_url, older["import_id"]))[0] == "completed"
    assert await _pending_ids(client, ws) == []
    # старый сбор закрылся позже, но остаток назад по времени не поехал
    assert Decimal((await _account(client, ws))["balance"]) == Decimal("-300.00")
    assert await _transactions_total(client, ws) == 2


async def test_next_collection_sweeps_accumulated(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """Импорты из дублей, накопившиеся до автозакрытия, прибирает ближайший сбор
    по тому же счёту — даже если сам он с новыми операциями и остаётся ждать."""
    ws, acc = await _ws_and_account(client, ALICE)
    first = await _send(client, ws, acc, [_op("op-1")])
    await _commit(client, ws, first["import_id"])
    stale = await _stale_copy(db_session, first["import_id"])

    fresh = await _send(client, ws, acc, [_op("op-2")])

    assert await _pending_ids(client, ws) == [fresh["import_id"]]
    assert (await _status(client, ws, str(stale.id)))["status"] == "completed"


async def test_broken_neighbour_is_skipped_not_fatal(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """Испорченный разбор соседа не роняет подтверждение человека: сосед остаётся
    ждать, и это видно в логе."""
    ws, acc = await _ws_and_account(client, ALICE)
    broken = await _send(client, ws, acc, [_op("op-1")])
    good = await _send(client, ws, acc, [_op("op-2")])
    row = await db_session.get(Import, uuid.UUID(broken["import_id"]))
    assert row is not None
    row.parsed_payload = {"operations": "испорчено"}
    await db_session.commit()

    with capture_logs() as logs:
        resp = await _commit(client, ws, good["import_id"])

    assert resp.status_code == 200
    assert await _pending_ids(client, ws) == [broken["import_id"]]
    assert any(e["event"] == "import_autoclose_broken_payload" for e in logs)


# --- отклонение ---


async def test_reject_removes_from_pending_without_effects(
    client: AsyncClient, database_url: str
) -> None:
    ws, acc = await _ws_and_account(client, ALICE)
    imp = await _send(
        client, ws, acc, [_op("op-1")], {"balance": "-2000.47", "credit_limit": "142000.00"}
    )

    resp = await _reject(client, ws, imp["import_id"])

    assert resp.status_code == 204
    assert await _pending_ids(client, ws) == []
    assert (await _status(client, ws, imp["import_id"]))["status"] == "rejected"
    assert await _transactions_total(client, ws) == 0
    account = await _account(client, ws)
    assert account["reported_at"] is None
    assert account["credit_limit"] is None
    # операции выписки больше не нужны ни для чего — не храним; и стёрты они
    # именно в SQL NULL, а не в JSON-значение null
    assert await _stored(database_url, imp["import_id"]) == ("rejected", True)


async def test_reject_twice_is_same_outcome(client: AsyncClient) -> None:
    ws, acc = await _ws_and_account(client, ALICE)
    imp = await _send(client, ws, acc, [_op("op-1")])
    await _reject(client, ws, imp["import_id"])

    assert (await _reject(client, ws, imp["import_id"])).status_code == 204


async def test_reject_foreign_workspace_is_404(client: AsyncClient, database_url: str) -> None:
    """Чужой импорт неотличим от несуществующего и остаётся нетронутым."""
    alice_ws, alice_acc = await _ws_and_account(client, ALICE)
    imp = await _send(client, alice_ws, alice_acc, [_op("op-1")])
    client.cookies.clear()
    bob_ws, _ = await _ws_and_account(client, BOB)

    foreign = await _reject(client, bob_ws, imp["import_id"])
    missing = await _reject(client, bob_ws, str(uuid.uuid4()))

    assert foreign.status_code == missing.status_code == 404
    assert foreign.json()["detail"] == missing.json()["detail"]
    assert await _stored(database_url, imp["import_id"]) == ("ready", False)


async def test_reject_committed_is_refused(client: AsyncClient) -> None:
    ws, acc = await _ws_and_account(client, ALICE)
    imp = await _send(client, ws, acc, [_op("op-1")])
    await _commit(client, ws, imp["import_id"])

    resp = await _reject(client, ws, imp["import_id"])

    assert resp.status_code == 409
    assert (await _status(client, ws, imp["import_id"]))["status"] == "completed"


async def test_commit_rejected_is_refused(client: AsyncClient) -> None:
    ws, acc = await _ws_and_account(client, ALICE)
    imp = await _send(client, ws, acc, [_op("op-1")], {"balance": "-100.00"})
    await _reject(client, ws, imp["import_id"])

    resp = await _commit(client, ws, imp["import_id"])

    assert resp.status_code == 409
    assert await _transactions_total(client, ws) == 0
    assert (await _account(client, ws))["reported_at"] is None


async def test_reject_unfinished_or_failed_is_refused(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """Отклонять можно только то, что ждёт решения: разбираемый ещё не показан
    человеку, упавшему отклонять нечего."""
    ws, acc = await _ws_and_account(client, ALICE)
    user_id = uuid.UUID((await client.get("/api/me")).json()["id"])

    async def _boom(lines: list[str]) -> tuple[ParsedStatement, str]:
        raise StatementParseError("не разобрали")

    processing = await service.start_import(
        db_session, uuid.UUID(ws), uuid.UUID(acc), user_id, "s.pdf", ["текст"]
    )
    failed = await service.start_import(
        db_session, uuid.UUID(ws), uuid.UUID(acc), user_id, "s.pdf", ["текст"]
    )
    await service.run_parse(db_session, failed.id, parse=_boom)

    assert (await _reject(client, ws, str(processing.id))).status_code == 409
    assert (await _reject(client, ws, str(failed.id))).status_code == 409


# --- границы прохода ---


async def _second_account(client: AsyncClient, ws: str) -> str:
    resp = await client.post(
        "/api/accounts",
        params={"workspace_id": ws},
        json={"name": "Дебетовая", "type": "card", "currency": "RUB"},
    )
    return str(resp.json()["id"])


async def test_sweep_stays_in_its_workspace(
    client: AsyncClient, db_session: AsyncSession, database_url: str
) -> None:
    """Проход с чужим workspace не трогает импорты счёта, даже если идентификатор
    счёта ему передали."""
    alice_ws, _ = await _ws_and_account(client, ALICE)
    client.cookies.clear()
    bob_ws, bob_acc = await _ws_and_account(client, BOB)
    first = await _send(client, bob_ws, bob_acc, [_op("op-1")])
    await _commit(client, bob_ws, first["import_id"])
    stale = await _stale_copy(db_session, first["import_id"])

    closed = await service.close_duplicate_only_imports(
        db_session, uuid.UUID(alice_ws), uuid.UUID(bob_acc)
    )

    assert closed == set()
    assert (await _stored(database_url, str(stale.id)))[0] == "ready"


async def test_sweep_stays_on_its_account(
    client: AsyncClient, db_session: AsyncSession, database_url: str
) -> None:
    """Сбор по одному счёту прибирает только его импорты."""
    ws, acc = await _ws_and_account(client, ALICE)
    other = await _second_account(client, ws)
    first = await _send(client, ws, other, [_op("op-1")])
    await _commit(client, ws, first["import_id"])
    stale = await _stale_copy(db_session, first["import_id"])

    await _send(client, ws, acc, [_op("op-9")])

    assert (await _stored(database_url, str(stale.id)))[0] == "ready"


async def test_decisions_lock_the_row(
    client: AsyncClient, db_session: AsyncSession, database_url: str
) -> None:
    """Подтверждение, отклонение и автозакрытие решают по статусу под
    блокировкой: пока она держится, второе соединение строку не возьмёт."""
    ws, acc = await _ws_and_account(client, ALICE)
    imp = await _send(client, ws, acc, [_op("op-1")])
    lock_check = text("SELECT id FROM imports WHERE id = :id FOR UPDATE NOWAIT")
    params = {"id": uuid.UUID(imp["import_id"])}

    for take_lock in (
        repository.lock_import(db_session, uuid.UUID(ws), uuid.UUID(imp["import_id"])),
        repository.lock_ready_for_account(db_session, uuid.UUID(ws), uuid.UUID(acc)),
    ):
        await take_lock
        try:
            async with _other_connection(database_url) as conn:
                with pytest.raises(DBAPIError):
                    await conn.execute(lock_check, params)
        finally:
            await db_session.rollback()


# --- сбой прохода ---


async def _failing_sweep(*_args: object) -> set[uuid.UUID]:
    raise RuntimeError("тупик")


async def test_sweep_failure_does_not_fail_commit(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Операции записаны — человек не должен увидеть «не удалось» из-за соседей."""
    ws, acc = await _ws_and_account(client, ALICE)
    imp = await _send(client, ws, acc, [_op("op-1")])
    monkeypatch.setattr(service, "_close_duplicate_only_imports", _failing_sweep)

    with capture_logs() as logs:
        resp = await _commit(client, ws, imp["import_id"])

    assert resp.status_code == 200
    assert resp.json()["imported"] == 1
    assert await _transactions_total(client, ws) == 1
    assert any(e["event"] == "import_autoclose_failed" for e in logs)


async def test_sweep_failure_does_not_fail_collector(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Импорт создан — коллектор получает ответ про него, а не 500."""
    ws, acc = await _ws_and_account(client, ALICE)
    monkeypatch.setattr(service, "_close_duplicate_only_imports", _failing_sweep)

    imp = await _send(client, ws, acc, [_op("op-1")])

    assert imp["status"] == "ready"
    assert await _pending_ids(client, ws) == [imp["import_id"]]


async def test_sweep_failure_does_not_fail_parse(
    client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws, acc = await _ws_and_account(client, ALICE)
    user_id = uuid.UUID((await client.get("/api/me")).json()["id"])
    imp = await service.start_import(
        db_session, uuid.UUID(ws), uuid.UUID(acc), user_id, "s.pdf", ["текст"]
    )
    monkeypatch.setattr(service, "_close_duplicate_only_imports", _failing_sweep)

    await service.run_parse(db_session, imp.id, parse=fixed_parse(SAMPLE, "tbank_statement"))

    assert (await _status(client, ws, str(imp.id)))["status"] == "ready"


# --- без операций ---


async def test_import_without_operations_delivers_balance(
    client: AsyncClient, database_url: str
) -> None:
    """Счёт без движения за период — и кредит, у которого истории нет вовсе, —
    получает остаток таким импортом: подтверждать в нём нечего, он закрывается сам."""
    ws, acc = await _ws_and_account(client, ALICE)

    imp = await _send(client, ws, acc, [], {"balance": "-472680.39"})

    assert imp["status"] == "completed"
    assert (await _stored(database_url, imp["import_id"]))[0] == "completed"
    assert await _pending_ids(client, ws) == []
    assert Decimal((await _account(client, ws))["balance"]) == Decimal("-472680.39")
    assert await _transactions_total(client, ws) == 0
    result = (await _commit(client, ws, imp["import_id"])).json()
    assert (result["imported"], result["duplicates"]) == (0, 0)


async def test_import_without_operations_and_account_rejected(client: AsyncClient) -> None:
    """Без блока счёта в пустом импорте нечего ни подтверждать, ни применять."""
    ws, acc = await _ws_and_account(client, ALICE)
    bodies: list[dict[str, Any]] = [
        {"parser": "tbank_collector", "operations": []},
        {"parser": "tbank_collector", "operations": [], "account": None},
        # блок без остатка — не блок: остаток в нём обязателен
        {"parser": "tbank_collector", "operations": [], "account": {}},
    ]
    for body in bodies:
        resp = await client.post(
            "/api/imports/parsed", params={"workspace_id": ws, "account_id": acc}, json=body
        )
        assert resp.status_code == 422, body
    assert await _pending_ids(client, ws) == []


async def test_import_without_operations_to_foreign_account_not_found(
    client: AsyncClient,
) -> None:
    """Проверка счёта не держится на операциях: без них остаток чужому счёту
    не применится, а ответ неотличим от «счёта нет»."""
    alice_ws, alice_acc = await _ws_and_account(client, ALICE)
    client.cookies.clear()
    bob_ws, _ = await _ws_and_account(client, BOB)
    body = {"parser": "tbank_collector", "operations": [], "account": {"balance": "-1.00"}}

    responses = [
        await client.post(
            "/api/imports/parsed", params={"workspace_id": bob_ws, "account_id": target}, json=body
        )
        for target in (alice_acc, str(uuid.uuid4()))
    ]

    assert [r.status_code for r in responses] == [404, 404]
    assert responses[0].json()["detail"] == responses[1].json()["detail"]
    assert await _pending_ids(client, bob_ws) == []
    client.cookies.clear()
    assert (await client.post("/api/auth/login", json=ALICE)).status_code == 200
    assert Decimal((await _account(client, alice_ws))["balance"]) == 0


async def test_import_without_operations_waits_and_commits_by_hand(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Проход автозакрытия сорвался — пустой импорт остаётся ждать следующего
    прохода по счёту, и ручки на нём не ломаются: список и превью отвечают
    нулями, подтверждение применяет остаток. На экране человек его не
    подтвердит — кнопка гаснет при нуле новых, — только отклонит."""
    ws, acc = await _ws_and_account(client, ALICE)
    monkeypatch.setattr(service, "_close_duplicate_only_imports", _failing_sweep)

    imp = await _send(client, ws, acc, [], {"balance": "-472680.39"})

    assert imp["status"] == "ready"
    pending = (await client.get("/api/imports", params={"workspace_id": ws})).json()
    assert [item["operations_count"] for item in pending] == [0]
    preview = (await _status(client, ws, imp["import_id"]))["preview"]
    assert (preview["new_count"], preview["duplicate_count"]) == (0, 0)
    resp = await _commit(client, ws, imp["import_id"])
    assert resp.status_code == 200
    assert Decimal((await _account(client, ws))["balance"]) == Decimal("-472680.39")
