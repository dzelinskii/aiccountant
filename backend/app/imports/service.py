import hashlib
import uuid
from collections.abc import Awaitable, Callable
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from typing import cast

import structlog
from sqlalchemy.ext.asyncio import AsyncSession

from app.imports import repository
from app.imports.llm_parser import StatementTooLargeError
from app.imports.models import Import
from app.imports.parser import ParsedOperation, ParsedStatement, StatementParseError
from app.imports.schemas import (
    ImportOperationOut,
    ImportPreviewOut,
    ImportResultOut,
    ImportStatus,
    ImportStatusOut,
)
from app.ledger import service as ledger_service

logger = structlog.get_logger()


class ImportNotReadyError(Exception):
    """Импорт существует (в своём workspace), но статус не позволяет подтвердить —
    это 409, а не 404: сам факт существования уже раскрыт запросом GET /imports/{id}."""


class ImportNotFoundError(Exception):
    """Импорт не найден или принадлежит чужому workspace — снаружи неотличимо."""


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


def _finite_decimal(raw: object) -> Decimal:
    value = Decimal(str(raw))
    if not value.is_finite():
        # Decimal("NaN")/Decimal("Infinity") строятся без ошибки, но дальше
        # молча отравляют сравнения контрольной суммы — это тоже порча данных
        raise ValueError(f"не конечное число: {value}")
    return value


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
                amount=_finite_decimal(op["amount"]),
                currency=str(op["currency"]),
                description="" if op.get("description") is None else str(op["description"]),
            )
            for op in raw_ops
        ]
        income = payload.get("total_income")
        expense = payload.get("total_expense")
        total_income = None if income is None else _finite_decimal(income)
        total_expense = None if expense is None else _finite_decimal(expense)
    except (KeyError, ValueError, TypeError, InvalidOperation) as exc:
        raise StatementParseError("повреждён сохранённый разбор выписки") from exc
    return ParsedStatement(
        operations=operations,
        total_income=total_income,
        total_expense=total_expense,
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
    if imp is None or imp.status != "processing":
        # отставшее сообщение после того, как reaper уже пометил запись failed
        # (или разбор как-то запустился дважды) — не тратим LLM-вызов впустую
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


async def mark_import_failed(
    db: AsyncSession, workspace_id: uuid.UUID, import_id: uuid.UUID, message: str
) -> None:
    """Пометить импорт failed и стереть сырой текст (PII) — для случая, когда разбор
    не удалось даже поставить в очередь (брокер недоступен), а не когда сам разбор
    провалился. Без записи не оставляем PII висеть в processing до reaper'а.
    Фильтруем по workspace_id (в отличие от фоновой get_import_any_workspace) —
    вызывается из обработчика запроса, а не из фоновой задачи по чужому id."""
    imp = await repository.get_import(db, workspace_id, import_id)
    if imp is None:
        return
    imp.status = "failed"
    imp.error = message[:500]
    imp.raw_text = None
    await db.commit()


async def fail_stuck_imports(db: AsyncSession, older_than: datetime) -> int:
    """Пометить зависшие разборы как failed и стереть сырой текст (PII). Один
    UPDATE в repository.fail_stuck — гонка с воркером, коммитящим ready в этот
    же момент, исключена перепроверкой условия под блокировкой строки."""
    message = "Разбор не завершился — попробуйте загрузить файл ещё раз"
    stuck_ids = await repository.fail_stuck(db, older_than, message)
    for import_id in stuck_ids:
        logger.warning("import_parse_stuck", import_id=str(import_id))
    await db.commit()
    return len(stuck_ids)


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
    if imp is None:
        raise ImportNotFoundError("импорт не найден")
    if imp.status != "ready" or imp.parsed_payload is None:
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
