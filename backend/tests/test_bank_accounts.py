import re
from typing import Any

from httpx import AsyncClient

from app.core.banks import BANK_CODE_PATTERN, BANK_CODES, BANKS


def test_bank_code_has_human_name() -> None:
    """Код банка живёт в коде, название — рядом с ним: два списка в разных
    местах разъехались бы, и фронт показал бы не тот банк."""
    assert BANKS["alfa"] == "Альфа-Банк"
    assert set(BANK_CODES) == {"tbank", "sber", "alfa"}


def test_bank_code_pattern_anchors() -> None:
    """Шаблон кода банка должен иметь якоря — иначе Pydantic проверяет поиском,
    и vtbank, sber2, tbank_unknown будут приняты за знакомые. Якоря гарантируют,
    что совпадает вся строка целиком, а не её часть: это единственное, что мешает
    незнакомому коду молча записаться в базу."""
    for code in BANK_CODES:
        assert re.search(BANK_CODE_PATTERN, code), f"знакомый код {code} обязан проходить"

    # похожие, но чужие: без якорей каждая из этих строк прошла бы по подстроке
    for alien in ("vtb", "vtbank", "sber2", "tbank sber", ""):
        assert not re.search(BANK_CODE_PATTERN, alien), f"чужой код {alien!r} не должен проходить"


ALICE = {"email": "alice@example.com", "password": "password123"}
BOB = {"email": "bob@example.com", "password": "password123"}


async def _workspace(client: AsyncClient, user: dict[str, str]) -> str:
    await client.post("/api/auth/register", json=user)
    me = await client.get("/api/me")
    return str(me.json()["workspaces"][0]["id"])


def _seen(fingerprint: str, name: str, **extra: Any) -> dict[str, Any]:
    return {"fingerprint": fingerprint, "name": name, "currency": "RUB", **extra}


async def _sync(client: AsyncClient, ws: str, bank: str, accounts: list[dict[str, Any]]) -> Any:
    return await client.put(
        "/api/accounts/discovered",
        params={"workspace_id": ws, "bank": bank},
        json={"accounts": accounts},
    )


async def test_seen_accounts_become_visible(client: AsyncClient) -> None:
    """Коллектор сообщает, что показал банк: без этого человеку не из чего
    заводить счёт, а коллектору некуда слать импорт."""
    ws = await _workspace(client, ALICE)
    resp = await _sync(
        client,
        ws,
        "alfa",
        [
            _seen("a" * 64, "Текущий счёт", balance="1000.00", card_masks=["1234"]),
            _seen("b" * 64, "Накопительный"),
        ],
    )
    assert resp.status_code == 200
    assert resp.json()["linked"] == {}

    rows = (await client.get("/api/accounts/discovered", params={"workspace_id": ws})).json()
    assert [row["name"] for row in rows] == ["Накопительный", "Текущий счёт"]
    assert rows[1]["card_masks"] == ["1234"]
    assert rows[1]["bank_code"] == "alfa"
    # название банка приходит с бэкенда: своего списка банков фронт не держит
    assert rows[1]["bank_name"] == "Альфа-Банк"


async def test_closed_account_stops_being_seen(client: AsyncClient) -> None:
    """Список заменяется целиком: счёт, которого в банке больше нет, не остаётся
    висеть предложением «завести»."""
    ws = await _workspace(client, ALICE)
    await _sync(client, ws, "alfa", [_seen("a" * 64, "Текущий"), _seen("b" * 64, "Старый")])
    await _sync(client, ws, "alfa", [_seen("a" * 64, "Текущий")])

    rows = (await client.get("/api/accounts/discovered", params={"workspace_id": ws})).json()
    assert [row["name"] for row in rows] == ["Текущий"]


async def test_other_bank_accounts_survive_sync(client: AsyncClient) -> None:
    """Сбор по одному банку не стирает увиденное у другого: банки собираются
    по очереди, разными запусками."""
    ws = await _workspace(client, ALICE)
    await _sync(client, ws, "alfa", [_seen("a" * 64, "Альфа-счёт")])
    await _sync(client, ws, "sber", [_seen("b" * 64, "Сбер-счёт")])

    rows = (await client.get("/api/accounts/discovered", params={"workspace_id": ws})).json()
    assert {row["name"] for row in rows} == {"Альфа-счёт", "Сбер-счёт"}


async def test_unknown_bank_is_rejected(client: AsyncClient) -> None:
    """Код банка — единственное, чем приложение и коллектор узнают один банк.
    Незнакомый обязан быть виден отказом, а не записаться строкой."""
    ws = await _workspace(client, ALICE)
    assert (await _sync(client, ws, "vtb", [_seen("a" * 64, "Счёт")])).status_code == 422


async def test_malformed_fingerprint_is_rejected(client: AsyncClient) -> None:
    """Отпечаток — ровно sha256 в hex. Другое означает баг коллектора, и принять
    его значит развести мусор в привязках."""
    ws = await _workspace(client, ALICE)
    assert (await _sync(client, ws, "alfa", [_seen("A" * 64, "Счёт")])).status_code == 422
    assert (await _sync(client, ws, "alfa", [_seen("a" * 63, "Счёт")])).status_code == 422


async def test_balance_as_json_number_is_rejected(client: AsyncClient) -> None:
    """Остаток float'ом — потерянные разряды ещё до валидации; коллектор шлёт
    деньги строкой, и нарушение этого должно быть видно."""
    ws = await _workspace(client, ALICE)
    resp = await _sync(client, ws, "alfa", [_seen("a" * 64, "Счёт", balance=1000.5)])
    assert resp.status_code == 422


async def test_seen_accounts_are_isolated_by_workspace(client: AsyncClient) -> None:
    """Утечка между workspace — критический баг, и увиденные счета не исключение:
    имя счёта и хвост карты говорят о человеке достаточно."""
    alice_ws = await _workspace(client, ALICE)
    await _sync(client, alice_ws, "alfa", [_seen("a" * 64, "Текущий")])
    await client.post("/api/auth/logout")

    bob_ws = await _workspace(client, BOB)
    assert (
        await client.get("/api/accounts/discovered", params={"workspace_id": bob_ws})
    ).json() == []

    forbidden = await client.get("/api/accounts/discovered", params={"workspace_id": alice_ws})
    assert forbidden.status_code == 403
