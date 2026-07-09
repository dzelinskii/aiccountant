import json
import uuid
from datetime import date
from decimal import Decimal

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.ledger import categorization as c
from app.ledger import repository, service
from app.ledger.models import Category


def _cat(name: str, kind: str) -> Category:
    cat = Category(name=name, kind=kind)
    cat.id = uuid.uuid4()
    return cat


def test_choose_candidates_filters_by_sign() -> None:
    cats = [_cat("Еда", "expense"), _cat("Зарплата", "income")]
    assert [x.name for x in c.choose_candidates(cats, Decimal("-5"))] == ["Еда"]
    assert [x.name for x in c.choose_candidates(cats, Decimal("5"))] == ["Зарплата"]


def test_parse_answer_valid_name_and_confidence() -> None:
    raw = json.dumps({"category": "Еда", "confidence": 0.95})
    name, conf = c.parse_answer(raw, {"Еда", "Транспорт"})
    assert name == "Еда"
    assert conf == Decimal("0.950")


def test_parse_answer_unknown_name_becomes_none() -> None:
    raw = json.dumps({"category": "Криптовалюта", "confidence": 0.99})
    name, conf = c.parse_answer(raw, {"Еда"})
    assert name is None


def test_parse_answer_broken_json_is_none_zero() -> None:
    name, conf = c.parse_answer("не json", {"Еда"})
    assert name is None
    assert conf == Decimal("0")


def test_parse_answer_non_scalar_category_is_none() -> None:
    raw = json.dumps({"category": [1, 2], "confidence": 0.9})
    name, _ = c.parse_answer(raw, {"Еда"})
    assert name is None


def test_parse_answer_nan_confidence_is_zero() -> None:
    raw = json.dumps({"category": "Еда", "confidence": "NaN"})
    name, conf = c.parse_answer(raw, {"Еда"})
    assert name == "Еда"
    assert conf == Decimal("0")


def test_parse_answer_confidence_clamped() -> None:
    _, conf = c.parse_answer(json.dumps({"category": "Еда", "confidence": 5}), {"Еда"})
    assert conf == Decimal("1.000")


def test_decide_apply_above_threshold() -> None:
    by_name = {"Еда": uuid.uuid4()}
    d = c.decide("Еда", Decimal("0.9"), Decimal("0.8"), by_name)
    assert d.kind == "apply"
    assert d.category_id == by_name["Еда"]


def test_decide_suggest_below_threshold() -> None:
    by_name = {"Еда": uuid.uuid4()}
    d = c.decide("Еда", Decimal("0.5"), Decimal("0.8"), by_name)
    assert d.kind == "suggest"
    assert d.category_id == by_name["Еда"]


def test_decide_none_when_no_name() -> None:
    d = c.decide(None, Decimal("0"), Decimal("0.8"), {})
    assert d.kind == "none"
    assert d.category_id is None


ALICE = {"email": "alice@example.com", "password": "password123"}


class FakeLLM:
    """LLMClient с очередью записанных ответов (по одному на операцию)."""

    def __init__(self, answers: list[str]) -> None:
        self._answers = list(answers)
        self.prompts: list[str] = []

    async def complete_json(self, *, system: str, user: str) -> str:
        self.prompts.append(user)
        return self._answers.pop(0)


async def _bootstrap(client: AsyncClient) -> tuple[uuid.UUID, uuid.UUID, uuid.UUID]:
    reg = await client.post("/api/auth/register", json=ALICE)
    user_id = uuid.UUID(reg.json()["id"])
    me = await client.get("/api/me")
    ws = uuid.UUID(me.json()["workspaces"][0]["id"])
    acc = uuid.UUID(
        (
            await client.post(
                "/api/accounts",
                params={"workspace_id": str(ws)},
                json={"name": "Карта", "type": "card", "currency": "RUB"},
            )
        ).json()["id"]
    )
    return user_id, ws, acc


async def test_categorize_applies_above_and_suggests_below_threshold(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    user_id, ws, acc = await _bootstrap(client)
    high = await service.post_transaction(
        db_session,
        ws,
        user_id,
        account_id=acc,
        category_id=None,
        amount=Decimal("-100.00"),
        occurred_at=date(2026, 7, 5),
        source="import",
        merchant="Пятёрочка",
    )
    low = await service.post_transaction(
        db_session,
        ws,
        user_id,
        account_id=acc,
        category_id=None,
        amount=Decimal("-200.00"),
        occurred_at=date(2026, 7, 5),
        source="import",
        merchant="Непонятный мерчант",
    )
    await db_session.commit()

    llm = FakeLLM(
        [
            json.dumps({"category": "Еда", "confidence": 0.95}),
            json.dumps({"category": "Еда", "confidence": 0.4}),
        ]
    )
    processed = await c.categorize_uncategorized(
        db_session, ws, llm, threshold=Decimal("0.8"), fewshot_limit=10
    )
    assert processed == 2

    await db_session.refresh(high)
    await db_session.refresh(low)
    cats = await repository.list_categories(db_session, ws)
    food_id = next(cat.id for cat in cats if cat.name == "Еда")

    # выше порога — авто-простановка, не подтверждена человеком
    assert high.category_id == food_id
    assert high.category_confirmed is False
    assert high.category_confidence == Decimal("0.950")
    assert high.suggested_category_id is None
    # ниже порога — только подсказка
    assert low.category_id is None
    assert low.suggested_category_id == food_id
    assert low.category_confidence == Decimal("0.400")


async def test_categorize_leaves_uncategorized_on_broken_answer(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    user_id, ws, acc = await _bootstrap(client)
    txn = await service.post_transaction(
        db_session,
        ws,
        user_id,
        account_id=acc,
        category_id=None,
        amount=Decimal("-50.00"),
        occurred_at=date(2026, 7, 5),
        source="import",
        merchant="Что-то",
    )
    await db_session.commit()

    llm = FakeLLM(["это не json"])
    await c.categorize_uncategorized(
        db_session, ws, llm, threshold=Decimal("0.8"), fewshot_limit=10
    )
    await db_session.refresh(txn)
    assert txn.category_id is None
    assert txn.suggested_category_id is None


async def test_categorize_isolates_workspaces(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    # alice: своя операция без категории, её категоризацию НЕ запускаем
    alice_id, ws_alice, acc_alice = await _bootstrap(client)
    alice_txn = await service.post_transaction(
        db_session,
        ws_alice,
        alice_id,
        account_id=acc_alice,
        category_id=None,
        amount=Decimal("-100.00"),
        occurred_at=date(2026, 7, 5),
        source="import",
        merchant="Алисина еда",
    )
    # bob: свой workspace и операция без категории
    bob = {"email": "bob@example.com", "password": "password123"}
    reg2 = await client.post("/api/auth/register", json=bob)
    bob_id = uuid.UUID(reg2.json()["id"])
    me2 = await client.get("/api/me")  # активна сессия bob
    ws_bob = uuid.UUID(me2.json()["workspaces"][0]["id"])
    acc_bob = uuid.UUID(
        (
            await client.post(
                "/api/accounts",
                params={"workspace_id": str(ws_bob)},
                json={"name": "Нал", "type": "cash", "currency": "RUB"},
            )
        ).json()["id"]
    )
    bob_txn = await service.post_transaction(
        db_session,
        ws_bob,
        bob_id,
        account_id=acc_bob,
        category_id=None,
        amount=Decimal("-50.00"),
        occurred_at=date(2026, 7, 5),
        source="import",
        merchant="Бобова еда",
    )
    await db_session.commit()

    # категоризируем ТОЛЬКО workspace bob
    llm = FakeLLM([json.dumps({"category": "Еда", "confidence": 0.95})])
    processed = await c.categorize_uncategorized(
        db_session, ws_bob, llm, threshold=Decimal("0.8"), fewshot_limit=10
    )
    assert processed == 1

    cats_bob = await repository.list_categories(db_session, ws_bob)
    food_bob = next(cat.id for cat in cats_bob if cat.name == "Еда")

    await db_session.refresh(bob_txn)
    await db_session.refresh(alice_txn)
    # операция bob категоризирована
    assert bob_txn.category_id == food_bob
    # операция alice не затронута — реальная проверка изоляции по workspace_id
    assert alice_txn.category_id is None
    assert alice_txn.suggested_category_id is None
    assert alice_txn.category_confidence is None
