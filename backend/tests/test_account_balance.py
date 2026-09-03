import json
import uuid
from datetime import datetime
from decimal import Decimal
from typing import Any

import pytest
from httpx import AsyncClient, Response
from sqlalchemy.ext.asyncio import AsyncSession
from structlog.testing import capture_logs

from app.imports import service
from app.imports.models import Import
from app.imports.parser import StatementParseError
from app.ledger.balance import adjustment_for, visible_balance

ALICE = {"email": "alice@example.com", "password": "password123"}
BOB = {"email": "bob@example.com", "password": "password123"}


def test_reported_balance_wins() -> None:
    # источник сообщил остаток — он и показывается, поправка не участвует
    assert visible_balance(Decimal("100.00"), Decimal("999.00"), Decimal("-50.00")) == Decimal(
        "100.00"
    )


def test_without_reported_sum_and_adjustment() -> None:
    assert visible_balance(None, Decimal("5000.00"), Decimal("-200.00")) == Decimal("4800.00")


def test_without_reported_and_without_adjustment() -> None:
    # поведение до этой задачи: остаток равен сумме операций
    assert visible_balance(None, Decimal(0), Decimal("-122515.28")) == Decimal("-122515.28")


def test_adjustment_makes_desired_visible() -> None:
    operations = Decimal("-200.00")
    adjustment = adjustment_for(Decimal("4900.00"), operations)
    assert visible_balance(None, adjustment, operations) == Decimal("4900.00")


def test_reported_zero_is_not_absent() -> None:
    # ноль — законный остаток, а не «источник промолчал»
    assert visible_balance(Decimal(0), Decimal("777.00"), Decimal("13.00")) == Decimal(0)


async def _ws_and_account(client: AsyncClient) -> tuple[str, str]:
    await client.post("/api/auth/register", json=ALICE)
    me = await client.get("/api/me")
    ws = str(me.json()["workspaces"][0]["id"])
    account_id = (
        await client.post(
            "/api/accounts",
            params={"workspace_id": ws},
            json={"name": "Карта", "type": "card", "currency": "RUB"},
        )
    ).json()["id"]
    return ws, str(account_id)


async def _account(client: AsyncClient, ws: str) -> dict[str, Any]:
    resp = await client.get("/api/accounts", params={"workspace_id": ws})
    assert resp.status_code == 200
    accounts: list[dict[str, Any]] = resp.json()
    assert len(accounts) == 1
    return accounts[0]


async def test_fresh_account_shows_zero(client: AsyncClient) -> None:
    ws, _ = await _ws_and_account(client)
    assert Decimal((await _account(client, ws))["balance"]) == Decimal("0.00")


async def test_balance_follows_operations(client: AsyncClient) -> None:
    """У счёта без источника остаток по-прежнему равен сумме операций: разделение
    величин не должно менять то, что человек уже видит на экране."""
    ws, account_id = await _ws_and_account(client)
    posted = await client.post(
        "/api/transactions",
        params={"workspace_id": ws},
        json={"account_id": account_id, "amount": "-100.00", "occurred_at": "2026-09-01"},
    )
    assert posted.status_code == 201
    assert Decimal((await _account(client, ws))["balance"]) == Decimal("-100.00")


async def test_account_carries_source_marks(client: AsyncClient) -> None:
    """Число без пометки, откуда оно и на какой момент верно, ничего не говорит:
    момент и метки карт обязаны быть в ответе и тогда, когда источника нет."""
    ws, _ = await _ws_and_account(client)
    account = await _account(client, ws)
    assert account["reported_at"] is None
    assert account["card_masks"] == []


OPERATION = {
    "occurred_at": "2026-09-01",
    "amount": "-100.00",
    "currency": "RUB",
    "description": "Кофейня",
    "external_id": "bank-op-1",
}


async def _start_import(
    client: AsyncClient,
    ws: str,
    account_id: str,
    account: dict[str, Any] | None,
    external_id: str = "bank-op-1",
) -> Response:
    """Импорт от коллектора; блок счёта необязателен — разбор PDF его не даёт."""
    body: dict[str, Any] = {
        "parser": "tbank_collector",
        "operations": [{**OPERATION, "external_id": external_id}],
    }
    if account is not None:
        body["account"] = account
    return await client.post(
        "/api/imports/parsed", params={"workspace_id": ws, "account_id": account_id}, json=body
    )


async def _commit(client: AsyncClient, ws: str, import_id: str) -> None:
    resp = await client.post(f"/api/imports/{import_id}/commit", params={"workspace_id": ws})
    assert resp.status_code == 200


async def test_reported_balance_applied_on_commit(client: AsyncClient) -> None:
    """Остаток от источника доезжает до счёта — и ровно в момент подтверждения.

    Отправленный, но не подтверждённый импорт счёта ещё не касается: человек
    может его и не принять. А после подтверждения показывается именно
    сообщённый остаток, а не сумма пришедших операций.
    """
    ws, account_id = await _ws_and_account(client)
    started = await _start_import(client, ws, account_id, {"balance": "12345.67"})
    assert started.status_code == 201
    assert Decimal((await _account(client, ws))["balance"]) == Decimal("0.00")

    await _commit(client, ws, started.json()["import_id"])
    assert Decimal((await _account(client, ws))["balance"]) == Decimal("12345.67")


async def test_reported_at_filled_on_commit(client: AsyncClient) -> None:
    """Остаток без момента, на который он верен, ничего не стоит: коллектор
    ходит в банк не каждую минуту, и человек должен видеть давность числа."""
    ws, account_id = await _ws_and_account(client)
    started = await _start_import(client, ws, account_id, {"balance": "12345.67"})
    await _commit(client, ws, started.json()["import_id"])

    assert (await _account(client, ws))["reported_at"] is not None


async def test_reported_at_is_the_moment_of_collection(client: AsyncClient) -> None:
    """Отметка привязана к созданию импорта — это и есть момент обращения к
    банку. Импорт может пролежать в ожидании подтверждения хоть трое суток, и
    «сейчас» на кнопке соврало бы ровно там, ради чего отметку и завели."""
    ws, account_id = await _ws_and_account(client)
    started = await _start_import(client, ws, account_id, {"balance": "12345.67"})
    pending = (await client.get("/api/imports", params={"workspace_id": ws})).json()
    collected_at = datetime.fromisoformat(pending[0]["created_at"])

    await _commit(client, ws, started.json()["import_id"])

    assert datetime.fromisoformat((await _account(client, ws))["reported_at"]) == collected_at


async def test_older_import_does_not_roll_balance_back(client: AsyncClient) -> None:
    """Остаток перезаписывает последний сбор, а не последнее подтверждение.

    Ожидающие импорты показываются свежими сверху, и человек идёт по списку
    сверху вниз — то есть подтверждает их в обратном порядке. Без сравнения
    моментов счёт после этого показал бы число самого старого сбора, а вместе
    с ним уехали бы назад и отметка времени, и метки карт.
    """
    ws, account_id = await _ws_and_account(client)
    older = await _start_import(
        client, ws, account_id, {"balance": "1000.00", "card_masks": ["1111"]}, "bank-op-1"
    )
    newer = await _start_import(
        client, ws, account_id, {"balance": "2000.00", "card_masks": ["2222"]}, "bank-op-2"
    )

    await _commit(client, ws, newer.json()["import_id"])
    await _commit(client, ws, older.json()["import_id"])

    account = await _account(client, ws)
    assert Decimal(account["balance"]) == Decimal("2000.00")
    assert account["card_masks"] == ["2222"]


async def test_dashboard_agrees_with_account_list(client: AsyncClient) -> None:
    """Дашборд и список счетов показывают одну и ту же величину, значит обязаны
    считать её одним путём. Пока у счёта нет сообщённого остатка, расхождение
    не видно — сумма операций и остаток численно совпадают, — поэтому сверяем
    именно на счёте, которому источник остаток сообщил."""
    ws, account_id = await _ws_and_account(client)
    started = await _start_import(client, ws, account_id, {"balance": "12345.67"})
    await _commit(client, ws, started.json()["import_id"])

    dashboard = (await client.get("/api/dashboard", params={"workspace_id": ws})).json()
    assert len(dashboard["accounts"]) == 1
    on_dashboard = Decimal(dashboard["accounts"][0]["balance"])
    in_list = Decimal((await _account(client, ws))["balance"])
    assert on_dashboard == in_list == Decimal("12345.67")


async def test_dashboard_carries_label_and_moment(client: AsyncClient) -> None:
    """Дашборд — первый экран: счёт на нём тоже надо опознавать, а у остатка
    видеть давность. Ходить за этим вторым запросом незачем — ручка дашборда
    затем и существует, чтобы экран собирался одним ответом.

    Тип счёта нужен там же: метка счёта — цифры карт, а если карт нет, подпись
    типа. Без типа дашборд молчал бы о счетах без карт, хотя список счетов о них
    говорит, и два экрана разошлись бы на одном и том же счёте.
    """
    ws, account_id = await _ws_and_account(client)
    started = await _start_import(
        client, ws, account_id, {"balance": "12345.67", "card_masks": ["1234"]}
    )
    await _commit(client, ws, started.json()["import_id"])

    dashboard = (await client.get("/api/dashboard", params={"workspace_id": ws})).json()

    on_dashboard = dashboard["accounts"][0]
    assert on_dashboard["card_masks"] == ["1234"]
    assert on_dashboard["type"] == "card"
    assert on_dashboard["reported_at"] == (await _account(client, ws))["reported_at"]


async def test_import_without_account_block_keeps_balance(client: AsyncClient) -> None:
    """Разбор PDF-выписки про счёт ничего не знает — такой импорт остаток не
    трогает, и счёт по-прежнему считается по операциям."""
    ws, account_id = await _ws_and_account(client)
    started = await _start_import(client, ws, account_id, None)
    await _commit(client, ws, started.json()["import_id"])

    account = await _account(client, ws)
    assert Decimal(account["balance"]) == Decimal("-100.00")
    assert account["reported_at"] is None


async def test_card_masks_reach_account(client: AsyncClient) -> None:
    """По последним цифрам карты человек и опознаёт, какой счёт перед ним."""
    ws, account_id = await _ws_and_account(client)
    started = await _start_import(
        client, ws, account_id, {"balance": "12345.67", "card_masks": ["1234", "5678"]}
    )
    await _commit(client, ws, started.json()["import_id"])

    assert (await _account(client, ws))["card_masks"] == ["1234", "5678"]


async def test_overflow_balance_rejected(client: AsyncClient) -> None:
    """Больше NUMERIC(20,4) — без проверки на входе это DBAPIError уже при
    подтверждении, когда запись импорта успела уйти в ready."""
    ws, account_id = await _ws_and_account(client)
    resp = await _start_import(client, ws, account_id, {"balance": "1E+30"})
    assert resp.status_code == 422


async def test_card_mask_must_be_four_digits(client: AsyncClient) -> None:
    """Метка — ровно четыре цифры: всё остальное значит, что коллектор прислал
    кусок номера карты, а хранить его мы не собираемся."""
    ws, account_id = await _ws_and_account(client)
    for mask in ("12a4", "123"):
        resp = await _start_import(
            client, ws, account_id, {"balance": "100.00", "card_masks": [mask]}
        )
        assert resp.status_code == 422, mask


async def _rewrite_payload_account(
    db_session: AsyncSession, import_id: str, account: dict[str, Any]
) -> None:
    """Подменить блок счёта в сохранённом разборе. Схема стережёт вход, но между
    отправкой и подтверждением блок лежит в JSONB, где оказаться может что угодно."""
    imp = await db_session.get(Import, uuid.UUID(import_id))
    assert imp is not None
    assert isinstance(imp.parsed_payload, dict)
    payload = dict(imp.parsed_payload)
    payload["account"] = account
    imp.parsed_payload = payload
    await db_session.commit()


async def test_broken_card_masks_are_dropped(client: AsyncClient, db_session: AsyncSession) -> None:
    """Метка — подпись счёта на экране, и негодную мы выбрасываем, а не роняем
    ею весь импорт: подтверждение ошибку разбора наружу не переводит, так что
    импорт остался бы в ready навсегда, а денежная часть не доехала бы из-за
    косметики. Молча это не проходит — импорт с мусором виден в логе."""
    ws, account_id = await _ws_and_account(client)
    started = await _start_import(client, ws, account_id, {"balance": "100.00"})
    import_id = started.json()["import_id"]
    await _rewrite_payload_account(
        db_session, import_id, {"balance": "100.00", "card_masks": [1234, None, "12a4", "5678"]}
    )

    with capture_logs() as logs:
        await _commit(client, ws, import_id)

    account = await _account(client, ws)
    assert account["card_masks"] == ["5678"]
    assert Decimal(account["balance"]) == Decimal("100.00")
    assert [e["import_id"] for e in logs if e["event"] == "import_broken_card_masks"] == [import_id]


async def test_broken_balance_in_payload_raises(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """Остаток, в отличие от меток, — деньги: его порча роняет разбор так же,
    как порча суммы операции, а не оставляет счёт молча с прежним числом."""
    ws, account_id = await _ws_and_account(client)
    started = await _start_import(client, ws, account_id, {"balance": "100.00"})
    import_id = started.json()["import_id"]
    await _rewrite_payload_account(db_session, import_id, {"balance": "NaN", "card_masks": []})

    with pytest.raises(StatementParseError):
        await service.commit_from_import(
            db_session, uuid.UUID(ws), uuid.UUID(import_id), uuid.uuid4()
        )


async def test_float_balance_rejected(client: AsyncClient) -> None:
    """Число JSON вместо строки теряет разряды ещё до валидации — то же правило,
    что у сумм операций."""
    ws, account_id = await _ws_and_account(client)
    resp = await client.post(
        "/api/imports/parsed",
        params={"workspace_id": ws, "account_id": account_id},
        content=json.dumps(
            {
                "parser": "tbank_collector",
                "operations": [OPERATION],
                "account": {"balance": 12345678901234.5678},
            }
        ),
        headers={"Content-Type": "application/json"},
    )
    assert resp.status_code == 422


async def _spend(client: AsyncClient, ws: str, account_id: str, amount: str) -> None:
    resp = await client.post(
        "/api/transactions",
        params={"workspace_id": ws},
        json={"account_id": account_id, "amount": amount, "occurred_at": "2026-09-01"},
    )
    assert resp.status_code == 201


async def _set_balance(client: AsyncClient, ws: str, account_id: str, balance: str) -> Response:
    return await client.patch(
        f"/api/accounts/{account_id}", params={"workspace_id": ws}, json={"balance": balance}
    )


async def test_manual_balance_becomes_visible(client: AsyncClient) -> None:
    """Счёт без источника человек ведёт сам: пересчитал кошелёк — поставил
    число, и счёт показывает именно его, а не сумму известных нам операций."""
    ws, account_id = await _ws_and_account(client)
    await _spend(client, ws, account_id, "-200.00")

    resp = await _set_balance(client, ws, account_id, "4900.00")

    assert resp.status_code == 200
    assert Decimal(resp.json()["balance"]) == Decimal("4900.00")
    assert Decimal((await _account(client, ws))["balance"]) == Decimal("4900.00")


async def test_manual_balance_follows_later_operation(client: AsyncClient) -> None:
    """Человек задаёт текущий остаток, а не «начальное значение»: храним разницу
    с суммой операций, поэтому следующий расход уводит остаток вниз. Сохрани мы
    заданное число как есть — оно застыло бы и разошлось с кошельком."""
    ws, account_id = await _ws_and_account(client)
    await _spend(client, ws, account_id, "-200.00")
    await _set_balance(client, ws, account_id, "4900.00")

    await _spend(client, ws, account_id, "-100.00")

    assert Decimal((await _account(client, ws))["balance"]) == Decimal("4800.00")


async def test_manual_balance_rejected_when_source_reports(client: AsyncClient) -> None:
    """Счёт с источником руками не правится: следующий сбор всё равно перезапишет
    правку, и принять её значит пообещать то, чего мы не сделаем."""
    ws, account_id = await _ws_and_account(client)
    started = await _start_import(client, ws, account_id, {"balance": "12345.67"})
    await _commit(client, ws, started.json()["import_id"])

    resp = await _set_balance(client, ws, account_id, "4900.00")

    assert resp.status_code == 409
    assert Decimal((await _account(client, ws))["balance"]) == Decimal("12345.67")


async def test_manual_balance_on_foreign_account_is_404(client: AsyncClient) -> None:
    """Чужой счёт не виден из своего workspace, и правка остатка — не исключение."""
    _, account_id = await _ws_and_account(client)
    client.cookies.clear()
    await client.post("/api/auth/register", json=BOB)
    ws_bob = str((await client.get("/api/me")).json()["workspaces"][0]["id"])

    assert (await _set_balance(client, ws_bob, account_id, "4900.00")).status_code == 404


async def test_manual_balance_leaves_other_fields(client: AsyncClient) -> None:
    """Остаток правится той же ручкой, что имя и архивность, — и не задевает их:
    отсутствие поля в теле означает «не трогать», а не «сбросить»."""
    ws, account_id = await _ws_and_account(client)
    await client.patch(
        f"/api/accounts/{account_id}",
        params={"workspace_id": ws},
        json={"name": "Наличные", "is_archived": True},
    )

    resp = await _set_balance(client, ws, account_id, "4900.00")

    assert resp.status_code == 200
    assert resp.json()["name"] == "Наличные"
    assert resp.json()["is_archived"] is True
