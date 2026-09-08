import uuid
from decimal import Decimal

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

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
