import uuid
from collections.abc import Awaitable, Callable
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.imports import repository, service
from app.imports.parser import ParsedOperation, ParsedStatement, StatementParseError
from app.ledger import service as ledger_service

ALICE = {"email": "alice@example.com", "password": "password123"}
BOB = {"email": "bob@example.com", "password": "password123"}

SAMPLE = ParsedStatement(
    operations=[
        ParsedOperation(
            occurred_at=date(2026, 7, 5),
            amount=Decimal("-1150.00"),
            currency="RUB",
            description="Кофейня",
        ),
        ParsedOperation(
            occurred_at=date(2026, 7, 6),
            amount=Decimal("5000.00"),
            currency="RUB",
            description="Зарплата",
        ),
    ],
    total_income=Decimal("5000.00"),
    total_expense=Decimal("1150.00"),
)


def _fixed_parse(
    statement: ParsedStatement, name: str
) -> Callable[[list[str]], Awaitable[tuple[ParsedStatement, str]]]:
    """Колбэк разбора с заранее известным результатом (разбор асинхронный — LLM)."""

    async def _parse(lines: list[str]) -> tuple[ParsedStatement, str]:
        return statement, name

    return _parse


async def _bootstrap(
    client: AsyncClient, creds: dict[str, str]
) -> tuple[uuid.UUID, uuid.UUID, uuid.UUID]:
    reg = await client.post("/api/auth/register", json=creds)
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


async def test_start_import_creates_processing_record(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    user_id, ws, acc = await _bootstrap(client, ALICE)
    imp = await service.start_import(
        db_session, ws, acc, user_id, "statement.pdf", ["строка выписки"]
    )
    assert imp.status == "processing"
    assert imp.parsed_payload is None
    assert imp.raw_text == "строка выписки"  # текст сохранён для фоновой задачи
    stored = await repository.get_import(db_session, ws, imp.id)
    assert stored is not None


async def test_start_import_strips_nul_byte(client: AsyncClient, db_session: AsyncSession) -> None:
    # pypdf иногда отдаёт \x00 в извлечённом тексте; Postgres text-колонка его не
    # примет (CharacterNotInRepertoireError) — запись не должна падать из-за этого
    user_id, ws, acc = await _bootstrap(client, ALICE)
    imp = await service.start_import(
        db_session, ws, acc, user_id, "s.pdf", ["строка с \x00 символом"]
    )
    assert "\x00" not in (imp.raw_text or "")


async def test_run_parse_stores_ready_payload(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    user_id, ws, acc = await _bootstrap(client, ALICE)
    imp = await service.start_import(db_session, ws, acc, user_id, "s.pdf", ["текст"])

    await service.run_parse(db_session, imp.id, parse=_fixed_parse(SAMPLE, "tbank_statement"))

    await db_session.refresh(imp)
    assert imp.status == "ready"
    assert imp.parser == "tbank_statement"
    assert imp.error is None
    assert imp.raw_text is None  # PII: сырой текст очищен после разбора
    payload = imp.parsed_payload
    assert payload is not None
    # суммы в JSONB — строками, не float
    assert payload["operations"][0]["amount"] == "-1150.00"  # type: ignore[index]
    assert payload["total_income"] == "5000.00"


async def test_run_parse_marks_failed_on_error(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    user_id, ws, acc = await _bootstrap(client, ALICE)
    imp = await service.start_import(db_session, ws, acc, user_id, "s.pdf", ["текст"])

    async def _boom(lines: list[str]) -> tuple[ParsedStatement, str]:
        raise StatementParseError("формат не распознан")

    await service.run_parse(db_session, imp.id, parse=_boom)

    await db_session.refresh(imp)
    assert imp.status == "failed"
    assert imp.error == "формат не распознан"  # наше сообщение — писалось для пользователя
    assert imp.parsed_payload is None


async def test_run_parse_hides_foreign_exception_details(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    # чужие исключения (SDK провайдера, сеть) могут нести ключи и текст выписки —
    # наружу отдаём общее сообщение, не то, что бросил провайдер
    user_id, ws, acc = await _bootstrap(client, ALICE)
    imp = await service.start_import(db_session, ws, acc, user_id, "s.pdf", ["текст"])

    async def _leaky(lines: list[str]) -> tuple[ParsedStatement, str]:
        raise RuntimeError("Incorrect API key provided: sk-proj-AbCd***XyZ9.")

    await service.run_parse(db_session, imp.id, parse=_leaky)

    await db_session.refresh(imp)
    assert imp.status == "failed"
    assert imp.error is not None
    assert "sk-proj" not in imp.error
    assert imp.error == "Не удалось разобрать выписку"


async def test_status_returns_preview_with_duplicate_flags(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    user_id, ws, acc = await _bootstrap(client, ALICE)
    imp = await service.start_import(db_session, ws, acc, user_id, "s.pdf", ["текст"])
    await service.run_parse(db_session, imp.id, parse=_fixed_parse(SAMPLE, "llm"))

    status = await service.get_import_status(db_session, ws, imp.id)
    assert status is not None
    assert status.status == "ready"
    assert status.parser == "llm"
    assert status.preview is not None
    assert status.preview.new_count == 2
    assert status.preview.duplicate_count == 0
    assert all(op.is_duplicate is False for op in status.preview.operations)


async def test_commit_creates_transactions_and_is_idempotent(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    user_id, ws, acc = await _bootstrap(client, ALICE)
    imp = await service.start_import(db_session, ws, acc, user_id, "s.pdf", ["текст"])
    await service.run_parse(db_session, imp.id, parse=_fixed_parse(SAMPLE, "llm"))

    result = await service.commit_from_import(db_session, ws, imp.id, user_id)
    assert result.imported == 2
    assert result.duplicates == 0

    await db_session.refresh(imp)
    assert imp.status == "completed"  # терминальный статус — коммит не предлагается повторно
    stats_after_first = dict(imp.stats)

    # повторный коммит — идемпотентный ответ (тот же результат), без пересоздания
    # операций и БЕЗ порчи stats (аудит не должен соврать, что второй раз ничего не импортировали)
    again = await service.commit_from_import(db_session, ws, imp.id, user_id)
    assert again.imported == 2
    assert again.duplicates == 0

    await db_session.refresh(imp)
    assert imp.stats == stats_after_first


async def test_control_sum_mismatch_becomes_warning(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    user_id, ws, acc = await _bootstrap(client, ALICE)
    imp = await service.start_import(db_session, ws, acc, user_id, "s.pdf", ["текст"])
    skewed = ParsedStatement(
        operations=SAMPLE.operations,
        total_income=Decimal("999.00"),  # не сходится с суммой операций
        total_expense=Decimal("1150.00"),
    )
    await service.run_parse(db_session, imp.id, parse=_fixed_parse(skewed, "llm"))

    status = await service.get_import_status(db_session, ws, imp.id)
    assert status is not None
    # расхождение итогов — мягкая ошибка: разбор готов, но с предупреждением
    assert status.status == "ready"
    assert status.warnings


async def test_import_of_other_workspace_not_visible(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    user_id, ws, acc = await _bootstrap(client, ALICE)
    imp = await service.start_import(db_session, ws, acc, user_id, "s.pdf", ["текст"])
    await service.run_parse(db_session, imp.id, parse=_fixed_parse(SAMPLE, "llm"))

    assert await service.get_import_status(db_session, uuid.uuid4(), imp.id) is None


async def test_foreign_workspace_cannot_read_or_commit_import(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    user_id, ws, acc = await _bootstrap(client, ALICE)
    imp = await service.start_import(db_session, ws, acc, user_id, "s.pdf", ["текст"])
    await service.run_parse(db_session, imp.id, parse=_fixed_parse(SAMPLE, "llm"))

    client.cookies.clear()
    bob_id, ws_bob, _ = await _bootstrap(client, BOB)

    assert await service.get_import_status(db_session, ws_bob, imp.id) is None

    with pytest.raises(service.ImportNotReadyError):
        await service.commit_from_import(db_session, ws_bob, imp.id, bob_id)

    # у Боба не появилось ни одной операции, а импорт Алисы остался нетронутым
    _, bob_total = await ledger_service.list_transactions(db_session, ws_bob)
    assert bob_total == 0
    await db_session.refresh(imp)
    assert imp.status == "ready"


async def test_commit_raises_on_corrupted_payload(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    # parsed_payload — наш собственный, не ввод пользователя; порча (пустой
    # operations) должна падать явно, а не тихо отрапортовать imported=0
    user_id, ws, acc = await _bootstrap(client, ALICE)
    imp = await service.start_import(db_session, ws, acc, user_id, "s.pdf", ["текст"])
    await service.run_parse(db_session, imp.id, parse=_fixed_parse(SAMPLE, "llm"))

    imp.parsed_payload = {
        "operations": [],
        "total_income": None,
        "total_expense": None,
        "warnings": [],
    }
    await db_session.commit()

    with pytest.raises(StatementParseError):
        await service.commit_from_import(db_session, ws, imp.id, user_id)


async def test_payload_with_null_description_becomes_empty_string(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    user_id, ws, acc = await _bootstrap(client, ALICE)
    imp = await service.start_import(db_session, ws, acc, user_id, "s.pdf", ["текст"])
    await service.run_parse(db_session, imp.id, parse=_fixed_parse(SAMPLE, "llm"))

    imp.parsed_payload = {
        "operations": [
            {
                "occurred_at": "2026-07-05",
                "amount": "-10.00",
                "currency": "RUB",
                "description": None,
            }
        ],
        "total_income": None,
        "total_expense": None,
        "warnings": [],
    }
    await db_session.commit()

    status = await service.get_import_status(db_session, ws, imp.id)
    assert status is not None
    assert status.preview is not None
    assert status.preview.operations[0].description == ""


def _payload_with_op(**op_overrides: object) -> dict[str, object]:
    op: dict[str, object] = {
        "occurred_at": "2026-07-05",
        "amount": "-10.00",
        "currency": "RUB",
        "description": "x",
    }
    op.update(op_overrides)
    return {"operations": [op], "total_income": None, "total_expense": None, "warnings": []}


BROKEN_PAYLOADS = [
    pytest.param(_payload_with_op(amount="не число"), id="amount-not-a-number"),
    pytest.param(_payload_with_op(amount=None), id="amount-null"),
    pytest.param(_payload_with_op(amount="NaN"), id="amount-nan"),
    pytest.param({**_payload_with_op(), "total_income": "мусор"}, id="total-income-junk"),
    pytest.param({**_payload_with_op(), "total_expense": "NaN"}, id="total-expense-nan"),
]


@pytest.mark.parametrize("payload", BROKEN_PAYLOADS)
async def test_commit_raises_on_broken_amount_fields(
    client: AsyncClient, db_session: AsyncSession, payload: dict[str, object]
) -> None:
    # decimal.InvalidOperation не наследует ValueError (MRO: InvalidOperation ->
    # DecimalException -> ArithmeticError) — битые суммы не должны улетать голым
    # типом исключения, а NaN/Infinity должны отлавливаться отдельно (Decimal их
    # строит без ошибки, но потом они отравляют сравнение контрольной суммы)
    user_id, ws, acc = await _bootstrap(client, ALICE)
    imp = await service.start_import(db_session, ws, acc, user_id, "s.pdf", ["текст"])
    await service.run_parse(db_session, imp.id, parse=_fixed_parse(SAMPLE, "llm"))

    imp.parsed_payload = payload
    await db_session.commit()

    with pytest.raises(StatementParseError):
        await service.commit_from_import(db_session, ws, imp.id, user_id)


async def test_fail_stuck_imports_clears_raw_text(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    user_id, ws, acc = await _bootstrap(client, ALICE)
    imp = await service.start_import(db_session, ws, acc, user_id, "s.pdf", ["текст"])

    # порог в будущем — запись считается зависшей
    failed = await service.fail_stuck_imports(db_session, datetime.now(UTC) + timedelta(hours=1))

    assert failed == 1
    await db_session.refresh(imp)
    assert imp.status == "failed"
    assert imp.error is not None
    assert imp.raw_text is None  # PII не остаётся висеть


async def test_fail_stuck_imports_skips_fresh_and_finished(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    user_id, ws, acc = await _bootstrap(client, ALICE)
    fresh = await service.start_import(db_session, ws, acc, user_id, "s.pdf", ["текст"])

    # порог в прошлом — свежий импорт трогать нельзя
    failed = await service.fail_stuck_imports(db_session, datetime.now(UTC) - timedelta(hours=1))

    assert failed == 0
    await db_session.refresh(fresh)
    assert fresh.status == "processing"
