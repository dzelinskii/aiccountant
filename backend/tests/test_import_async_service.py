import uuid
from collections.abc import Awaitable, Callable
from datetime import date
from decimal import Decimal

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.imports import repository, service
from app.imports.parser import ParsedOperation, ParsedStatement, StatementParseError

ALICE = {"email": "alice@example.com", "password": "password123"}

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


async def test_start_import_creates_processing_record(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    user_id, ws, acc = await _bootstrap(client)
    imp = await service.start_import(
        db_session, ws, acc, user_id, "statement.pdf", ["строка выписки"]
    )
    assert imp.status == "processing"
    assert imp.parsed_payload is None
    assert imp.raw_text == "строка выписки"  # текст сохранён для фоновой задачи
    stored = await repository.get_import(db_session, ws, imp.id)
    assert stored is not None


async def test_run_parse_stores_ready_payload(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    user_id, ws, acc = await _bootstrap(client)
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
    user_id, ws, acc = await _bootstrap(client)
    imp = await service.start_import(db_session, ws, acc, user_id, "s.pdf", ["текст"])

    async def _boom(lines: list[str]) -> tuple[ParsedStatement, str]:
        raise StatementParseError("формат не распознан")

    await service.run_parse(db_session, imp.id, parse=_boom)

    await db_session.refresh(imp)
    assert imp.status == "failed"
    assert imp.error is not None
    assert imp.parsed_payload is None


async def test_status_returns_preview_with_duplicate_flags(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    user_id, ws, acc = await _bootstrap(client)
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
    user_id, ws, acc = await _bootstrap(client)
    imp = await service.start_import(db_session, ws, acc, user_id, "s.pdf", ["текст"])
    await service.run_parse(db_session, imp.id, parse=_fixed_parse(SAMPLE, "llm"))

    result = await service.commit_from_import(db_session, ws, imp.id, user_id)
    assert result.imported == 2
    assert result.duplicates == 0

    # повторный коммит того же импорта не задваивает операции
    again = await service.commit_from_import(db_session, ws, imp.id, user_id)
    assert again.imported == 0
    assert again.duplicates == 2


async def test_control_sum_mismatch_becomes_warning(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    user_id, ws, acc = await _bootstrap(client)
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
    user_id, ws, acc = await _bootstrap(client)
    imp = await service.start_import(db_session, ws, acc, user_id, "s.pdf", ["текст"])
    await service.run_parse(db_session, imp.id, parse=_fixed_parse(SAMPLE, "llm"))

    assert await service.get_import_status(db_session, uuid.uuid4(), imp.id) is None
