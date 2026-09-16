import json
import uuid
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

from httpx import AsyncClient, Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from structlog.testing import capture_logs

from app.ledger import repository as ledger_repository
from app.ledger.balance import credit_available
from app.ledger.models import CreditLimitObservation

ALICE = {"email": "alice@example.com", "password": "password123"}

MOMENT = datetime(2026, 9, 15, 10, 0, tzinfo=UTC)
LATER = MOMENT + timedelta(hours=1)


# --- правило «доступно к трате» ---


def test_available_is_limit_plus_balance() -> None:
    # остаток кредитки — чистая позиция, при долге отрицательная
    assert credit_available(Decimal("150000.00"), MOMENT, Decimal("-148063.81"), MOMENT) == Decimal(
        "1936.19"
    )


def test_available_needs_one_moment() -> None:
    """Главное правило: лимит и остаток обязаны быть замечены одним сбором.

    Иначе свежий остаток сложился бы со старым лимитом — подняли лимит, а в
    ответе банка его в этот раз не было, — и вышло бы достоверно выглядящее
    неверное число. Без этой проверки вся конструкция бессмысленна.
    """
    assert credit_available(Decimal("142000.00"), MOMENT, Decimal("-2000.47"), LATER) is None


def test_available_absent_without_limit_or_balance() -> None:
    assert credit_available(None, None, Decimal("-2000.47"), MOMENT) is None
    assert credit_available(Decimal("142000.00"), MOMENT, None, None) is None


def test_available_goes_negative_over_limit() -> None:
    """Лимит снизили ниже долга — «доступно» отрицательное. Это факт, а не ошибка
    расчёта: обрезав его до нуля, мы спрятали бы перерасход."""
    assert credit_available(Decimal("142000.00"), MOMENT, Decimal("-150000.00"), MOMENT) == Decimal(
        "-8000.00"
    )


def test_available_matches_three_banks() -> None:
    """Сверка смысла на живых числах трёх банков: «лимит + остаток» совпадает с
    тем, что банк зовёт «доступно». Этот тест стережёт саму идею хранить одно
    поле вместо двух."""
    live = [
        (Decimal("150000.00"), Decimal("-148063.81"), Decimal("1936.19")),  # Сбербанк
        (Decimal("142000.00"), Decimal("-2000.47"), Decimal("139999.53")),  # Т-Банк
        (Decimal("53000.00"), Decimal("-51025.00"), Decimal("1975.00")),  # Альфа-Банк
    ]
    for limit, balance, expected in live:
        assert credit_available(limit, MOMENT, balance, MOMENT) == expected


# --- сквозь импорт ---

OPERATION = {
    "occurred_at": "2026-09-01",
    "amount": "-100.00",
    "currency": "RUB",
    "description": "Кофейня",
    "external_id": "bank-op-1",
}


async def _ws_and_account(client: AsyncClient) -> tuple[str, str]:
    await client.post("/api/auth/register", json=ALICE)
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


async def _account(client: AsyncClient, ws: str) -> dict[str, Any]:
    accounts: list[dict[str, Any]] = (
        await client.get("/api/accounts", params={"workspace_id": ws})
    ).json()
    assert len(accounts) == 1
    return accounts[0]


async def _start_import(
    client: AsyncClient,
    ws: str,
    account_id: str,
    account: dict[str, Any],
    external_id: str = "bank-op-1",
) -> Response:
    return await client.post(
        "/api/imports/parsed",
        params={"workspace_id": ws, "account_id": account_id},
        json={
            "parser": "tbank_collector",
            "operations": [{**OPERATION, "external_id": external_id}],
            "account": account,
        },
    )


async def _commit(client: AsyncClient, ws: str, import_id: str) -> dict[str, Any]:
    resp = await client.post(f"/api/imports/{import_id}/commit", params={"workspace_id": ws})
    assert resp.status_code == 200
    result: dict[str, Any] = resp.json()
    return result


async def _collect(
    client: AsyncClient,
    ws: str,
    account_id: str,
    account: dict[str, Any],
    external_id: str = "bank-op-1",
) -> dict[str, Any]:
    """Один сбор: отправили разбор и подтвердили его."""
    started = await _start_import(client, ws, account_id, account, external_id)
    assert started.status_code == 201, started.text
    return await _commit(client, ws, started.json()["import_id"])


async def _observations(db_session: AsyncSession, ws: str) -> list[CreditLimitObservation]:
    rows = await db_session.scalars(
        select(CreditLimitObservation)
        .where(CreditLimitObservation.workspace_id == uuid.UUID(ws))
        .order_by(CreditLimitObservation.observed_at)
    )
    return list(rows.all())


async def test_limit_reaches_account(client: AsyncClient) -> None:
    """Лимит доезжает до счёта вместе с остатком, и «доступно» считается из них."""
    ws, account_id = await _ws_and_account(client)
    await _collect(client, ws, account_id, {"balance": "-148063.81", "credit_limit": "150000.00"})

    account = await _account(client, ws)
    assert Decimal(account["credit_limit"]) == Decimal("150000.00")
    assert Decimal(account["credit_available"]) == Decimal("1936.19")
    assert account["credit_limit_at"] == account["reported_at"]


async def test_account_without_limit_has_none(client: AsyncClient) -> None:
    """Счёт, у которого лимита не наблюдали, выглядит как раньше."""
    ws, account_id = await _ws_and_account(client)
    await _collect(client, ws, account_id, {"balance": "5000.00"})

    account = await _account(client, ws)
    assert account["credit_limit"] is None
    assert account["credit_limit_at"] is None
    assert account["credit_available"] is None


async def test_repeat_collection_keeps_available(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """Повторный сбор с тем же лимитом новой записи не создаёт, но «доступно»
    после него считается по-прежнему.

    Стык двух правил: записи экономим, свежесть проверяем по моменту. Без
    подтверждения момента лимит, не менявшийся месяц, выглядел бы устаревшим, и
    «доступно» пропало бы у карты, с которой всё в порядке.
    """
    ws, account_id = await _ws_and_account(client)
    await _collect(client, ws, account_id, {"balance": "-148063.81", "credit_limit": "150000.00"})
    await _collect(
        client, ws, account_id, {"balance": "-148163.81", "credit_limit": "150000.00"}, "bank-op-2"
    )

    assert len(await _observations(db_session, ws)) == 1
    account = await _account(client, ws)
    assert Decimal(account["credit_available"]) == Decimal("1836.19")
    assert account["credit_limit_at"] == account["reported_at"]


async def test_changed_limit_adds_observation(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """Изменившийся лимит добавляет запись, прежняя остаётся со своим моментом:
    по ним и читается история изменений."""
    ws, account_id = await _ws_and_account(client)
    await _collect(client, ws, account_id, {"balance": "-2000.47", "credit_limit": "142000.00"})
    await _collect(
        client, ws, account_id, {"balance": "-2000.47", "credit_limit": "200000.00"}, "bank-op-2"
    )

    observations = await _observations(db_session, ws)
    assert [o.value for o in observations] == [Decimal("142000.0000"), Decimal("200000.0000")]
    assert Decimal((await _account(client, ws))["credit_limit"]) == Decimal("200000.00")


async def test_collection_without_limit_stops_available(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """Главный тест смысла: остаток свежий, а последнее наблюдение лимита старое
    — «доступно» не считается вовсе.

    Так и выглядит поднятие лимита, которого не оказалось в ответе: сложив
    свежий остаток со старым лимитом, мы показали бы достоверное на вид число из
    двух разных сборов. Лимит при этом не стирается — он просто известен на свой
    момент.
    """
    ws, account_id = await _ws_and_account(client)
    await _collect(client, ws, account_id, {"balance": "-2000.47", "credit_limit": "142000.00"})
    await _collect(client, ws, account_id, {"balance": "-3000.47"}, "bank-op-2")

    account = await _account(client, ws)
    assert account["credit_available"] is None
    assert Decimal(account["credit_limit"]) == Decimal("142000.00")
    assert account["credit_limit_at"] != account["reported_at"]
    # отсутствие лимита в сборе — не событие банка: записи оно не создаёт
    assert len(await _observations(db_session, ws)) == 1


async def test_older_import_does_not_roll_limit_back(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """Импорты подтверждаются в произвольном порядке, и наблюдение из прошлого
    не переписывает настоящее — тем же правилом, что и остаток."""
    ws, account_id = await _ws_and_account(client)
    older = await _start_import(
        client, ws, account_id, {"balance": "-2000.47", "credit_limit": "142000.00"}, "bank-op-1"
    )
    newer = await _start_import(
        client, ws, account_id, {"balance": "-2000.47", "credit_limit": "200000.00"}, "bank-op-2"
    )

    await _commit(client, ws, newer.json()["import_id"])
    await _commit(client, ws, older.json()["import_id"])

    assert [o.value for o in await _observations(db_session, ws)] == [Decimal("200000.0000")]
    assert Decimal((await _account(client, ws))["credit_limit"]) == Decimal("200000.00")


async def test_limit_updates_when_nothing_new_imported(client: AsyncClient) -> None:
    """Повторный сбор — законный и самый частый способ обновить лимит, и все
    операции в нём чаще всего дубли. Считай мы применение лимита только при
    новых операциях, обновлять его было бы нечем."""
    ws, account_id = await _ws_and_account(client)
    await _collect(client, ws, account_id, {"balance": "-2000.47", "credit_limit": "142000.00"})

    # тот же external_id: ни одной новой операции
    result = await _collect(
        client, ws, account_id, {"balance": "-2000.47", "credit_limit": "200000.00"}
    )

    assert result["imported"] == 0
    assert Decimal((await _account(client, ws))["credit_limit"]) == Decimal("200000.00")


async def test_dashboard_agrees_with_account_list(client: AsyncClient) -> None:
    """Дашборд и список счетов показывают одно и то же: две карточки счёта,
    расходящиеся в числах, хуже одной неполной."""
    ws, account_id = await _ws_and_account(client)
    await _collect(client, ws, account_id, {"balance": "-148063.81", "credit_limit": "150000.00"})

    dashboard = (await client.get("/api/dashboard", params={"workspace_id": ws})).json()
    on_dashboard = dashboard["accounts"][0]
    in_list = await _account(client, ws)
    assert on_dashboard["credit_limit"] == in_list["credit_limit"]
    assert on_dashboard["credit_limit_at"] == in_list["credit_limit_at"]
    assert on_dashboard["credit_available"] == in_list["credit_available"]


async def test_accounts_total_unchanged_by_limit(client: AsyncClient) -> None:
    """Сумма по счетам считается по остаткам, и лимит её не трогает: заёмные
    деньги своими не становятся."""
    ws, account_id = await _ws_and_account(client)
    await _collect(client, ws, account_id, {"balance": "-148063.81", "credit_limit": "150000.00"})

    assert Decimal((await _account(client, ws))["balance"]) == Decimal("-148063.81")


async def test_rename_keeps_limit(client: AsyncClient) -> None:
    """Переименование карты отдаёт лимит на месте: иначе он пропал бы с экрана
    до перезагрузки страницы."""
    ws, account_id = await _ws_and_account(client)
    await _collect(client, ws, account_id, {"balance": "-148063.81", "credit_limit": "150000.00"})

    resp = await client.patch(
        f"/api/accounts/{account_id}", params={"workspace_id": ws}, json={"name": "Platinum"}
    )

    assert resp.status_code == 200
    assert Decimal(resp.json()["credit_limit"]) == Decimal("150000.00")
    assert Decimal(resp.json()["credit_available"]) == Decimal("1936.19")


async def test_limits_read_only_within_workspace(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """Чтение наблюдений отфильтровано по workspace.

    Проверяем repository напрямую: через API этот фильтр не достать — счёт уже
    принадлежит одному workspace, и выдача всё равно собирается по его счетам.
    Тест «чужой не видит лимита» на уровне API был бы зелёным и с выброшенным
    фильтром, то есть не проверял бы ничего.
    """
    ws, account_id = await _ws_and_account(client)
    await _collect(client, ws, account_id, {"balance": "-148063.81", "credit_limit": "150000.00"})

    mine = await ledger_repository.latest_credit_limits(db_session, uuid.UUID(ws))
    assert list(mine) == [uuid.UUID(account_id)]
    assert await ledger_repository.latest_credit_limits(db_session, uuid.uuid4()) == {}


async def test_float_limit_rejected(client: AsyncClient) -> None:
    """Число JSON вместо строки теряет разряды ещё до валидации — то же правило,
    что у остатка и сумм операций."""
    ws, account_id = await _ws_and_account(client)
    resp = await client.post(
        "/api/imports/parsed",
        params={"workspace_id": ws, "account_id": account_id},
        content=json.dumps(
            {
                "parser": "tbank_collector",
                "operations": [OPERATION],
                "account": {"balance": "100.00", "credit_limit": 12345678901234.5678},
            }
        ),
        headers={"Content-Type": "application/json"},
    )
    assert resp.status_code == 422


async def test_overflow_limit_rejected(client: AsyncClient) -> None:
    """Больше NUMERIC(20,4) — иначе это DBAPIError уже при подтверждении."""
    ws, account_id = await _ws_and_account(client)
    resp = await _start_import(
        client, ws, account_id, {"balance": "100.00", "credit_limit": "1E+30"}
    )
    assert resp.status_code == 422


async def test_broken_limit_is_dropped(client: AsyncClient, db_session: AsyncSession) -> None:
    """Негодный лимит подтверждение не роняет: лимит поясняет счёт, но деньгами
    счёта не является, — та же граница, что у меток карт. Порча остатка роняет.
    Молча это не проходит: импорт с мусором виден в логе."""
    from app.imports.models import Import

    ws, account_id = await _ws_and_account(client)
    started = await _start_import(
        client, ws, account_id, {"balance": "-2000.47", "credit_limit": "142000.00"}
    )
    import_id = started.json()["import_id"]
    imp = await db_session.get(Import, uuid.UUID(import_id))
    assert imp is not None
    assert isinstance(imp.parsed_payload, dict)
    payload = dict(imp.parsed_payload)
    payload["account"] = {"balance": "-2000.47", "credit_limit": "много"}
    imp.parsed_payload = payload
    await db_session.commit()

    with capture_logs() as logs:
        await _commit(client, ws, import_id)

    account = await _account(client, ws)
    assert account["credit_limit"] is None
    assert Decimal(account["balance"]) == Decimal("-2000.47")
    assert await _observations(db_session, ws) == []
    assert [e["import_id"] for e in logs if e["event"] == "import_broken_credit_limit"] == [
        import_id
    ]
