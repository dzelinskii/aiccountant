import uuid
from decimal import Decimal
from typing import Any

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.ledger import repository as ledger_repository
from app.ledger import service as ledger_service
from app.ledger.models import Counterparty, DescriptionRule

ALICE = {"email": "alice@example.com", "password": "password123"}
BOB = {"email": "bob@example.com", "password": "password123"}


async def _register(client: AsyncClient, credentials: dict[str, str]) -> tuple[str, str]:
    """Зарегистрировать пользователя и вернуть его workspace со счётом."""
    await client.post("/api/auth/register", json=credentials)
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


async def _categories(client: AsyncClient, ws: str, kind: str) -> list[str]:
    cats = (await client.get("/api/categories", params={"workspace_id": ws})).json()
    return [str(c["id"]) for c in cats if c["kind"] == kind]


async def _expense_category(client: AsyncClient, ws: str) -> str:
    return (await _categories(client, ws, "expense"))[0]


async def _income_category(client: AsyncClient, ws: str) -> str:
    return (await _categories(client, ws, "income"))[0]


def _add_counterparty(
    db: AsyncSession, ws: str, name: str, category_id: str | None
) -> Counterparty:
    cp = Counterparty(
        workspace_id=uuid.UUID(ws),
        name=name,
        kind="person",
        category_id=None if category_id is None else uuid.UUID(category_id),
    )
    db.add(cp)
    return cp


def _add_signature(db: AsyncSession, ws: str, text: str, counterparty_id: uuid.UUID) -> None:
    db.add(
        DescriptionRule(
            workspace_id=uuid.UUID(ws), normalized_text=text, counterparty_id=counterparty_id
        )
    )


def _add_plain_rule(db: AsyncSession, ws: str, text: str, category_id: str) -> None:
    """Правило прямо в категорию, минуя сервис.

    Сервис отказывается связать правило с чужой категорией, поэтому проверить
    фильтр в самом запросе через него нельзя: испорченную связь приходится
    складывать руками.
    """
    db.add(
        DescriptionRule(
            workspace_id=uuid.UUID(ws),
            normalized_text=text,
            category_id=uuid.UUID(category_id),
        )
    )


async def test_rule_through_counterparty_gives_its_category(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    ws, _ = await _register(client, ALICE)
    category = await _expense_category(client, ws)
    cp = _add_counterparty(db_session, ws, "Денис З.", category)
    await db_session.flush()
    _add_signature(db_session, ws, "денис з.", cp.id)
    await db_session.flush()

    rules = await ledger_service.load_description_rules(db_session, uuid.UUID(ws))
    assert ledger_service.category_for_description(
        rules, "Денис З.", Decimal("-100.00")
    ) == uuid.UUID(category)


async def test_two_signatures_of_one_counterparty_give_the_same_category(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """Ради этого всё и затевается: категория задана один раз, а написаний
    столько, сколько банков."""
    ws, _ = await _register(client, ALICE)
    category = await _expense_category(client, ws)
    cp = _add_counterparty(db_session, ws, "Денис З.", category)
    await db_session.flush()
    _add_signature(db_session, ws, "денис з.", cp.id)
    _add_signature(db_session, ws, "зелинский денис", cp.id)
    await db_session.flush()

    rules = await ledger_service.load_description_rules(db_session, uuid.UUID(ws))
    first = ledger_service.category_for_description(rules, "Денис З.", Decimal("-100.00"))
    second = ledger_service.category_for_description(rules, "ЗЕЛИНСКИЙ ДЕНИС", Decimal("-100.00"))
    assert first == second == uuid.UUID(category)


async def test_counterparty_without_category_gives_no_category(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """Законный случай, а не пробел: контрагент может быть просто именем."""
    ws, _ = await _register(client, ALICE)
    cp = _add_counterparty(db_session, ws, "Денис З.", None)
    await db_session.flush()
    _add_signature(db_session, ws, "денис з.", cp.id)
    await db_session.flush()

    rules = await ledger_service.load_description_rules(db_session, uuid.UUID(ws))
    assert ledger_service.category_for_description(rules, "Денис З.", Decimal("-100.00")) is None
    # и правила в выборке нет вовсе: строка с пустой категорией дала бы цель,
    # у которой категории нет, а RuleTarget обещает обратное. Сегодня это
    # прикрыто проверкой знака, но держится на совпадении, а не на замысле
    assert rules == {}


async def test_plain_rule_still_works(client: AsyncClient, db_session: AsyncSession) -> None:
    """Существующие правила ведут прямо в категорию и такими остаются."""
    ws, _ = await _register(client, ALICE)
    category = await _expense_category(client, ws)
    await ledger_service.create_description_rule(
        db_session, uuid.UUID(ws), "Пятёрочка", uuid.UUID(category)
    )

    rules = await ledger_service.load_description_rules(db_session, uuid.UUID(ws))
    assert ledger_service.category_for_description(
        rules, "пятёрочка", Decimal("-100.00")
    ) == uuid.UUID(category)


async def test_sign_is_still_checked_through_counterparty(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """Расходная категория на приходе не срабатывает — правило через контрагента
    не должно обходить проверку знака."""
    ws, _ = await _register(client, ALICE)
    category = await _expense_category(client, ws)
    cp = _add_counterparty(db_session, ws, "Денис З.", category)
    await db_session.flush()
    _add_signature(db_session, ws, "денис з.", cp.id)
    await db_session.flush()

    rules = await ledger_service.load_description_rules(db_session, uuid.UUID(ws))
    assert ledger_service.category_for_description(rules, "Денис З.", Decimal("100.00")) is None


async def test_counterparty_of_another_workspace_is_invisible(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    ws_alice, _ = await _register(client, ALICE)
    category = await _expense_category(client, ws_alice)
    cp = _add_counterparty(db_session, ws_alice, "Денис З.", category)
    await db_session.flush()
    _add_signature(db_session, ws_alice, "денис з.", cp.id)
    await db_session.flush()

    ws_bob, _ = await _register(client, BOB)
    rules = await ledger_service.load_description_rules(db_session, uuid.UUID(ws_bob))
    assert rules == {}


# Три теста ниже проверяют цепочку «правило → контрагент → категория» по одному
# звену за раз: портим ровно одну связь, чтобы за снятую проверку не отвечал
# соседний фильтр. Иначе выборка выглядела бы защищённой, а держалась бы на
# совпадении — и первое же изменение запроса открыло бы дорогу чужим данным.


async def test_rule_does_not_take_a_category_of_another_workspace(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """Испорчено звено «правило → категория»."""
    ws_alice, _ = await _register(client, ALICE)
    alice_category = await _expense_category(client, ws_alice)

    ws_bob, _ = await _register(client, BOB)
    _add_plain_rule(db_session, ws_bob, "пятёрочка", alice_category)
    await db_session.flush()

    rules = await ledger_service.load_description_rules(db_session, uuid.UUID(ws_bob))
    assert rules == {}


async def test_rule_does_not_take_a_counterparty_of_another_workspace(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """Испорчено звено «правило → контрагент»: категория при этом своя, и
    отсечь чужого контрагента больше некому."""
    ws_alice, _ = await _register(client, ALICE)

    ws_bob, _ = await _register(client, BOB)
    bob_category = await _expense_category(client, ws_bob)
    alien = _add_counterparty(db_session, ws_alice, "Денис З.", bob_category)
    await db_session.flush()
    _add_signature(db_session, ws_bob, "денис з.", alien.id)
    await db_session.flush()

    rules = await ledger_service.load_description_rules(db_session, uuid.UUID(ws_bob))
    assert rules == {}


async def test_counterparty_does_not_take_a_category_of_another_workspace(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """Испорчено звено «контрагент → категория»: контрагент свой, а категория
    у него чужая."""
    ws_alice, _ = await _register(client, ALICE)
    alice_category = await _expense_category(client, ws_alice)

    ws_bob, _ = await _register(client, BOB)
    cp = _add_counterparty(db_session, ws_bob, "Денис З.", alice_category)
    await db_session.flush()
    _add_signature(db_session, ws_bob, "денис з.", cp.id)
    await db_session.flush()

    rules = await ledger_service.load_description_rules(db_session, uuid.UUID(ws_bob))
    assert rules == {}


async def _import_transfer(client: AsyncClient, ws: str, acc: str, text: str, amount: str) -> None:
    started = await client.post(
        "/api/imports/parsed",
        params={"workspace_id": ws, "account_id": acc},
        json={
            "parser": "test_collector",
            "operations": [
                {
                    "occurred_at": "2026-09-01",
                    "amount": amount,
                    "currency": "RUB",
                    "description": text,
                    "external_id": f"op-{text}-{amount}",
                    "kind": "transfer_person",
                }
            ],
        },
    )
    assert started.status_code == 201
    committed = await client.post(
        f"/api/imports/{started.json()['import_id']}/commit", params={"workspace_id": ws}
    )
    assert committed.status_code == 200


async def _unknown_signatures(client: AsyncClient, ws: str) -> list[dict[str, Any]]:
    resp = await client.get("/api/counterparties/unknown-signatures", params={"workspace_id": ws})
    assert resp.status_code == 200
    items: list[dict[str, Any]] = resp.json()
    return items


async def test_unknown_signatures_count_both_directions(client: AsyncClient) -> None:
    ws, acc = await _register(client, ALICE)
    await _import_transfer(client, ws, acc, "Денис З.", "-100.00")
    await _import_transfer(client, ws, acc, "Денис З.", "-200.00")
    await _import_transfer(client, ws, acc, "Денис З.", "300.00")

    assert await _unknown_signatures(client, ws) == [
        {"text": "денис з.", "operations": 3, "sent": 2, "received": 1}
    ]


async def test_signature_with_a_plain_rule_is_not_offered(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """Подпись, про которую уже решили, предлагать незачем."""
    ws, acc = await _register(client, ALICE)
    category = await _expense_category(client, ws)
    await _import_transfer(client, ws, acc, "Денис З.", "-100.00")
    await ledger_service.create_description_rule(
        db_session, uuid.UUID(ws), "Денис З.", uuid.UUID(category)
    )
    await db_session.flush()

    assert await _unknown_signatures(client, ws) == []


async def test_signature_bound_to_counterparty_is_not_offered(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """Подпись, привязанная к контрагенту, тоже опознана — даже если у
    контрагента нет категории."""
    ws, acc = await _register(client, ALICE)
    await _import_transfer(client, ws, acc, "Денис З.", "-100.00")
    cp = _add_counterparty(db_session, ws, "Денис", None)
    await db_session.flush()
    _add_signature(db_session, ws, "денис з.", cp.id)
    await db_session.flush()

    assert await _unknown_signatures(client, ws) == []


async def test_only_person_transfers_are_offered(client: AsyncClient) -> None:
    """Покупки в контрагенты не заводим: категории для них приходят подсказкой
    банка, и вручную их называть незачем."""
    ws, acc = await _register(client, ALICE)
    started = await client.post(
        "/api/imports/parsed",
        params={"workspace_id": ws, "account_id": acc},
        json={
            "parser": "test_collector",
            "operations": [
                {
                    "occurred_at": "2026-09-01",
                    "amount": "-100.00",
                    "currency": "RUB",
                    "description": "Пятёрочка",
                    "external_id": "op-1",
                    "kind": "purchase",
                }
            ],
        },
    )
    assert started.status_code == 201
    await client.post(
        f"/api/imports/{started.json()['import_id']}/commit", params={"workspace_id": ws}
    )

    assert await _unknown_signatures(client, ws) == []


async def test_sql_normalization_matches_python(client: AsyncClient) -> None:
    """Ключ из ручки обязан совпасть с ключом, по которому ищется правило.
    Две реализации одного правила — в SQL и в Python — разойтись не должны:
    иначе человек заведёт контрагента на подпись, которая правилу не
    соответствует, и она останется неопознанной навсегда."""
    ws, acc = await _register(client, ALICE)
    await _import_transfer(client, ws, acc, "  ДЕНИС   З.  ", "-100.00")

    signatures = await _unknown_signatures(client, ws)
    assert [s["text"] for s in signatures] == [
        ledger_service.normalize_description("  ДЕНИС   З.  ")
    ]


async def test_sql_normalization_matches_python_on_unicode_spaces(client: AsyncClient) -> None:
    """Тот же ключ, но пробелы не только обычные: банки разделяют слова
    неразрывным пробелом, а класс [[:space:]] у Postgres его пробелом
    не считает. Python (str.split) — считает."""
    # неразрывный, длинный, узкий неразрывный и идеографический пробелы
    raw = " ДЕНИС  З.　"
    ws, acc = await _register(client, ALICE)
    await _import_transfer(client, ws, acc, raw, "-100.00")

    assert [s["text"] for s in await _unknown_signatures(client, ws)] == [
        ledger_service.normalize_description(raw)
    ]
    assert ledger_service.normalize_description(raw) == "денис з."


def test_sql_whitespace_class_covers_python_whitespace() -> None:
    """Набор пробельных символов для SQL — тот же, по которому режет str.split().

    Тремя строками выше проверены только те пробелы, которые пришли в голову;
    здесь набор сверяется с определением Python целиком, чтобы недостающий
    символ нашёлся здесь, а не на живой подписи.
    """
    assert set(ledger_repository.WHITESPACE_CODEPOINTS) == {
        code for code in range(0x110000) if chr(code).isspace()
    }


async def test_sql_normalization_matches_python_on_decomposed_letters(
    client: AsyncClient,
) -> None:
    """«й» из «и» с надстрочным знаком обязана дать тот же ключ, что и «й» одним
    кодпоинтом, — иначе правило, заведённое руками, молча не совпадёт.

    В raw ниже «й» записана разложенной: «и» и отдельный надстрочный знак."""
    raw = "Андрей З."
    ws, acc = await _register(client, ALICE)
    await _import_transfer(client, ws, acc, raw, "-100.00")

    assert [s["text"] for s in await _unknown_signatures(client, ws)] == [
        ledger_service.normalize_description(raw)
    ]
    assert ledger_service.normalize_description(raw) == "андрей з."


async def test_blank_signature_is_not_offered(client: AsyncClient) -> None:
    """Описание из одних пробелов даёт пустой ключ, а правило с пустым ключом
    завести нельзя — предлагать такую подпись значит предлагать тупик."""
    ws, acc = await _register(client, ALICE)
    await _import_transfer(client, ws, acc, "   ", "-100.00")

    assert await _unknown_signatures(client, ws) == []


async def test_unknown_signatures_do_not_leak_between_workspaces(client: AsyncClient) -> None:
    ws_alice, acc_alice = await _register(client, ALICE)
    await _import_transfer(client, ws_alice, acc_alice, "Денис З.", "-100.00")
    ws_bob, _ = await _register(client, BOB)

    assert await _unknown_signatures(client, ws_bob) == []


async def test_a_rule_of_another_workspace_does_not_hide_a_signature(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """Чужое правило не должно опознавать мою подпись.

    Фильтр по workspace нужен именно в условии присоединения: в where он ловит
    обратную утечку (чужие операции), а эту — нет. Без него подпись, про которую
    решил кто-то другой, молча пропала бы из моего списка.
    """
    ws_bob, _ = await _register(client, BOB)
    bob_category = await _expense_category(client, ws_bob)
    _add_plain_rule(db_session, ws_bob, "денис з.", bob_category)
    await db_session.flush()

    ws_alice, acc_alice = await _register(client, ALICE)
    await _import_transfer(client, ws_alice, acc_alice, "Денис З.", "-100.00")

    assert await _unknown_signatures(client, ws_alice) == [
        {"text": "денис з.", "operations": 1, "sent": 1, "received": 0}
    ]


async def _create_counterparty(
    client: AsyncClient,
    ws: str,
    name: str,
    signatures: list[str],
    category_id: str | None = None,
    kind: str = "person",
) -> dict[str, Any]:
    resp = await client.post(
        "/api/counterparties",
        params={"workspace_id": ws},
        json={
            "name": name,
            "kind": kind,
            "category_id": category_id,
            "signatures": signatures,
        },
    )
    assert resp.status_code == 201, resp.text
    created: dict[str, Any] = resp.json()
    return created


async def _counterparties(client: AsyncClient, ws: str) -> list[dict[str, Any]]:
    resp = await client.get("/api/counterparties", params={"workspace_id": ws})
    assert resp.status_code == 200
    items: list[dict[str, Any]] = resp.json()
    return items


async def _rules(client: AsyncClient, ws: str) -> list[dict[str, Any]]:
    resp = await client.get("/api/description-rules", params={"workspace_id": ws})
    assert resp.status_code == 200
    items: list[dict[str, Any]] = resp.json()
    return items


async def test_counterparty_is_created_and_listed(client: AsyncClient) -> None:
    """Заведённый контрагент виден в списке вместе с подписями и категорией."""
    ws, _ = await _register(client, ALICE)
    category = await _expense_category(client, ws)

    created = await _create_counterparty(
        client, ws, "Денис", ["зелинский денис", "денис з."], category
    )
    assert created["name"] == "Денис"
    assert created["kind"] == "person"
    assert created["category_id"] == category
    assert created["signatures"] == ["денис з.", "зелинский денис"]

    assert await _counterparties(client, ws) == [created]


async def test_creating_counterparty_binds_signatures(client: AsyncClient) -> None:
    """Ради этого ручка и нужна: подписи перестают быть неопознанными."""
    ws, acc = await _register(client, ALICE)
    await _import_transfer(client, ws, acc, "Денис З.", "-100.00")
    await _import_transfer(client, ws, acc, "ЗЕЛИНСКИЙ ДЕНИС", "-200.00")

    created = await _create_counterparty(client, ws, "Денис", ["денис з.", "зелинский денис"])
    assert created["signatures"] == ["денис з.", "зелинский денис"]
    assert await _unknown_signatures(client, ws) == []


async def test_signatures_are_normalized_when_bound(client: AsyncClient) -> None:
    """Подпись уезжает в правило ключом, а не тем, что прислали: иначе правило
    не совпадёт с описанием операции и молча не сработает."""
    ws, acc = await _register(client, ALICE)
    await _import_transfer(client, ws, acc, "Денис З.", "-100.00")

    created = await _create_counterparty(client, ws, "Денис", ["  ДЕНИС   З.  "])
    assert created["signatures"] == ["денис з."]
    # ключ совпал с подписью операции — иначе она осталась бы неопознанной
    assert await _unknown_signatures(client, ws) == []


async def test_counterparty_without_category_is_allowed(client: AsyncClient) -> None:
    """Переводы одному человеку бывают разными по смыслу; требовать категорию
    значит требовать соврать."""
    ws, _ = await _register(client, ALICE)

    created = await _create_counterparty(client, ws, "Денис", ["денис з."])
    assert created["category_id"] is None


async def test_counterparty_without_signatures_is_allowed(client: AsyncClient) -> None:
    """Контрагента заводят заранее, ещё до того как встретилась хоть одна его
    подпись, — пустой список не отказ."""
    ws, _ = await _register(client, ALICE)

    created = await _create_counterparty(client, ws, "Денис", [])
    assert created["signatures"] == []
    assert [c["id"] for c in await _counterparties(client, ws)] == [created["id"]]


async def test_organization_is_a_counterparty_too(client: AsyncClient) -> None:
    """Банк не отличает организацию от человека: «Газпром» приезжает тем же
    видом перевода, и типом его помечает человек."""
    ws, _ = await _register(client, ALICE)

    created = await _create_counterparty(
        client, ws, "Газпром Межрегионгаз", ["газпром межрегионгаз"], kind="organization"
    )
    assert created["kind"] == "organization"


async def test_unknown_kind_is_rejected(client: AsyncClient) -> None:
    ws, _ = await _register(client, ALICE)
    resp = await client.post(
        "/api/counterparties",
        params={"workspace_id": ws},
        json={"name": "Денис", "kind": "робот", "category_id": None, "signatures": []},
    )
    assert resp.status_code == 422
    assert await _counterparties(client, ws) == []


async def test_rules_listing_survives_a_counterparty_rule(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """Правило через контрагента категории не имеет, и выдача правил обязана
    это пережить: объяви схема категорию обязательной — ручка отвечала бы
    пятисоткой на проверке собственного ответа."""
    ws, _ = await _register(client, ALICE)
    cp = _add_counterparty(db_session, ws, "Денис", None)
    await db_session.flush()
    _add_signature(db_session, ws, "денис з.", cp.id)
    await db_session.flush()

    resp = await client.get("/api/description-rules", params={"workspace_id": ws})
    assert resp.status_code == 200
    assert resp.json() == [
        {
            "id": resp.json()[0]["id"],
            "normalized_text": "денис з.",
            "category_id": None,
            "counterparty_id": str(cp.id),
            "source": "manual",
        }
    ]


async def test_taken_signature_is_rejected(client: AsyncClient, db_session: AsyncSession) -> None:
    """Подпись с готовым правилом молча не переподчиняем: решение о ней человек
    уже принял, и отобрать его заведением контрагента нельзя."""
    ws, _ = await _register(client, ALICE)
    category = await _expense_category(client, ws)
    await ledger_service.create_description_rule(
        db_session, uuid.UUID(ws), "денис з.", uuid.UUID(category)
    )

    resp = await client.post(
        "/api/counterparties",
        params={"workspace_id": ws},
        json={"name": "Денис", "kind": "person", "category_id": None, "signatures": ["ДЕНИС З."]},
    )
    assert resp.status_code == 409
    # отказ полный, а не частичный: контрагента без подписей тоже не осталось
    assert await _counterparties(client, ws) == []
    # и прежнее решение на месте
    assert [r["category_id"] for r in await _rules(client, ws)] == [category]


async def test_taken_signature_slipping_past_precheck_is_still_rejected(
    client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Отказ держится не на предпроверке, а на уникальном индексе: сними
    предпроверку — ответ обязан остаться тем же. Так и выглядит окно гонки,
    когда правило завели одновременно в другой сессии.
    """
    ws, _ = await _register(client, ALICE)
    category = await _expense_category(client, ws)
    await ledger_service.create_description_rule(
        db_session, uuid.UUID(ws), "денис з.", uuid.UUID(category)
    )

    async def blind(*args: object, **kwargs: object) -> None:
        return None

    monkeypatch.setattr(ledger_repository, "find_description_rule", blind)
    resp = await client.post(
        "/api/counterparties",
        params={"workspace_id": ws},
        json={"name": "Денис", "kind": "person", "category_id": None, "signatures": ["денис з."]},
    )
    assert resp.status_code == 409
    assert await _counterparties(client, ws) == []


async def test_signature_of_another_counterparty_is_rejected(client: AsyncClient) -> None:
    """Та же защита, когда подпись занята не категорией, а другим контрагентом."""
    ws, _ = await _register(client, ALICE)
    first = await _create_counterparty(client, ws, "Денис", ["денис з."])

    resp = await client.post(
        "/api/counterparties",
        params={"workspace_id": ws},
        json={
            "name": "Другой Денис",
            "kind": "person",
            "category_id": None,
            "signatures": ["  ДЕНИС   З."],
        },
    )
    assert resp.status_code == 409
    assert [c["id"] for c in await _counterparties(client, ws)] == [first["id"]]


async def test_repeated_signature_in_one_request_is_rejected(client: AsyncClient) -> None:
    """Одна подпись — одно правило; дважды названная в одном запросе не
    исключение, хотя до базы такая пара доходит вместе."""
    ws, _ = await _register(client, ALICE)

    resp = await client.post(
        "/api/counterparties",
        params={"workspace_id": ws},
        json={
            "name": "Денис",
            "kind": "person",
            "category_id": None,
            "signatures": ["денис з.", "  ДЕНИС З."],
        },
    )
    assert resp.status_code == 409
    assert await _counterparties(client, ws) == []
    assert await _rules(client, ws) == []


async def test_signature_without_usable_key_is_rejected(client: AsyncClient) -> None:
    """Ключ меряем после нормализации: из одних пробелов он не выходит вовсе,
    а «İ» в нижнем регистре занимает два символа и в колонку не влезает."""
    ws, _ = await _register(client, ALICE)

    for signature in ("   ", "İ" * 200):
        resp = await client.post(
            "/api/counterparties",
            params={"workspace_id": ws},
            json={
                "name": "Денис",
                "kind": "person",
                "category_id": None,
                "signatures": [signature],
            },
        )
        assert resp.status_code == 422, signature
    assert await _counterparties(client, ws) == []


async def test_creating_rejects_category_of_another_workspace(client: AsyncClient) -> None:
    """Категория обязана жить в том же workspace — иначе межворкспейсная ссылка,
    которую внешний ключ не ловит: он про таблицу, а не про workspace."""
    ws_alice, _ = await _register(client, ALICE)
    alice_category = await _expense_category(client, ws_alice)

    ws_bob, _ = await _register(client, BOB)
    resp = await client.post(
        "/api/counterparties",
        params={"workspace_id": ws_bob},
        json={
            "name": "Денис",
            "kind": "person",
            "category_id": alice_category,
            "signatures": ["денис з."],
        },
    )
    assert resp.status_code == 404
    assert await _counterparties(client, ws_bob) == []


async def test_counterparty_name_and_category_are_editable(client: AsyncClient) -> None:
    ws, _ = await _register(client, ALICE)
    category = await _expense_category(client, ws)
    created = await _create_counterparty(client, ws, "Денис", ["денис з."])

    resp = await client.patch(
        f"/api/counterparties/{created['id']}",
        params={"workspace_id": ws},
        json={"name": "Денис Зелинский", "category_id": category},
    )
    assert resp.status_code == 200
    assert resp.json() == {
        "id": created["id"],
        "name": "Денис Зелинский",
        "kind": "person",
        "category_id": category,
        "signatures": ["денис з."],
    }


async def test_editing_name_keeps_the_category(client: AsyncClient) -> None:
    """Поле, которого в запросе нет, не трогается: правка имени не должна молча
    снимать категорию."""
    ws, _ = await _register(client, ALICE)
    category = await _expense_category(client, ws)
    created = await _create_counterparty(client, ws, "Денис", ["денис з."], category)

    resp = await client.patch(
        f"/api/counterparties/{created['id']}",
        params={"workspace_id": ws},
        json={"name": "Денис Зелинский"},
    )
    assert resp.status_code == 200
    assert resp.json()["category_id"] == category


async def test_counterparty_category_can_be_cleared(client: AsyncClient) -> None:
    """Снять категорию должно быть можно, а не только задать: сегодня переводы
    человеку про одно, завтра про другое."""
    ws, _ = await _register(client, ALICE)
    category = await _expense_category(client, ws)
    created = await _create_counterparty(client, ws, "Денис", ["денис з."], category)

    resp = await client.patch(
        f"/api/counterparties/{created['id']}",
        params={"workspace_id": ws},
        json={"category_id": None},
    )
    assert resp.status_code == 200
    assert resp.json()["category_id"] is None


async def test_editing_rejects_category_of_another_workspace(client: AsyncClient) -> None:
    ws_alice, _ = await _register(client, ALICE)
    alice_category = await _expense_category(client, ws_alice)

    ws_bob, _ = await _register(client, BOB)
    created = await _create_counterparty(client, ws_bob, "Денис", ["денис з."])
    resp = await client.patch(
        f"/api/counterparties/{created['id']}",
        params={"workspace_id": ws_bob},
        json={"category_id": alice_category},
    )
    assert resp.status_code == 404
    assert (await _counterparties(client, ws_bob))[0]["category_id"] is None


async def test_counterparty_of_another_workspace_is_not_editable(client: AsyncClient) -> None:
    """Чужой идентификатор со своим workspace_id проходит проверку членства —
    помешать обязан фильтр в repository, и больше некому."""
    ws_alice, _ = await _register(client, ALICE)
    created = await _create_counterparty(client, ws_alice, "Денис", ["денис з."])

    ws_bob, _ = await _register(client, BOB)
    resp = await client.patch(
        f"/api/counterparties/{created['id']}",
        params={"workspace_id": ws_bob},
        json={"name": "Чужое имя"},
    )
    assert resp.status_code == 404

    client.cookies.clear()
    await client.post("/api/auth/login", json=ALICE)
    assert [c["name"] for c in await _counterparties(client, ws_alice)] == ["Денис"]


async def test_counterparty_of_another_workspace_is_not_deleted(client: AsyncClient) -> None:
    ws_alice, _ = await _register(client, ALICE)
    created = await _create_counterparty(client, ws_alice, "Денис", ["денис з."])

    ws_bob, _ = await _register(client, BOB)
    resp = await client.delete(
        f"/api/counterparties/{created['id']}", params={"workspace_id": ws_bob}
    )
    assert resp.status_code == 404

    client.cookies.clear()
    await client.post("/api/auth/login", json=ALICE)
    assert [c["id"] for c in await _counterparties(client, ws_alice)] == [created["id"]]


async def test_list_shows_only_own_counterparties(client: AsyncClient) -> None:
    ws_alice, _ = await _register(client, ALICE)
    await _create_counterparty(client, ws_alice, "Денис", ["денис з."])

    ws_bob, _ = await _register(client, BOB)
    assert await _counterparties(client, ws_bob) == []


async def test_deleting_counterparty_takes_its_signatures(client: AsyncClient) -> None:
    """Правила уходят вместе с контрагентом: правило без обеих целей ограничение
    в БД не пропустит, и оставлять их было бы нечем."""
    ws, acc = await _register(client, ALICE)
    await _import_transfer(client, ws, acc, "Денис З.", "-100.00")
    created = await _create_counterparty(client, ws, "Денис", ["денис з."])

    resp = await client.delete(f"/api/counterparties/{created['id']}", params={"workspace_id": ws})
    assert resp.status_code == 204
    assert await _counterparties(client, ws) == []
    assert await _rules(client, ws) == []
    # подпись снова неопознана — значит правила не осталось и в поиске по ключу
    assert [s["text"] for s in await _unknown_signatures(client, ws)] == ["денис з."]

    # повторное удаление — уже нечего удалять
    again = await client.delete(f"/api/counterparties/{created['id']}", params={"workspace_id": ws})
    assert again.status_code == 404


async def test_deleting_counterparty_keeps_other_rules(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """Уносятся подписи этого контрагента, а не все правила workspace."""
    ws, _ = await _register(client, ALICE)
    category = await _expense_category(client, ws)
    await ledger_service.create_description_rule(
        db_session, uuid.UUID(ws), "Пятёрочка", uuid.UUID(category)
    )
    neighbour = await _create_counterparty(client, ws, "Анастасия", ["анастасия с."])
    created = await _create_counterparty(client, ws, "Денис", ["денис з."])

    resp = await client.delete(f"/api/counterparties/{created['id']}", params={"workspace_id": ws})
    assert resp.status_code == 204
    assert sorted(r["normalized_text"] for r in await _rules(client, ws)) == [
        "анастасия с.",
        "пятёрочка",
    ]
    assert [c["id"] for c in await _counterparties(client, ws)] == [neighbour["id"]]


async def test_unknown_signatures_route_survives_counterparty_routes(client: AsyncClient) -> None:
    """`unknown-signatures` стоит в файле выше ручек с `{counterparty_id}`:
    иначе FastAPI принял бы это слово за идентификатор."""
    ws, acc = await _register(client, ALICE)
    await _import_transfer(client, ws, acc, "Денис З.", "-100.00")

    resp = await client.get("/api/counterparties/unknown-signatures", params={"workspace_id": ws})
    assert resp.status_code == 200
    assert [s["text"] for s in resp.json()] == ["денис з."]


async def test_api_rejects_counterparty_requests_for_foreign_workspace(
    client: AsyncClient,
) -> None:
    """Проверка членства на всех шести ручках: без неё чужой workspace_id
    пускали бы внутрь вообще без аутентификации."""
    ws_alice, _ = await _register(client, ALICE)
    created = await _create_counterparty(client, ws_alice, "Денис", ["денис з."])

    await _register(client, BOB)
    listed = await client.get("/api/counterparties", params={"workspace_id": ws_alice})
    assert listed.status_code == 403
    made = await client.post(
        "/api/counterparties",
        params={"workspace_id": ws_alice},
        json={"name": "Чужой", "kind": "person", "category_id": None, "signatures": []},
    )
    assert made.status_code == 403
    edited = await client.patch(
        f"/api/counterparties/{created['id']}",
        params={"workspace_id": ws_alice},
        json={"name": "Чужое имя"},
    )
    assert edited.status_code == 403
    deleted = await client.delete(
        f"/api/counterparties/{created['id']}", params={"workspace_id": ws_alice}
    )
    assert deleted.status_code == 403
    counted = await client.get(
        f"/api/counterparties/{created['id']}/uncategorized", params={"workspace_id": ws_alice}
    )
    assert counted.status_code == 403
    applied = await client.post(
        f"/api/counterparties/{created['id']}/apply-category", params={"workspace_id": ws_alice}
    )
    assert applied.status_code == 403

    client.cookies.clear()
    await client.post("/api/auth/login", json=ALICE)
    assert [c["name"] for c in await _counterparties(client, ws_alice)] == ["Денис"]


# Дальше — разбор уже лежащих операций по контрагенту. Операции всюду
# импортируются до заведения контрагента: правило применяется на импорте, и
# заведи мы контрагента раньше, категория проставилась бы сама, а разбирать было
# бы нечего — ровно тот случай, ради которого разбор и нужен.


async def _uncategorized_count(client: AsyncClient, ws: str, counterparty_id: str) -> int:
    resp = await client.get(
        f"/api/counterparties/{counterparty_id}/uncategorized", params={"workspace_id": ws}
    )
    assert resp.status_code == 200, resp.text
    count: int = resp.json()["count"]
    return count


async def _apply_category(client: AsyncClient, ws: str, counterparty_id: str) -> int:
    resp = await client.post(
        f"/api/counterparties/{counterparty_id}/apply-category", params={"workspace_id": ws}
    )
    assert resp.status_code == 200, resp.text
    applied: int = resp.json()["applied"]
    return applied


async def _operation(client: AsyncClient, ws: str, amount: str) -> dict[str, Any]:
    """Операция по сумме: описания в этих тестах повторяются нарочно, а суммы нет.

    Сравниваем как Decimal, а не строки: наружу сумма уходит с четырьмя знаками
    после запятой, и «-100.00» с ней не совпало бы.
    """
    wanted = Decimal(amount)
    items = (await client.get("/api/transactions", params={"workspace_id": ws})).json()["items"]
    matching = [t for t in items if Decimal(t["amount"]) == wanted]
    assert len(matching) == 1, matching
    found: dict[str, Any] = matching[0]
    return found


async def test_counterparty_counts_operations_of_all_its_signatures(client: AsyncClient) -> None:
    """Ради этого контрагент и заведён: написания из разных банков разбираются
    вместе, а не по одному."""
    ws, acc = await _register(client, ALICE)
    category = await _expense_category(client, ws)
    await _import_transfer(client, ws, acc, "Денис З.", "-100.00")
    await _import_transfer(client, ws, acc, "ДЕНИС З.", "-200.00")
    await _import_transfer(client, ws, acc, "ЗЕЛИНСКИЙ ДЕНИС", "-300.00")
    await _import_transfer(client, ws, acc, "Анастасия С.", "-400.00")
    created = await _create_counterparty(
        client, ws, "Денис", ["денис з.", "зелинский денис"], category
    )

    assert await _uncategorized_count(client, ws, created["id"]) == 3
    assert await _apply_category(client, ws, created["id"]) == 3

    for amount in ("-100.00", "-200.00", "-300.00"):
        assert (await _operation(client, ws, amount))["category_id"] == category
    # чужая подпись не его дело
    assert (await _operation(client, ws, "-400.00"))["category_id"] is None


async def test_counterparty_apply_skips_operations_with_a_category(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """Разбор заполняет пустоту, а не переписывает готовое: ни выбор человека,
    ни то, что проставила машина, не трогается."""
    ws, acc = await _register(client, ALICE)
    mine, other = (await _categories(client, ws, "expense"))[:2]
    await _import_transfer(client, ws, acc, "Денис З.", "-100.00")
    await _import_transfer(client, ws, acc, "Денис З.", "-200.00")
    await _import_transfer(client, ws, acc, "Денис З.", "-300.00")
    created = await _create_counterparty(client, ws, "Денис", ["денис з."], mine)

    chosen = await _operation(client, ws, "-200.00")
    edited = await client.patch(
        f"/api/transactions/{chosen['id']}",
        params={"workspace_id": ws},
        json={"category_id": other},
    )
    assert edited.status_code == 200
    # категория без подтверждения — так её проставляет машина
    guessed = await _operation(client, ws, "-300.00")
    stored = await ledger_repository.get_transaction(
        db_session, uuid.UUID(ws), uuid.UUID(guessed["id"])
    )
    assert stored is not None
    stored.category_id = uuid.UUID(other)
    await db_session.commit()

    assert await _uncategorized_count(client, ws, created["id"]) == 1
    assert await _apply_category(client, ws, created["id"]) == 1

    assert (await _operation(client, ws, "-100.00"))["category_id"] == mine
    assert (await _operation(client, ws, "-200.00"))["category_id"] == other
    assert (await _operation(client, ws, "-300.00"))["category_id"] == other


async def test_counterparty_apply_respects_a_dismissed_suggestion(client: AsyncClient) -> None:
    """Отклонённая подсказка — решение человека оставить операцию без категории.
    По одной пустой категории она неотличима от неразобранной, но трогать её
    нельзя: category_confirmed у такой строки уже стоит, и разложенная она ушла бы
    в примеры для модели как проверенная."""
    ws, acc = await _register(client, ALICE)
    category = await _expense_category(client, ws)
    await _import_transfer(client, ws, acc, "Денис З.", "-100.00")
    created = await _create_counterparty(client, ws, "Денис", ["денис з."], category)

    op = await _operation(client, ws, "-100.00")
    dismissed = await client.post(
        f"/api/transactions/{op['id']}/dismiss-suggestion", params={"workspace_id": ws}
    )
    assert dismissed.status_code == 200

    assert await _uncategorized_count(client, ws, created["id"]) == 0
    assert await _apply_category(client, ws, created["id"]) == 0
    assert (await _operation(client, ws, "-100.00"))["category_id"] is None


async def test_counterparty_apply_does_not_confirm_what_nobody_looked_at(
    client: AsyncClient,
) -> None:
    """Человек согласился распространить категорию, но каждую операцию глазами
    не видел. Пометив их подтверждёнными, мы отправили бы их в примеры для модели
    наравне с проверенными."""
    ws, acc = await _register(client, ALICE)
    category = await _expense_category(client, ws)
    await _import_transfer(client, ws, acc, "Денис З.", "-100.00")
    created = await _create_counterparty(client, ws, "Денис", ["денис з."], category)

    assert await _apply_category(client, ws, created["id"]) == 1

    op = await _operation(client, ws, "-100.00")
    assert op["category_id"] == category
    assert op["category_confirmed"] is False


async def test_expense_category_does_not_reach_an_incoming_transfer(client: AsyncClient) -> None:
    """У Дениса З. переводы идут в обе стороны: расходная категория на приходе
    не срабатывает — так же, как не срабатывает правило."""
    ws, acc = await _register(client, ALICE)
    category = await _expense_category(client, ws)
    await _import_transfer(client, ws, acc, "Денис З.", "-100.00")
    await _import_transfer(client, ws, acc, "Денис З.", "300.00")
    created = await _create_counterparty(client, ws, "Денис", ["денис з."], category)

    assert await _uncategorized_count(client, ws, created["id"]) == 1
    assert await _apply_category(client, ws, created["id"]) == 1

    assert (await _operation(client, ws, "-100.00"))["category_id"] == category
    assert (await _operation(client, ws, "300.00"))["category_id"] is None


async def test_income_category_does_not_reach_an_outgoing_transfer(client: AsyncClient) -> None:
    """То же в обратную сторону: доходная категория контрагента не липнет к тому,
    что ему отдали."""
    ws, acc = await _register(client, ALICE)
    category = await _income_category(client, ws)
    await _import_transfer(client, ws, acc, "Денис З.", "-100.00")
    await _import_transfer(client, ws, acc, "Денис З.", "300.00")
    created = await _create_counterparty(client, ws, "Денис", ["денис з."], category)

    assert await _uncategorized_count(client, ws, created["id"]) == 1
    assert await _apply_category(client, ws, created["id"]) == 1

    assert (await _operation(client, ws, "300.00"))["category_id"] == category
    assert (await _operation(client, ws, "-100.00"))["category_id"] is None


async def test_counterparty_without_category_has_nothing_to_apply(client: AsyncClient) -> None:
    """Контрагент без категории законен — раскладывать нечего. Ответ ноль, а не
    отказ, и уж точно не простановка пустоты вместо категории."""
    ws, acc = await _register(client, ALICE)
    await _import_transfer(client, ws, acc, "Денис З.", "-100.00")
    created = await _create_counterparty(client, ws, "Денис", ["денис з."])

    assert await _uncategorized_count(client, ws, created["id"]) == 0
    assert await _apply_category(client, ws, created["id"]) == 0

    op = await _operation(client, ws, "-100.00")
    assert op["category_id"] is None
    assert op["category_confirmed"] is False


async def test_counterparty_with_a_category_of_another_workspace_applies_nothing(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """Чужая категория — не категория: правило через такого контрагента её не
    отдаёт, и разбор обязан вести себя так же. Через API такую связь не завести,
    проверки заведения и правки её не пропустят, — складываем руками, как и в
    проверках разрешения правила выше."""
    ws_alice, _ = await _register(client, ALICE)
    alice_category = await _expense_category(client, ws_alice)

    client.cookies.clear()
    ws_bob, acc_bob = await _register(client, BOB)
    await _import_transfer(client, ws_bob, acc_bob, "Денис З.", "-100.00")
    cp = _add_counterparty(db_session, ws_bob, "Денис", alice_category)
    await db_session.flush()
    _add_signature(db_session, ws_bob, "денис з.", cp.id)
    await db_session.flush()

    assert await _uncategorized_count(client, ws_bob, str(cp.id)) == 0
    assert await _apply_category(client, ws_bob, str(cp.id)) == 0
    assert (await _operation(client, ws_bob, "-100.00"))["category_id"] is None


async def test_second_apply_finds_nothing(client: AsyncClient) -> None:
    """Первый разбор уже всё разложил, и разложенное больше не пустое."""
    ws, acc = await _register(client, ALICE)
    category = await _expense_category(client, ws)
    await _import_transfer(client, ws, acc, "Денис З.", "-100.00")
    created = await _create_counterparty(client, ws, "Денис", ["денис з."], category)

    assert await _apply_category(client, ws, created["id"]) == 1
    assert await _apply_category(client, ws, created["id"]) == 0
    assert await _uncategorized_count(client, ws, created["id"]) == 0


async def test_signature_of_another_workspace_does_not_widen_the_counterparty(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """Подписи контрагента ищутся в его workspace. Правило соседа, указывающее на
    моего контрагента, его подписью не становится — иначе разбор разложил бы мои
    операции по ключу, которого я ему не задавал."""
    ws_alice, acc_alice = await _register(client, ALICE)
    category = await _expense_category(client, ws_alice)
    await _import_transfer(client, ws_alice, acc_alice, "Денис З.", "-100.00")
    await _import_transfer(client, ws_alice, acc_alice, "Анастасия С.", "-200.00")
    created = await _create_counterparty(client, ws_alice, "Денис", ["денис з."], category)

    client.cookies.clear()
    ws_bob, _ = await _register(client, BOB)
    _add_signature(db_session, ws_bob, "анастасия с.", uuid.UUID(created["id"]))
    await db_session.flush()

    client.cookies.clear()
    await client.post("/api/auth/login", json=ALICE)
    assert await _uncategorized_count(client, ws_alice, created["id"]) == 1
    assert await _apply_category(client, ws_alice, created["id"]) == 1

    assert (await _operation(client, ws_alice, "-100.00"))["category_id"] == category
    assert (await _operation(client, ws_alice, "-200.00"))["category_id"] is None


async def test_operations_of_another_workspace_are_not_touched(client: AsyncClient) -> None:
    """Та же подпись у соседа — его дело: мой разбор её не видит и не трогает."""
    ws_alice, acc_alice = await _register(client, ALICE)
    category = await _expense_category(client, ws_alice)
    await _import_transfer(client, ws_alice, acc_alice, "Денис З.", "-100.00")

    client.cookies.clear()
    ws_bob, acc_bob = await _register(client, BOB)
    await _import_transfer(client, ws_bob, acc_bob, "Денис З.", "-200.00")

    client.cookies.clear()
    await client.post("/api/auth/login", json=ALICE)
    created = await _create_counterparty(client, ws_alice, "Денис", ["денис з."], category)
    assert await _uncategorized_count(client, ws_alice, created["id"]) == 1
    assert await _apply_category(client, ws_alice, created["id"]) == 1

    client.cookies.clear()
    await client.post("/api/auth/login", json=BOB)
    assert (await _operation(client, ws_bob, "-200.00"))["category_id"] is None


async def test_apply_for_unknown_counterparty_is_404(client: AsyncClient) -> None:
    ws, _ = await _register(client, ALICE)

    counted = await client.get(
        f"/api/counterparties/{uuid.uuid4()}/uncategorized", params={"workspace_id": ws}
    )
    assert counted.status_code == 404

    applied = await client.post(
        f"/api/counterparties/{uuid.uuid4()}/apply-category", params={"workspace_id": ws}
    )
    assert applied.status_code == 404


async def test_transaction_carries_counterparty_name(client: AsyncClient) -> None:
    """Ради этого контрагент и заводится: в ленте видно имя человека."""
    ws, acc = await _register(client, ALICE)
    await _import_transfer(client, ws, acc, "Денис З.", "-100.00")
    await _create_counterparty(client, ws, "Денис Зелинский", ["денис з."])

    operation = await _operation(client, ws, "-100.00")
    assert operation["counterparty_name"] == "Денис Зелинский"
    # банковская строка на месте: она — то, что прислал банк, и по ней потом
    # разбираются, почему подпись сопоставилась именно так
    assert operation["merchant"] == "Денис З."


async def test_transaction_without_counterparty_has_no_name(client: AsyncClient) -> None:
    ws, acc = await _register(client, ALICE)
    await _import_transfer(client, ws, acc, "Кто-то", "-100.00")

    operation = await _operation(client, ws, "-100.00")
    assert operation["counterparty_name"] is None
    assert operation["merchant"] == "Кто-то"


async def test_rule_into_category_gives_no_name(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """Правило, ведущее прямо в категорию, контрагента не называет: имени у него
    нет, и подставить в ленту нечего."""
    ws, acc = await _register(client, ALICE)
    category = await _expense_category(client, ws)
    await _import_transfer(client, ws, acc, "Пятёрочка", "-100.00")
    await ledger_service.create_description_rule(
        db_session, uuid.UUID(ws), "Пятёрочка", uuid.UUID(category)
    )
    await db_session.flush()

    assert (await _operation(client, ws, "-100.00"))["counterparty_name"] is None


async def test_name_is_found_by_the_normalized_signature(client: AsyncClient) -> None:
    """Имя достаётся по тому же ключу, что и категория: банк пишет описание как
    придётся, а подпись у контрагента одна."""
    ws, acc = await _register(client, ALICE)
    await _import_transfer(client, ws, acc, "  ДЕНИС   З.  ", "-100.00")
    await _create_counterparty(client, ws, "Денис Зелинский", ["денис з."])

    operation = await _operation(client, ws, "-100.00")
    assert operation["counterparty_name"] == "Денис Зелинский"
    assert operation["merchant"] == "  ДЕНИС   З.  "


async def test_renaming_counterparty_renames_him_in_the_feed(client: AsyncClient) -> None:
    """Имя в операции не хранится, а достаётся через подпись: иначе
    переименование пришлось бы разносить по всей истории."""
    ws, acc = await _register(client, ALICE)
    await _import_transfer(client, ws, acc, "Денис З.", "-100.00")
    created = await _create_counterparty(client, ws, "Денис", ["денис з."])

    renamed = await client.patch(
        f"/api/counterparties/{created['id']}",
        params={"workspace_id": ws},
        json={"name": "Денис Зелинский"},
    )
    assert renamed.status_code == 200

    assert (await _operation(client, ws, "-100.00"))["counterparty_name"] == "Денис Зелинский"


async def test_edited_transaction_still_carries_the_name(client: AsyncClient) -> None:
    """Ответ по одной операции несёт имя так же, как лента: иначе поле молча
    пустовало бы на всех ручках, кроме списка."""
    ws, acc = await _register(client, ALICE)
    await _import_transfer(client, ws, acc, "Денис З.", "-100.00")
    await _create_counterparty(client, ws, "Денис Зелинский", ["денис з."])
    operation = await _operation(client, ws, "-100.00")

    edited = await client.patch(
        f"/api/transactions/{operation['id']}",
        params={"workspace_id": ws},
        json={"note": "за обед"},
    )
    assert edited.status_code == 200
    assert edited.json()["counterparty_name"] == "Денис Зелинский"


async def test_counterparty_name_does_not_leak_between_workspaces(client: AsyncClient) -> None:
    """У чужого workspace контрагент с тем же ключом подписи: моя операция
    обязана остаться безымянной, а не назваться его именем."""
    ws_alice, acc_alice = await _register(client, ALICE)
    await _import_transfer(client, ws_alice, acc_alice, "Денис З.", "-100.00")

    ws_bob, _ = await _register(client, BOB)
    await _create_counterparty(client, ws_bob, "Денис Зелинский", ["денис з."])

    client.cookies.clear()
    await client.post("/api/auth/login", json=ALICE)
    assert (await _operation(client, ws_alice, "-100.00"))["counterparty_name"] is None


async def test_transaction_does_not_take_a_counterparty_of_another_workspace(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """Испорчено звено «правило → контрагент»: правило своё, а контрагент чужой.
    Фильтр по операциям такую связь не отсекает — имя достаётся прямо из
    контрагента, и отсечь его больше некому."""
    ws_alice, acc_alice = await _register(client, ALICE)
    await _import_transfer(client, ws_alice, acc_alice, "Денис З.", "-100.00")

    ws_bob, _ = await _register(client, BOB)
    alien = _add_counterparty(db_session, ws_bob, "Денис Зелинский", None)
    await db_session.flush()
    _add_signature(db_session, ws_alice, "денис з.", alien.id)
    await db_session.flush()

    client.cookies.clear()
    await client.post("/api/auth/login", json=ALICE)
    assert (await _operation(client, ws_alice, "-100.00"))["counterparty_name"] is None


async def test_transaction_does_not_take_a_rule_of_another_workspace(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """Зеркальный случай: контрагент свой, а правило с его подписью — чужое.
    Фильтр на контрагенте здесь молчит: контрагент как раз мой, — и остановить
    такую связь обязан фильтр на правиле. Иначе чужая строка в чужом workspace
    решала бы, какое из моих имён достанется моей операции."""
    ws_alice, acc_alice = await _register(client, ALICE)
    await _import_transfer(client, ws_alice, acc_alice, "Денис З.", "-100.00")
    mine = _add_counterparty(db_session, ws_alice, "Денис Зелинский", None)
    await db_session.flush()

    ws_bob, _ = await _register(client, BOB)
    _add_signature(db_session, ws_bob, "денис з.", mine.id)
    await db_session.flush()

    client.cookies.clear()
    await client.post("/api/auth/login", json=ALICE)
    assert (await _operation(client, ws_alice, "-100.00"))["counterparty_name"] is None


async def test_operations_of_another_workspace_are_not_named(client: AsyncClient) -> None:
    """Своя лента не тянет чужие операции даже тем же именем: у обоих workspace
    контрагент есть, и перепутать строки нечему."""
    ws_alice, acc_alice = await _register(client, ALICE)
    await _import_transfer(client, ws_alice, acc_alice, "Денис З.", "-100.00")
    await _create_counterparty(client, ws_alice, "Денис Зелинский", ["денис з."])

    ws_bob, acc_bob = await _register(client, BOB)
    await _import_transfer(client, ws_bob, acc_bob, "Денис З.", "-200.00")
    await _create_counterparty(client, ws_bob, "Денис Другой", ["денис з."])

    items = (await client.get("/api/transactions", params={"workspace_id": ws_bob})).json()["items"]
    assert [(t["merchant"], t["counterparty_name"]) for t in items] == [
        ("Денис З.", "Денис Другой")
    ]
