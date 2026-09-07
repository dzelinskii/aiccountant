import uuid
from typing import Any

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.ledger import repository as ledger_repository
from app.ledger.models import Transaction

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
    resp = await client.get("/api/categories", params={"workspace_id": ws})
    assert resp.status_code == 200
    return [str(c["id"]) for c in resp.json() if c["kind"] == kind]


async def _category_id(client: AsyncClient, ws: str, kind: str) -> str:
    return (await _categories(client, ws, kind))[0]


async def _add_transaction(
    client: AsyncClient,
    ws: str,
    acc: str,
    merchant: str | None,
    *,
    category_id: str | None = None,
    amount: str = "-450.00",
) -> str:
    # сумма строкой: деньги в этом проекте не проходят через float нигде,
    # включая тесты
    body: dict[str, Any] = {"account_id": acc, "amount": amount, "occurred_at": "2026-09-01"}
    if merchant is not None:
        body["merchant"] = merchant
    if category_id is not None:
        body["category_id"] = category_id
    created = await client.post("/api/transactions", params={"workspace_id": ws}, json=body)
    assert created.status_code == 201
    return str(created.json()["id"])


async def _confirm_category(
    client: AsyncClient, ws: str, transaction_id: str, category_id: str
) -> dict[str, Any]:
    """Человек явно выбрал категорию у операции — то самое подтверждение."""
    resp = await client.patch(
        f"/api/transactions/{transaction_id}",
        params={"workspace_id": ws},
        json={"category_id": category_id},
    )
    assert resp.status_code == 200
    item: dict[str, Any] = resp.json()
    return item


async def _rules(client: AsyncClient, ws: str) -> list[tuple[str, str, str]]:
    """Правила workspace тройками «ключ, категория, происхождение»."""
    resp = await client.get("/api/description-rules", params={"workspace_id": ws})
    assert resp.status_code == 200
    return [(r["normalized_text"], r["category_id"], r["source"]) for r in resp.json()]


async def _similar_count(client: AsyncClient, ws: str, transaction_id: str) -> int:
    resp = await client.get(
        f"/api/transactions/{transaction_id}/similar-uncategorized", params={"workspace_id": ws}
    )
    assert resp.status_code == 200
    count: int = resp.json()["count"]
    return count


async def _apply_to_similar(client: AsyncClient, ws: str, transaction_id: str) -> int:
    resp = await client.post(
        f"/api/transactions/{transaction_id}/apply-category-to-similar",
        params={"workspace_id": ws},
    )
    assert resp.status_code == 200
    applied: int = resp.json()["applied"]
    return applied


async def _transactions_by_id(client: AsyncClient, ws: str) -> dict[str, dict[str, Any]]:
    resp = await client.get("/api/transactions", params={"workspace_id": ws})
    assert resp.status_code == 200
    return {str(t["id"]): t for t in resp.json()["items"]}


async def test_confirmation_learns_rule(client: AsyncClient) -> None:
    """Подтвердил категорию — система запомнила. Ключом идёт нормализованное
    описание: правило обязано сработать и на «КОФЕЙНЯ  У  ДОМА» из следующей
    выписки, а не только на буквально ту же строку."""
    ws, acc = await _register(client, ALICE)
    cat = await _category_id(client, ws, "expense")
    transaction = await _add_transaction(client, ws, acc, "  Кофейня   У Дома ")

    await _confirm_category(client, ws, transaction, cat)

    assert await _rules(client, ws) == [("кофейня у дома", cat, "learned")]


async def test_next_confirmation_updates_learned_rule(client: AsyncClient) -> None:
    """Последнее подтверждение и есть текущее намерение человека: выученное
    правило обновляется, а не превращается во второе для того же описания."""
    ws, acc = await _register(client, ALICE)
    first, second = (await _categories(client, ws, "expense"))[:2]
    transaction = await _add_transaction(client, ws, acc, "Кофейня")

    await _confirm_category(client, ws, transaction, first)
    await _confirm_category(client, ws, transaction, second)

    assert await _rules(client, ws) == [("кофейня", second, "learned")]


async def test_manual_rule_is_not_overwritten(client: AsyncClient) -> None:
    """Кто завёл правило сам, не ждёт, что оно поменяется от правки одной
    операции. Правку это не отменяет — она касается только этой операции."""
    ws, acc = await _register(client, ALICE)
    by_hand, chosen = (await _categories(client, ws, "expense"))[:2]
    created = await client.post(
        "/api/description-rules",
        params={"workspace_id": ws},
        json={"text": "Кофейня", "category_id": by_hand},
    )
    assert created.status_code == 201
    transaction = await _add_transaction(client, ws, acc, "Кофейня")

    confirmed = await _confirm_category(client, ws, transaction, chosen)

    assert confirmed["category_id"] == chosen
    assert await _rules(client, ws) == [("кофейня", by_hand, "manual")]


async def test_dismissing_suggestion_learns_nothing(client: AsyncClient) -> None:
    """Отклонение подсказки — отказ от категории, а не выбор: учиться нечему.

    Категория у операции при этом стоит: без неё правило не вышло бы в любом
    случае, и проверка ничего бы не стерегла.
    """
    ws, acc = await _register(client, ALICE)
    cat = await _category_id(client, ws, "expense")
    transaction = await _add_transaction(client, ws, acc, "Кофейня", category_id=cat)

    dismissed = await client.post(
        f"/api/transactions/{transaction}/dismiss-suggestion", params={"workspace_id": ws}
    )
    assert dismissed.status_code == 200

    assert await _rules(client, ws) == []


async def test_transaction_without_description_learns_nothing(client: AsyncClient) -> None:
    ws, acc = await _register(client, ALICE)
    cat = await _category_id(client, ws, "expense")
    transaction = await _add_transaction(client, ws, acc, None)

    confirmed = await _confirm_category(client, ws, transaction, cat)

    assert confirmed["category_id"] == cat
    assert await _rules(client, ws) == []


async def test_blank_description_learns_nothing(client: AsyncClient) -> None:
    """Из одних пробелов вышел бы пустой ключ — он ловил бы любую операцию
    с пробельным описанием и занимал бы уникальную пару."""
    ws, acc = await _register(client, ALICE)
    cat = await _category_id(client, ws, "expense")
    transaction = await _add_transaction(client, ws, acc, "   ")

    confirmed = await _confirm_category(client, ws, transaction, cat)

    assert confirmed["category_id"] == cat
    assert await _rules(client, ws) == []


async def test_racing_confirmation_does_not_break_the_edit(
    client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Окно гонки: правило для описания уже есть, но поиск его не увидел —
    отвечает уникальный индекс. Правка операции обязана уцелеть: выученное
    правило не настолько важно, чтобы из-за него провалилось подтверждение."""
    ws, acc = await _register(client, ALICE)
    existing_cat, chosen = (await _categories(client, ws, "expense"))[:2]
    created = await client.post(
        "/api/description-rules",
        params={"workspace_id": ws},
        json={"text": "Кофейня", "category_id": existing_cat},
    )
    assert created.status_code == 201
    transaction = await _add_transaction(client, ws, acc, "Кофейня")

    async def blind(*args: object, **kwargs: object) -> None:
        return None

    monkeypatch.setattr(ledger_repository, "find_description_rule", blind)
    confirmed = await _confirm_category(client, ws, transaction, chosen)

    assert confirmed["category_id"] == chosen
    monkeypatch.undo()
    assert await _rules(client, ws) == [("кофейня", existing_cat, "manual")]
    stored = await ledger_repository.get_transaction(
        db_session, uuid.UUID(ws), uuid.UUID(transaction)
    )
    assert stored is not None
    assert str(stored.category_id) == chosen


async def test_learning_does_not_see_a_rule_of_another_workspace(client: AsyncClient) -> None:
    """Правило соседа для того же описания обучению не помеха и не добыча:
    «manual сильнее learned» действует внутри своего workspace, а через границу
    правила друг о друге не знают вовсе."""
    ws_b, _acc_b = await _register(client, BOB)
    theirs = await _category_id(client, ws_b, "expense")
    created = await client.post(
        "/api/description-rules",
        params={"workspace_id": ws_b},
        json={"text": "Кофейня", "category_id": theirs},
    )
    assert created.status_code == 201

    client.cookies.clear()
    ws_a, acc_a = await _register(client, ALICE)
    mine = await _category_id(client, ws_a, "expense")
    transaction = await _add_transaction(client, ws_a, acc_a, "Кофейня")

    await _confirm_category(client, ws_a, transaction, mine)

    assert await _rules(client, ws_a) == [("кофейня", mine, "learned")]

    client.cookies.clear()
    await client.post("/api/auth/login", json=BOB)
    assert await _rules(client, ws_b) == [("кофейня", theirs, "manual")]


async def test_similar_count_does_not_count_the_transaction_itself(client: AsyncClient) -> None:
    """Вопрос звучит «нашлось ещё N таких» — «ещё», то есть кроме той операции,
    от которой отталкиваемся. Пока она сама без категории, её легко посчитать
    вместе с остальными и предложить разложить на одну больше, чем есть."""
    ws, acc = await _register(client, ALICE)
    cat = await _category_id(client, ws, "expense")
    source = await _add_transaction(client, ws, acc, "Кофейня")
    await _add_transaction(client, ws, acc, "Кофейня")
    await _add_transaction(client, ws, acc, "Кофейня")
    await _add_transaction(client, ws, acc, "Аптека")

    assert await _similar_count(client, ws, source) == 2

    await _confirm_category(client, ws, source, cat)

    assert await _similar_count(client, ws, source) == 2


async def test_similar_count_skips_operations_with_a_category(client: AsyncClient) -> None:
    """Разбор заполняет пустоту, а не переписывает готовое: и выбор человека,
    и то, что уже проставила машина, остаются как есть — значит, и в подсчёт
    они не входят."""
    ws, acc = await _register(client, ALICE)
    chosen, other = (await _categories(client, ws, "expense"))[:2]
    source = await _add_transaction(client, ws, acc, "Кофейня")
    by_hand = await _add_transaction(client, ws, acc, "Кофейня")
    await _confirm_category(client, ws, by_hand, other)
    await _add_transaction(client, ws, acc, "Кофейня", category_id=other)  # как от машины
    await _add_transaction(client, ws, acc, "Кофейня")
    await _confirm_category(client, ws, source, chosen)

    assert await _similar_count(client, ws, source) == 1


async def test_dismissed_suggestion_is_not_a_candidate(client: AsyncClient) -> None:
    """Отклонение подсказки — решение человека оставить операцию без категории.
    Категории у такой строки нет, и по одной пустоте она неотличима
    от неразобранной, но трогать её нельзя.

    Иначе выходит худшее из возможного: разбор ставит категорию, а
    category_confirmed у строки уже стоит от отклонения — и она уходит
    в примеры для модели как проверенная человеком.
    """
    ws, acc = await _register(client, ALICE)
    cat = await _category_id(client, ws, "expense")
    source = await _add_transaction(client, ws, acc, "Кофейня")
    dismissed = await _add_transaction(client, ws, acc, "Кофейня")
    resp = await client.post(
        f"/api/transactions/{dismissed}/dismiss-suggestion", params={"workspace_id": ws}
    )
    assert resp.status_code == 200
    await _confirm_category(client, ws, source, cat)

    assert await _similar_count(client, ws, source) == 0
    assert await _apply_to_similar(client, ws, source) == 0
    assert (await _transactions_by_id(client, ws))[dismissed]["category_id"] is None


async def test_expense_category_does_not_reach_a_refund(client: AsyncClient) -> None:
    """«Кофейня −450» и «Кофейня +450» (возврат или кэшбэк) в одной выписке —
    обычное дело. Расходная категория на приходе нарушает инвариант, который
    стерегут все остальные пути записи: дальше эту строку не сможет починить
    даже правка примечания — проверка пары отвечает отказом на любую."""
    ws, acc = await _register(client, ALICE)
    cat = await _category_id(client, ws, "expense")
    source = await _add_transaction(client, ws, acc, "Кофейня")
    refund = await _add_transaction(client, ws, acc, "Кофейня", amount="450.00")
    await _confirm_category(client, ws, source, cat)

    assert await _similar_count(client, ws, source) == 0
    assert await _apply_to_similar(client, ws, source) == 0
    assert (await _transactions_by_id(client, ws))[refund]["category_id"] is None


async def test_income_category_does_not_reach_a_spending(client: AsyncClient) -> None:
    """То же в обратную сторону: доходная категория не липнет к трате."""
    ws, acc = await _register(client, ALICE)
    cat = await _category_id(client, ws, "income")
    source = await _add_transaction(client, ws, acc, "Кофейня", amount="450.00")
    spending = await _add_transaction(client, ws, acc, "Кофейня")
    await _confirm_category(client, ws, source, cat)

    assert await _similar_count(client, ws, source) == 0
    assert await _apply_to_similar(client, ws, source) == 0
    assert (await _transactions_by_id(client, ws))[spending]["category_id"] is None


async def test_operation_out_of_statistics_is_not_a_candidate(client: AsyncClient) -> None:
    """Что выведено из статистики, система не категоризует — так отбирает
    операции путь модели. Разбор отвечает на тот же вопрос «что подлежит
    категоризации» и обязан отвечать тем же условием."""
    ws, acc = await _register(client, ALICE)
    cat = await _category_id(client, ws, "expense")
    source = await _add_transaction(client, ws, acc, "Кофейня")
    aside = await _add_transaction(client, ws, acc, "Кофейня")
    excluded = await client.patch(
        f"/api/transactions/{aside}",
        params={"workspace_id": ws},
        json={"spending_override": False},
    )
    assert excluded.status_code == 200
    await _confirm_category(client, ws, source, cat)

    assert await _similar_count(client, ws, source) == 0
    assert await _apply_to_similar(client, ws, source) == 0
    assert (await _transactions_by_id(client, ws))[aside]["category_id"] is None


async def test_similar_count_matches_by_normalized_description(client: AsyncClient) -> None:
    """Ключ здесь тот же, что у правил, — нормализованное описание. Банк
    присылает одну и ту же точку то капсом, то с двойными пробелами, и такие
    операции человек считает одинаковыми."""
    ws, acc = await _register(client, ALICE)
    cat = await _category_id(client, ws, "expense")
    source = await _add_transaction(client, ws, acc, "Кофейня у дома")
    await _add_transaction(client, ws, acc, "КОФЕЙНЯ У ДОМА")
    await _add_transaction(client, ws, acc, "  Кофейня   у   дома  ")
    await _confirm_category(client, ws, source, cat)

    assert await _similar_count(client, ws, source) == 2


async def test_similar_count_is_zero_without_a_key(client: AsyncClient) -> None:
    """Нет описания — нет ключа, и похожих быть не может. Строка из одних
    пробелов даёт пустой ключ: по нему в одну кучу собрались бы все операции
    с пробельным описанием."""
    ws, acc = await _register(client, ALICE)
    cat = await _category_id(client, ws, "expense")
    blank = await _add_transaction(client, ws, acc, "   ")
    await _add_transaction(client, ws, acc, "   ")
    source = await _add_transaction(client, ws, acc, None)
    await _add_transaction(client, ws, acc, None)
    await _confirm_category(client, ws, source, cat)
    await _confirm_category(client, ws, blank, cat)

    assert await _similar_count(client, ws, source) == 0
    assert await _similar_count(client, ws, blank) == 0


async def test_similar_count_for_unknown_transaction_is_404(client: AsyncClient) -> None:
    ws, _acc = await _register(client, ALICE)

    resp = await client.get(
        f"/api/transactions/{uuid.uuid4()}/similar-uncategorized", params={"workspace_id": ws}
    )
    assert resp.status_code == 404

    applied = await client.post(
        f"/api/transactions/{uuid.uuid4()}/apply-category-to-similar",
        params={"workspace_id": ws},
    )
    assert applied.status_code == 404


async def test_applying_fills_only_operations_without_a_category(client: AsyncClient) -> None:
    ws, acc = await _register(client, ALICE)
    chosen, other = (await _categories(client, ws, "expense"))[:2]
    source = await _add_transaction(client, ws, acc, "Кофейня")
    empty = await _add_transaction(client, ws, acc, "Кофейня")
    written_differently = await _add_transaction(client, ws, acc, "  КОФЕЙНЯ ")
    taken = await _add_transaction(client, ws, acc, "Кофейня", category_id=other)
    stranger = await _add_transaction(client, ws, acc, "Аптека")
    await _confirm_category(client, ws, source, chosen)

    assert await _apply_to_similar(client, ws, source) == 2

    items = await _transactions_by_id(client, ws)
    assert items[empty]["category_id"] == chosen
    assert items[written_differently]["category_id"] == chosen
    assert items[taken]["category_id"] == other
    assert items[stranger]["category_id"] is None


async def test_applying_does_not_confirm_what_nobody_looked_at(client: AsyncClient) -> None:
    """Человек подтвердил одну операцию и согласился распространить решение,
    но остальные глазами не видел. Пометив их подтверждёнными, мы отправили бы
    их в примеры для модели наравне с проверенными — и ошибка размножилась бы."""
    ws, acc = await _register(client, ALICE)
    cat = await _category_id(client, ws, "expense")
    source = await _add_transaction(client, ws, acc, "Кофейня")
    spread = await _add_transaction(client, ws, acc, "Кофейня")
    await _confirm_category(client, ws, source, cat)

    assert await _apply_to_similar(client, ws, source) == 1

    items = await _transactions_by_id(client, ws)
    assert items[spread]["category_id"] == cat
    assert items[spread]["category_confirmed"] is False
    assert items[source]["category_confirmed"] is True


async def test_second_applying_finds_nothing(client: AsyncClient) -> None:
    """Первый разбор уже всё разложил, и разложенное больше не пустое."""
    ws, acc = await _register(client, ALICE)
    cat = await _category_id(client, ws, "expense")
    source = await _add_transaction(client, ws, acc, "Кофейня")
    await _add_transaction(client, ws, acc, "Кофейня")
    await _confirm_category(client, ws, source, cat)

    assert await _apply_to_similar(client, ws, source) == 1
    assert await _apply_to_similar(client, ws, source) == 0


async def test_applying_clears_the_pending_suggestion(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """Категория проставлена — подсказка про ту же операцию больше не вопрос.
    Правка человеком гасит её так же; иначе остаётся строка с категорией
    и живой подсказкой, чего в интерфейсе не видно, а в данных противоречие."""
    ws, acc = await _register(client, ALICE)
    chosen, suggested = (await _categories(client, ws, "expense"))[:2]
    source = await _add_transaction(client, ws, acc, "Кофейня")
    pending = await _add_transaction(client, ws, acc, "Кофейня")
    # подсказку ставит классификатор, ручки для неё нет — пишем прямо
    stored = await ledger_repository.get_transaction(db_session, uuid.UUID(ws), uuid.UUID(pending))
    assert stored is not None
    stored.suggested_category_id = uuid.UUID(suggested)
    await db_session.commit()
    await _confirm_category(client, ws, source, chosen)

    assert await _apply_to_similar(client, ws, source) == 1

    item = (await _transactions_by_id(client, ws))[pending]
    assert item["category_id"] == chosen
    assert item["suggested_category_id"] is None


async def test_applying_does_not_overwrite_a_category_set_after_the_read(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Окно между отбором кандидатов и записью: категорию успел проставить
    чужой коммит. Источник конкуренции настоящий — фоновая категоризация держит
    транзакцию открытой на весь проход и коммитит один раз в конце.

    Гонку изображаем устаревшим отбором: он отдаёт строку, у которой категория
    к моменту записи уже есть. Запись обязана проверить пустоту сама.
    """
    ws, acc = await _register(client, ALICE)
    chosen, other = (await _categories(client, ws, "expense"))[:2]
    source = await _add_transaction(client, ws, acc, "Кофейня")
    taken = await _add_transaction(client, ws, acc, "Кофейня", category_id=other)
    await _confirm_category(client, ws, source, chosen)

    async def stale(
        db: AsyncSession, workspace_id: uuid.UUID, **kwargs: object
    ) -> list[Transaction]:
        found = await ledger_repository.get_transaction(db, workspace_id, uuid.UUID(taken))
        assert found is not None
        return [found]

    monkeypatch.setattr(ledger_repository, "uncategorized_with_description", stale)
    assert await _apply_to_similar(client, ws, source) == 0
    monkeypatch.undo()

    assert (await _transactions_by_id(client, ws))[taken]["category_id"] == other


async def test_similar_operations_of_another_workspace_are_invisible(client: AsyncClient) -> None:
    ws_a, acc_a = await _register(client, ALICE)
    cat = await _category_id(client, ws_a, "expense")
    source = await _add_transaction(client, ws_a, acc_a, "Кофейня")
    await _add_transaction(client, ws_a, acc_a, "Кофейня")

    client.cookies.clear()
    ws_b, acc_b = await _register(client, BOB)
    theirs = await _add_transaction(client, ws_b, acc_b, "Кофейня")

    client.cookies.clear()
    await client.post("/api/auth/login", json=ALICE)
    await _confirm_category(client, ws_a, source, cat)

    assert await _similar_count(client, ws_a, source) == 1
    assert await _apply_to_similar(client, ws_a, source) == 1

    client.cookies.clear()
    await client.post("/api/auth/login", json=BOB)
    assert (await _transactions_by_id(client, ws_b))[theirs]["category_id"] is None


async def test_setting_category_never_reaches_another_workspace(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """Массовая простановка стоит на своих ногах: даже получив идентификатор
    чужой операции, она его не тронет. Фильтр по workspace живёт в каждом
    запросе отдельно — снятый в одном месте, он не должен открывать дверь
    в другом."""
    ws_a, _acc_a = await _register(client, ALICE)
    cat = await _category_id(client, ws_a, "expense")

    client.cookies.clear()
    ws_b, acc_b = await _register(client, BOB)
    theirs = await _add_transaction(client, ws_b, acc_b, "Кофейня")

    applied = await ledger_repository.set_category_for(
        db_session, uuid.UUID(ws_a), [uuid.UUID(theirs)], uuid.UUID(cat)
    )
    await db_session.commit()

    assert applied == 0
    stored = await ledger_repository.get_transaction(db_session, uuid.UUID(ws_b), uuid.UUID(theirs))
    assert stored is not None
    assert stored.category_id is None
