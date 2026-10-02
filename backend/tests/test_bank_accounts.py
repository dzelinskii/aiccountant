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


async def test_repeated_fingerprint_in_one_request_is_rejected(client: AsyncClient) -> None:
    """Один счёт банка дважды в одной пачке — баг коллектора, и отвечать на него
    должна схема, а не уникальный индекс: индекс даёт 500, из которого причина
    не видна. Тот же приём стережёт повторяющийся external_id у операций."""
    ws = await _workspace(client, ALICE)
    resp = await _sync(client, ws, "alfa", [_seen("a" * 64, "Один"), _seen("a" * 64, "Два")])
    assert resp.status_code == 422


async def test_sync_does_not_wipe_another_workspace(client: AsyncClient) -> None:
    """Замена списка — это удаление, и оно обязано идти по своему workspace.

    Без фильтра сбор одного человека стирал бы увиденные счета другого — и
    молча: пострадавший увидел бы пустой список, а не ошибку. Изоляцию на
    чтении стережёт соседний тест, но удаление — отдельная операция, и своей
    проверки ей мало не бывает.
    """
    alice_ws = await _workspace(client, ALICE)
    await _sync(client, alice_ws, "alfa", [_seen("a" * 64, "Алисин счёт")])
    await client.post("/api/auth/logout")

    bob_ws = await _workspace(client, BOB)
    await _sync(client, bob_ws, "alfa", [_seen("b" * 64, "Бобов счёт")])
    await client.post("/api/auth/logout")

    await client.post("/api/auth/login", json=ALICE)
    rows = (await client.get("/api/accounts/discovered", params={"workspace_id": alice_ws})).json()
    assert [row["name"] for row in rows] == ["Алисин счёт"]


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


async def test_account_created_from_seen_one_gets_bank(client: AsyncClient) -> None:
    """Ради этого всё и делается: счёт заводится из показанного банком и
    перестаёт быть безымянной строкой в env коллектора."""
    ws = await _workspace(client, ALICE)
    await _sync(client, ws, "alfa", [_seen("a" * 64, "Текущий счёт")])

    created = await client.post(
        "/api/accounts",
        params={"workspace_id": ws},
        json={
            "name": "Альфа карта",
            "type": "card",
            "currency": "RUB",
            "bank_code": "alfa",
            "bank_account_fingerprint": "a" * 64,
        },
    )
    assert created.status_code == 201
    assert created.json()["bank_code"] == "alfa"

    # счёт заведён — предлагать завести его второй раз больше нечего
    assert (await client.get("/api/accounts/discovered", params={"workspace_id": ws})).json() == []

    # а коллектор со следующего сбора знает, куда слать импорт
    linked = (await _sync(client, ws, "alfa", [_seen("a" * 64, "Текущий счёт")])).json()["linked"]
    assert linked == {"a" * 64: created.json()["id"]}


async def test_links_do_not_leak_between_workspaces(client: AsyncClient) -> None:
    """Привязка — это ответ на вопрос «куда слать операции». Утёкшая в чужой
    workspace, она отправила бы чужие операции на чужой счёт.

    Тест заведён отдельно потому, что при исполнении Task 4 выяснилось: фильтр
    по workspace в linked_bank_accounts не стерёг ни один тест — непустых
    привязок в проверках не было вовсе.
    """
    alice_ws = await _workspace(client, ALICE)
    await _sync(client, alice_ws, "alfa", [_seen("a" * 64, "Текущий счёт")])
    created = await client.post(
        "/api/accounts",
        params={"workspace_id": alice_ws},
        json={
            "name": "Альфа карта",
            "type": "card",
            "currency": "RUB",
            "bank_code": "alfa",
            "bank_account_fingerprint": "a" * 64,
        },
    )
    assert created.status_code == 201
    await client.post("/api/auth/logout")

    bob_ws = await _workspace(client, BOB)
    # тот же счёт банка у другого человека: отпечаток совпадает, привязка — нет
    linked = (await _sync(client, bob_ws, "alfa", [_seen("a" * 64, "Текущий счёт")])).json()
    assert linked["linked"] == {}


async def test_linked_account_gone_from_bank_is_not_returned(client: AsyncClient) -> None:
    """Счёт закрыли в банке, а в приложении он остался привязанным. Отдать его
    коллектору значит послать его за операциями несуществующего счёта — банк
    ответит ошибкой, и сбор встанет посреди работы."""
    ws = await _workspace(client, ALICE)
    await _sync(client, ws, "alfa", [_seen("a" * 64, "Текущий счёт")])
    await client.post(
        "/api/accounts",
        params={"workspace_id": ws},
        json={
            "name": "Альфа карта",
            "type": "card",
            "currency": "RUB",
            "bank_code": "alfa",
            "bank_account_fingerprint": "a" * 64,
        },
    )

    linked = (await _sync(client, ws, "alfa", [])).json()["linked"]
    assert linked == {}


async def test_second_account_on_same_bank_account_is_refused(client: AsyncClient) -> None:
    """Два счёта приложения на один счёт банка развели бы операции по двум
    местам. Первое заведение убирает счёт из увиденных, второе получает отказ."""
    ws = await _workspace(client, ALICE)
    await _sync(client, ws, "alfa", [_seen("a" * 64, "Текущий счёт")])
    body = {
        "name": "Альфа карта",
        "type": "card",
        "currency": "RUB",
        "bank_code": "alfa",
        "bank_account_fingerprint": "a" * 64,
    }
    assert (
        await client.post("/api/accounts", params={"workspace_id": ws}, json=body)
    ).status_code == 201

    again = await client.post("/api/accounts", params={"workspace_id": ws}, json=body)
    assert again.status_code == 404


async def test_fingerprint_from_another_bank_is_refused(client: AsyncClient) -> None:
    """Отпечаток считается от банка: тот же отпечаток под чужим банком — это
    не тот счёт, и привязать его нельзя."""
    ws = await _workspace(client, ALICE)
    await _sync(client, ws, "alfa", [_seen("a" * 64, "Текущий счёт")])

    resp = await client.post(
        "/api/accounts",
        params={"workspace_id": ws},
        json={
            "name": "Сбер карта",
            "type": "card",
            "currency": "RUB",
            "bank_code": "sber",
            "bank_account_fingerprint": "a" * 64,
        },
    )
    assert resp.status_code == 404


async def test_fingerprint_without_bank_is_refused(client: AsyncClient) -> None:
    ws = await _workspace(client, ALICE)
    resp = await client.post(
        "/api/accounts",
        params={"workspace_id": ws},
        json={
            "name": "Ничей",
            "type": "card",
            "currency": "RUB",
            "bank_account_fingerprint": "a" * 64,
        },
    )
    assert resp.status_code == 422


async def test_manual_account_may_name_its_bank(client: AsyncClient) -> None:
    """Счёт в банке без плагина ведётся руками, но в списке обязан стоять
    рядом со своими: банк задаётся без всякого отпечатка."""
    ws = await _workspace(client, ALICE)
    created = await client.post(
        "/api/accounts",
        params={"workspace_id": ws},
        json={"name": "Сбер вклад", "type": "savings", "currency": "RUB", "bank_code": "sber"},
    )
    assert created.status_code == 201
    assert created.json()["bank_code"] == "sber"


async def test_account_without_bank_still_works(client: AsyncClient) -> None:
    """Наличные банка не имеют, и заведение счёта не должно этого требовать."""
    ws = await _workspace(client, ALICE)
    created = await client.post(
        "/api/accounts",
        params={"workspace_id": ws},
        json={"name": "Кошелёк", "type": "cash", "currency": "RUB"},
    )
    assert created.status_code == 201
    assert created.json()["bank_code"] is None


async def test_cannot_link_to_another_workspace_seen_account(client: AsyncClient) -> None:
    """Чужая увиденная строка не должна становиться чужим счётом.

    Без фильтра по workspace при поиске увиденного сосед не только привязал бы
    к себе чужой счёт банка, но и стёр бы строку у настоящего владельца —
    тому просто перестало бы предлагаться завести свой счёт.
    """
    alice_ws = await _workspace(client, ALICE)
    await _sync(client, alice_ws, "alfa", [_seen("a" * 64, "Алисин счёт")])
    await client.post("/api/auth/logout")

    bob_ws = await _workspace(client, BOB)
    resp = await client.post(
        "/api/accounts",
        params={"workspace_id": bob_ws},
        json={
            "name": "Чужой счёт",
            "type": "card",
            "currency": "RUB",
            "bank_code": "alfa",
            "bank_account_fingerprint": "a" * 64,
        },
    )
    assert resp.status_code == 404
    await client.post("/api/auth/logout")

    await client.post("/api/auth/login", json=ALICE)
    rows = (await client.get("/api/accounts/discovered", params={"workspace_id": alice_ws})).json()
    assert [row["name"] for row in rows] == ["Алисин счёт"]


async def test_dashboard_account_carries_bank(client: AsyncClient) -> None:
    """Список счетов и дашборд обязаны раскладывать счета одинаково, а значит
    и банк дашборд отдаёт сам — иначе фронту пришлось бы сводить два ответа."""
    ws = await _workspace(client, ALICE)
    await client.post(
        "/api/accounts",
        params={"workspace_id": ws},
        json={"name": "Сбер вклад", "type": "savings", "currency": "RUB", "bank_code": "sber"},
    )
    dashboard = await client.get("/api/dashboard", params={"workspace_id": ws})
    assert dashboard.status_code == 200
    assert [a["bank_code"] for a in dashboard.json()["accounts"]] == ["sber"]


async def test_banks_dictionary_is_served(client: AsyncClient) -> None:
    """Названия банков живут в одном месте — в ядре; фронт берёт их отсюда."""
    await _workspace(client, ALICE)
    resp = await client.get("/api/banks")
    assert resp.status_code == 200
    assert {"code": "alfa", "name": "Альфа-Банк"} in resp.json()


async def _plain_account(client: AsyncClient, ws: str, name: str = "Старый счёт") -> str:
    created = await client.post(
        "/api/accounts",
        params={"workspace_id": ws},
        json={"name": name, "type": "card", "currency": "RUB"},
    )
    assert created.status_code == 201
    return str(created.json()["id"])


async def _link(
    client: AsyncClient, ws: str, account_id: str, fingerprint: str, bank: str = "alfa"
) -> Any:
    return await client.post(
        f"/api/accounts/{account_id}/link",
        params={"workspace_id": ws},
        json={"bank_code": bank, "bank_account_fingerprint": fingerprint},
    )


async def test_existing_account_can_be_linked(client: AsyncClient) -> None:
    """Счёт, который вёлся до появления банков, привязывается к своему счёту в
    банке — без этого переход означал бы второй счёт рядом со старым."""
    ws = await _workspace(client, ALICE)
    account_id = await _plain_account(client, ws)
    await _sync(client, ws, "alfa", [_seen("a" * 64, "Текущий счёт")])

    resp = await _link(client, ws, account_id, "a" * 64)
    assert resp.status_code == 200
    assert resp.json()["bank_code"] == "alfa"
    assert resp.json()["is_bank_linked"] is True

    # предлагать завести этот счёт больше нечего
    assert (await client.get("/api/accounts/discovered", params={"workspace_id": ws})).json() == []
    # и коллектор теперь знает, куда слать импорт
    linked = (await _sync(client, ws, "alfa", [_seen("a" * 64, "Текущий счёт")])).json()["linked"]
    assert linked == {"a" * 64: account_id}


async def test_linking_twice_is_refused(client: AsyncClient) -> None:
    """Перепривязка увела бы будущие операции на другой счёт банка, а
    собранные раньше остались бы на этом — молча."""
    ws = await _workspace(client, ALICE)
    account_id = await _plain_account(client, ws)
    await _sync(client, ws, "alfa", [_seen("a" * 64, "Первый"), _seen("b" * 64, "Второй")])
    assert (await _link(client, ws, account_id, "a" * 64)).status_code == 200

    again = await _link(client, ws, account_id, "b" * 64)
    assert again.status_code == 409


async def test_linking_to_unseen_fingerprint_is_refused(client: AsyncClient) -> None:
    ws = await _workspace(client, ALICE)
    account_id = await _plain_account(client, ws)
    assert (await _link(client, ws, account_id, "c" * 64)).status_code == 404


async def test_linking_another_workspace_account_is_refused(client: AsyncClient) -> None:
    """Чужой счёт не привязывается к своему счёту банка."""
    alice_ws = await _workspace(client, ALICE)
    alice_account = await _plain_account(client, alice_ws)
    await client.post("/api/auth/logout")

    bob_ws = await _workspace(client, BOB)
    await _sync(client, bob_ws, "alfa", [_seen("a" * 64, "Бобов счёт")])
    assert (await _link(client, bob_ws, alice_account, "a" * 64)).status_code == 404


async def test_reimport_after_linking_gives_duplicates_not_doubles(client: AsyncClient) -> None:
    """Ради этого привязка и делается: операции, собранные до перехода, лежат
    на том же счёте, и повторный сбор за тот же период обязан узнать их
    дублями, а не задвоить деньги."""
    ws = await _workspace(client, ALICE)
    account_id = await _plain_account(client, ws)
    operations = [
        {
            "occurred_at": "2026-07-05",
            "amount": "-1150.00",
            "currency": "RUB",
            "description": "Кофейня",
            "external_id": "bank-op-1",
        }
    ]

    # операции собраны до перехода — на обычный, не привязанный счёт
    first = await client.post(
        "/api/imports/parsed",
        params={"workspace_id": ws, "account_id": account_id},
        json={"parser": "alfa_collector", "operations": operations},
    )
    assert first.status_code == 201
    committed = await client.post(
        f"/api/imports/{first.json()['import_id']}/commit", params={"workspace_id": ws}
    )
    assert committed.json()["imported"] == 1

    # переход: счёт привязывается к своему счёту в банке
    await _sync(client, ws, "alfa", [_seen("a" * 64, "Текущий счёт")])
    assert (await _link(client, ws, account_id, "a" * 64)).status_code == 200

    # повторный сбор за тот же период — с теми же external_id от банка
    second = await client.post(
        "/api/imports/parsed",
        params={"workspace_id": ws, "account_id": account_id},
        json={"parser": "alfa_collector", "operations": operations},
    )
    assert second.status_code == 201
    # всё дубли — импорт закрылся сам, и его итог сохранён как у подтверждения
    assert second.json()["status"] == "completed"
    result = await client.post(
        f"/api/imports/{second.json()['import_id']}/commit", params={"workspace_id": ws}
    )
    assert (result.json()["imported"], result.json()["duplicates"]) == (0, 1)
