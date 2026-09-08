import uuid
from decimal import Decimal
from typing import Any

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


async def _expense_category(client: AsyncClient, ws: str) -> str:
    cats = (await client.get("/api/categories", params={"workspace_id": ws})).json()
    return str(next(c for c in cats if c["kind"] == "expense")["id"])


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
