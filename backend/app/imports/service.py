import hashlib
import uuid
from collections.abc import Awaitable, Callable
from datetime import date
from decimal import Decimal
from typing import cast

import structlog
from sqlalchemy.ext.asyncio import AsyncSession

from app.imports import repository
from app.imports.llm_parser import StatementTooLargeError
from app.imports.models import Import
from app.imports.parser import (
    ParsedOperation,
    ParsedStatement,
    StatementParseError,
    extract_lines,
    parse_statement,
)
from app.imports.schemas import (
    ImportOperationOut,
    ImportPreviewOut,
    ImportResultOut,
    ImportStatus,
    ImportStatusOut,
)
from app.ledger import service as ledger_service

BANK_PROFILE = "tbank_statement"

logger = structlog.get_logger()


class ImportNotReadyError(Exception):
    """Импорт не в статусе, из которого можно подтвердить (не найден/не разобран).
    Это состояние, а не ошибка разбора — отдельный тип, чтобы роутер маппил иначе."""


def _external_ids(account_id: uuid.UUID, operations: list[ParsedOperation]) -> list[str]:
    # id операции в PDF нет, а одинаковые операции одного дня (одинаковые сумма и
    # описание, порой совпадает и время до минуты) в выписке реально бывают —
    # поэтому в ключ добавляем порядковый номер среди идентичных строк файла.
    # Это сохраняет распознавание дублей при повторном импорте того же файла
    # (порядок стабилен) и не теряет реальные одинаковые операции.
    seen_count: dict[tuple[str, str, str], int] = {}
    ids: list[str] = []
    for op in operations:
        base = (op.occurred_at.isoformat(), str(op.amount), op.description)
        occurrence = seen_count.get(base, 0)
        seen_count[base] = occurrence + 1
        raw = f"{account_id}|{base[0]}|{base[1]}|{base[2]}|{occurrence}"
        ids.append(hashlib.sha256(raw.encode("utf-8")).hexdigest())
    return ids


def _check_control_sum(statement: ParsedStatement) -> None:
    # сверка с итогами банка как контроль разбора; расхождение не отказ, а сигнал
    income = sum((op.amount for op in statement.operations if op.amount > 0), Decimal(0))
    expense = sum((-op.amount for op in statement.operations if op.amount < 0), Decimal(0))
    if statement.total_income is not None and income != statement.total_income:
        logger.warning("import_control_sum_mismatch", kind="income")
    if statement.total_expense is not None and expense != statement.total_expense:
        logger.warning("import_control_sum_mismatch", kind="expense")


def _parse(pdf_bytes: bytes) -> ParsedStatement:
    statement = parse_statement(extract_lines(pdf_bytes))  # может бросить StatementParseError
    _check_control_sum(statement)
    return statement


async def preview(
    db: AsyncSession, workspace_id: uuid.UUID, account_id: uuid.UUID, pdf_bytes: bytes
) -> ImportPreviewOut:
    statement = _parse(pdf_bytes)
    ext_ids = _external_ids(account_id, statement.operations)
    existing = await ledger_service.existing_external_ids(
        db, workspace_id, account_id, set(ext_ids)
    )
    seen: set[str] = set()
    operations: list[ImportOperationOut] = []
    new_count = 0
    for op, eid in zip(statement.operations, ext_ids, strict=True):
        is_duplicate = eid in existing or eid in seen
        seen.add(eid)
        if not is_duplicate:
            new_count += 1
        operations.append(
            ImportOperationOut(
                occurred_at=op.occurred_at,
                amount=op.amount,
                currency=op.currency,
                description=op.description,
                is_duplicate=is_duplicate,
            )
        )
    return ImportPreviewOut(
        operations=operations,
        new_count=new_count,
        duplicate_count=len(operations) - new_count,
        total_income=statement.total_income,
        total_expense=statement.total_expense,
    )


async def commit_import(
    db: AsyncSession,
    workspace_id: uuid.UUID,
    account_id: uuid.UUID,
    user_id: uuid.UUID,
    file_name: str,
    pdf_bytes: bytes,
) -> ImportResultOut:
    statement = _parse(pdf_bytes)
    ext_ids = _external_ids(account_id, statement.operations)
    existing = await ledger_service.existing_external_ids(
        db, workspace_id, account_id, set(ext_ids)
    )

    imp = Import(
        workspace_id=workspace_id,
        account_id=account_id,
        file_name=file_name,
        bank_profile=BANK_PROFILE,
        status="completed",
        stats={},
        created_by=user_id,
    )
    repository.add_import(db, imp)
    await db.flush()  # получить imp.id

    seen: set[str] = set()
    imported = 0
    for op, eid in zip(statement.operations, ext_ids, strict=True):
        if eid in existing or eid in seen:
            continue
        seen.add(eid)
        await ledger_service.post_transaction(
            db,
            workspace_id,
            user_id,
            account_id=account_id,
            category_id=None,
            amount=op.amount,
            occurred_at=op.occurred_at,
            source="import",
            merchant=op.description[:300] or None,
            external_id=eid,
            import_id=imp.id,
        )
        imported += 1

    duplicates = len(statement.operations) - imported
    imp.stats = {
        "parsed": len(statement.operations),
        "imported": imported,
        "duplicates": duplicates,
    }
    await db.commit()  # запись импорта и операции — один commit
    if imported:
        ledger_service.enqueue_categorization(workspace_id)
    return ImportResultOut(import_id=imp.id, imported=imported, duplicates=duplicates)


def _statement_to_payload(statement: ParsedStatement, warnings: list[str]) -> dict[str, object]:
    # деньги в JSON — строками: Decimal не сериализуется, а float для денег запрещён
    return {
        "operations": [
            {
                "occurred_at": op.occurred_at.isoformat(),
                "amount": str(op.amount),
                "currency": op.currency,
                "description": op.description,
            }
            for op in statement.operations
        ],
        "total_income": None if statement.total_income is None else str(statement.total_income),
        "total_expense": None if statement.total_expense is None else str(statement.total_expense),
        "warnings": warnings,
    }


def _payload_to_statement(payload: dict[str, object]) -> ParsedStatement:
    # это наш собственный payload (не ввод пользователя): пустой/нетипизированный
    # "operations" или битый элемент внутри — порча данных, а не законный случай
    # (и парсер, и LLM-разбор гарантируют хотя бы одну операцию), поэтому падаем
    # явно одним типом ошибки, а не молча теряем операции
    raw_ops = payload.get("operations")
    if not isinstance(raw_ops, list) or not raw_ops:
        raise StatementParseError("повреждён сохранённый разбор выписки")
    try:
        operations = [
            ParsedOperation(
                occurred_at=date.fromisoformat(str(op["occurred_at"])),
                amount=Decimal(str(op["amount"])),
                currency=str(op["currency"]),
                description="" if op.get("description") is None else str(op["description"]),
            )
            for op in raw_ops
        ]
    except (KeyError, ValueError, TypeError) as exc:
        raise StatementParseError("повреждён сохранённый разбор выписки") from exc
    income = payload.get("total_income")
    expense = payload.get("total_expense")
    return ParsedStatement(
        operations=operations,
        total_income=None if income is None else Decimal(str(income)),
        total_expense=None if expense is None else Decimal(str(expense)),
    )


def _control_sum_warnings(statement: ParsedStatement) -> list[str]:
    """Расхождение итогов — мягкая ошибка: показываем предупреждение, но даём импортировать."""
    warnings: list[str] = []
    income = sum((op.amount for op in statement.operations if op.amount > 0), Decimal(0))
    expense = sum((-op.amount for op in statement.operations if op.amount < 0), Decimal(0))
    if statement.total_income is not None and income != statement.total_income:
        warnings.append("Сумма поступлений не сошлась с итогом выписки")
    if statement.total_expense is not None and expense != statement.total_expense:
        warnings.append("Сумма расходов не сошлась с итогом выписки")
    return warnings


async def start_import(
    db: AsyncSession,
    workspace_id: uuid.UUID,
    account_id: uuid.UUID,
    user_id: uuid.UUID,
    file_name: str,
    lines: list[str],
) -> Import:
    """Создать запись импорта со статусом processing и сохранённым текстом выписки."""
    # NUL: Postgres text-колонка его не примет (CharacterNotInRepertoireError), а pypdf
    # иногда отдаёт его в тексте — вырезаем до записи, а не молимся, что его не будет
    raw_text = "\n".join(lines).replace("\x00", "")
    imp = Import(
        workspace_id=workspace_id,
        account_id=account_id,
        file_name=file_name,
        bank_profile="",  # заполнится именем сработавшего парсера после разбора
        status="processing",
        stats={},
        created_by=user_id,
        raw_text=raw_text,
    )
    repository.add_import(db, imp)
    await db.commit()
    return imp


async def run_parse(
    db: AsyncSession,
    import_id: uuid.UUID,
    *,
    parse: Callable[[list[str]], Awaitable[tuple[ParsedStatement, str]]],
) -> None:
    """Разобрать сохранённый текст и записать результат. Разбор асинхронный (LLM-фолбэк
    ходит по сети). Ошибка разбора — статус failed с понятным текстом, не молчаливый пропуск."""
    imp = await repository.get_import_any_workspace(db, import_id)
    if imp is None:
        return
    lines = (imp.raw_text or "").splitlines()
    try:
        statement, parser_name = await parse(lines)
    except (StatementParseError, StatementTooLargeError) as exc:
        imp.status = "failed"
        imp.error = str(exc)[:500]  # наши сообщения писались для пользователя
        imp.raw_text = None  # PII: сырой текст больше не нужен
        await db.commit()
        logger.warning("import_parse_failed", import_id=str(imp.id))
        return
    except Exception as exc:
        # чужие исключения (SDK провайдера, сеть) могут нести ключи и текст выписки —
        # наружу отдаём общее сообщение, в лог только тип
        imp.status = "failed"
        imp.error = "Не удалось разобрать выписку"
        imp.raw_text = None
        await db.commit()
        logger.warning("import_parse_failed", import_id=str(imp.id), error_type=type(exc).__name__)
        return
    warnings = _control_sum_warnings(statement)
    imp.parser = parser_name
    imp.bank_profile = parser_name
    imp.parsed_payload = _statement_to_payload(statement, warnings)
    imp.status = "ready"
    imp.error = None
    imp.raw_text = None  # PII: дальше работаем с разобранными операциями
    await db.commit()
    logger.info("import_parsed", import_id=str(imp.id), parser=parser_name)


async def _build_preview(
    db: AsyncSession,
    workspace_id: uuid.UUID,
    account_id: uuid.UUID,
    statement: ParsedStatement,
) -> ImportPreviewOut:
    ext_ids = _external_ids(account_id, statement.operations)
    existing = await ledger_service.existing_external_ids(
        db, workspace_id, account_id, set(ext_ids)
    )
    seen: set[str] = set()
    operations: list[ImportOperationOut] = []
    new_count = 0
    for op, eid in zip(statement.operations, ext_ids, strict=True):
        is_duplicate = eid in existing or eid in seen
        seen.add(eid)
        if not is_duplicate:
            new_count += 1
        operations.append(
            ImportOperationOut(
                occurred_at=op.occurred_at,
                amount=op.amount,
                currency=op.currency,
                description=op.description,
                is_duplicate=is_duplicate,
            )
        )
    return ImportPreviewOut(
        operations=operations,
        new_count=new_count,
        duplicate_count=len(operations) - new_count,
        total_income=statement.total_income,
        total_expense=statement.total_expense,
    )


async def get_import_status(
    db: AsyncSession, workspace_id: uuid.UUID, import_id: uuid.UUID
) -> ImportStatusOut | None:
    imp = await repository.get_import(db, workspace_id, import_id)
    if imp is None:
        return None
    preview = None
    warnings: list[str] = []
    if imp.status == "ready" and imp.parsed_payload is not None:
        payload = imp.parsed_payload
        raw_warnings = payload.get("warnings")
        warnings_list = raw_warnings if isinstance(raw_warnings, list) else []
        warnings = [str(w) for w in warnings_list]
        statement = _payload_to_statement(payload)
        preview = await _build_preview(db, workspace_id, imp.account_id, statement)
    return ImportStatusOut(
        import_id=imp.id,
        # значение — из закрытого набора, который сами же и пишем в run_parse/commit_from_import
        status=cast(ImportStatus, imp.status),
        parser=imp.parser,
        error=imp.error,
        warnings=warnings,
        preview=preview,
    )


async def commit_from_import(
    db: AsyncSession, workspace_id: uuid.UUID, import_id: uuid.UUID, user_id: uuid.UUID
) -> ImportResultOut:
    """Создать операции из уже разобранного импорта — повторно не парсим."""
    imp = await repository.get_import(db, workspace_id, import_id)
    if imp is not None and imp.status == "completed":
        # повторный коммит — идемпотентный ответ без пересоздания операций и без
        # переписывания stats (иначе аудит соврёт, что второй раз ничего не импортировали)
        stats = imp.stats
        return ImportResultOut(
            import_id=imp.id,
            imported=stats.get("imported", 0),
            duplicates=stats.get("duplicates", 0),
        )
    if imp is None or imp.status != "ready" or imp.parsed_payload is None:
        raise ImportNotReadyError("импорт не готов к подтверждению")
    statement = _payload_to_statement(imp.parsed_payload)
    ext_ids = _external_ids(imp.account_id, statement.operations)
    existing = await ledger_service.existing_external_ids(
        db, workspace_id, imp.account_id, set(ext_ids)
    )

    seen: set[str] = set()
    imported = 0
    for op, eid in zip(statement.operations, ext_ids, strict=True):
        if eid in existing or eid in seen:
            continue
        seen.add(eid)
        await ledger_service.post_transaction(
            db,
            workspace_id,
            user_id,
            account_id=imp.account_id,
            category_id=None,
            amount=op.amount,
            occurred_at=op.occurred_at,
            source="import",
            merchant=op.description[:300] or None,
            external_id=eid,
            import_id=imp.id,
        )
        imported += 1

    duplicates = len(statement.operations) - imported
    imp.stats = {
        "parsed": len(statement.operations),
        "imported": imported,
        "duplicates": duplicates,
    }
    imp.status = "completed"  # терминальный статус: отличает закоммиченный импорт от ready
    await db.commit()
    if imported:
        ledger_service.enqueue_categorization(workspace_id)
    return ImportResultOut(import_id=imp.id, imported=imported, duplicates=duplicates)
