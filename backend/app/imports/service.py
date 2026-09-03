import hashlib
import uuid
from collections.abc import Awaitable, Callable
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from typing import cast

import structlog
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.operation_kinds import OPERATION_KINDS, OperationKind
from app.imports import repository
from app.imports.llm_parser import StatementTooLargeError
from app.imports.models import Import
from app.imports.parser import ParsedOperation, ParsedStatement, StatementParseError
from app.imports.schemas import (
    BANK_EXTERNAL_ID_PREFIX,
    ImportListItemOut,
    ImportOperationOut,
    ImportPreviewOut,
    ImportResultOut,
    ImportStatus,
    ImportStatusOut,
    ParsedAccountIn,
    ParsedOperationIn,
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


def _payload_external_ids(
    payload: dict[str, object], account_id: uuid.UUID, operations: list[ParsedOperation]
) -> list[str]:
    """Идентификаторы для дедупа: от банка, если он их дал, иначе наш хеш.
    Список пишем сами (create_parsed_import); если ключ есть, но битый — это
    порча данных, а не законный случай, и должна падать так же, как остальная
    порча parsed_payload в _payload_to_statement, а не тихо откатываться на хеш."""
    stored = payload.get("external_ids")
    if stored is None:
        return _external_ids(account_id, operations)
    if not isinstance(stored, list) or len(stored) != len(operations):
        raise StatementParseError("повреждён сохранённый разбор выписки")
    return [str(x) for x in stored]


def _statement_to_payload(statement: ParsedStatement, warnings: list[str]) -> dict[str, object]:
    # деньги в JSON — строками: Decimal не сериализуется, а float для денег запрещён
    return {
        "operations": [
            {
                "occurred_at": op.occurred_at.isoformat(),
                "amount": str(op.amount),
                "currency": op.currency,
                "description": op.description,
                "kind": op.kind,
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


def _payload_account(payload: dict[str, object]) -> tuple[Decimal, list[str]] | None:
    """Остаток счёта и метки карт из сохранённого разбора; None — источник о счёте
    ничего не сообщал (выписка из PDF про сам счёт не знает).

    Блок пишем сами (create_parsed_import), поэтому битое содержимое — порча
    данных, а не законный случай: падаем тем же типом, что и остальной разбор
    в _payload_to_statement, вместо того чтобы молча оставить прежний остаток."""
    stored = payload.get("account")
    if stored is None:
        return None
    if not isinstance(stored, dict):
        raise StatementParseError("повреждён сохранённый разбор выписки")
    masks = stored.get("card_masks")
    if not isinstance(masks, list):
        raise StatementParseError("повреждён сохранённый разбор выписки")
    try:
        balance = _finite_decimal(stored["balance"])
    except (KeyError, ValueError, InvalidOperation) as exc:
        raise StatementParseError("повреждён сохранённый разбор выписки") from exc
    return balance, [str(mask) for mask in masks]


def _known_kind(raw: str, import_id: uuid.UUID) -> OperationKind:
    """Вид из сохранённого разбора — на входе он проверен схемой, но лежит в JSONB,
    где оказаться может что угодно. Незнакомое слово не роняет весь импорт из-за
    одной строки: операция приезжает как unknown — так она остаётся видимой в
    статистике, тогда как догадка в пользу transfer_self унесла бы её оттуда.
    Молча это не проходит: импорт с мусором виден в логе. Само значение туда не
    пишем — по построению это может оказаться куском данных выписки.

    Сужение живёт здесь, а не в _payload_to_statement, где payload превращается
    в ParsedOperation: там любая порча роняет весь разбор (и это верно для суммы
    или даты, без которых операции нет), а виду нужна именно деградация. Поэтому
    ParsedOperation.kind типизирован как str, а словарём он становится на входе
    в ledger — единственном месте, где вид что-то решает."""
    if raw in OPERATION_KINDS:
        # cast, а не проверка типом: mypy не сужает str по вхождению в tuple[str, ...],
        # хотя именно это вхождение и есть определение OperationKind
        return cast(OperationKind, raw)
    logger.warning("import_unknown_operation_kind", import_id=str(import_id))
    return "unknown"


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
                # у импортов, созданных до появления вида, ключа нет — это не порча
                kind=str(op.get("kind", "unknown")),
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


async def create_parsed_import(
    db: AsyncSession,
    workspace_id: uuid.UUID,
    account_id: uuid.UUID,
    user_id: uuid.UUID,
    parser: str,
    operations: list[ParsedOperationIn],
    account: ParsedAccountIn | None = None,
) -> Import:
    """Принять уже разобранные операции: разбирать нечего, сразу ready."""
    statement = ParsedStatement(
        operations=[
            ParsedOperation(
                occurred_at=op.occurred_at,
                amount=op.amount,
                currency=op.currency,
                description=op.description,
                kind=op.kind,
            )
            for op in operations
        ],
        total_income=None,
        total_expense=None,
    )
    # идентификаторы от банка кладём в payload сразу: дописывать в уже
    # присвоенный JSONB нельзя — SQLAlchemy не отследит правку на месте.
    # Префикс отделяет их пространство от наших sha256-хешей (см. BANK_EXTERNAL_ID_PREFIX)
    payload = _statement_to_payload(statement, [])
    payload["external_ids"] = [BANK_EXTERNAL_ID_PREFIX + op.external_id for op in operations]
    if account is not None:
        # остаток применяется при подтверждении, а оно случится позже отдельным
        # запросом: не положив блок сюда, потеряли бы его по дороге. Деньги
        # строкой — Decimal в JSONB не хранится
        payload["account"] = {"balance": str(account.balance), "card_masks": account.card_masks}

    imp = Import(
        workspace_id=workspace_id,
        account_id=account_id,
        file_name=f"{parser}.json",
        bank_profile=parser,
        parser=parser,
        status="ready",
        stats={},
        created_by=user_id,
        parsed_payload=payload,
    )
    repository.add_import(db, imp)
    await db.commit()
    logger.info("parsed_import_created", import_id=str(imp.id), operations=len(operations))
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
    payload: dict[str, object],
) -> ImportPreviewOut:
    # statement выводим из того же payload, что и id для дедупа — раньше их
    # передавали отдельными параметрами, и вызывающий код мог по ошибке
    # рассинхронизировать пару (statement из одного payload, id из другого)
    statement = _payload_to_statement(payload)
    ext_ids = _payload_external_ids(payload, account_id, statement.operations)
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


def _operations_count(payload: dict[str, object] | None) -> int:
    """Сколько операций в разборе. Для списка это справочное число: показать
    «сколько ждёт» важнее, чем упасть на подпорченном payload — сам разбор
    всё равно перечитывается при открытии импорта."""
    if payload is None:
        return 0
    operations = payload.get("operations")
    if not isinstance(operations, list):
        return 0
    return len(operations)


async def list_pending_imports(
    db: AsyncSession, workspace_id: uuid.UUID
) -> list[ImportListItemOut]:
    imports = await repository.list_pending(db, workspace_id)
    return [
        ImportListItemOut(
            import_id=imp.id,
            account_id=imp.account_id,
            parser=imp.parser,
            status=cast(ImportStatus, imp.status),
            file_name=imp.file_name,
            created_at=imp.created_at,
            operations_count=_operations_count(imp.parsed_payload),
        )
        for imp in imports
    ]


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
        preview = await _build_preview(db, workspace_id, imp.account_id, payload)
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
    ext_ids = _payload_external_ids(imp.parsed_payload, imp.account_id, statement.operations)
    existing = await ledger_service.existing_external_ids(
        db, workspace_id, imp.account_id, set(ext_ids)
    )

    # правила читаем разом до цикла: их единицы, а операций в пачке до десятков
    # тысяч, и запрос на строку сделал бы синхронную ручку N+1
    rules = await ledger_service.load_description_rules(db, workspace_id)

    seen: set[str] = set()
    imported = 0
    for op, eid in zip(statement.operations, ext_ids, strict=True):
        if eid in existing or eid in seen:
            continue
        seen.add(eid)
        # правило «описание → категория» применяем только здесь: при ручном вводе
        # человек выбирает категорию сам, подставлять за него нечего. Флаг
        # category_confirmed при этом не ставим — человек подтвердил правило,
        # а не эту конкретную операцию
        rule_category_id = ledger_service.category_for_description(rules, op.description, op.amount)
        await ledger_service.post_transaction(
            db,
            workspace_id,
            user_id,
            account_id=imp.account_id,
            category_id=rule_category_id,
            amount=op.amount,
            occurred_at=op.occurred_at,
            source="import",
            merchant=op.description[:300] or None,
            external_id=eid,
            import_id=imp.id,
            operation_kind=_known_kind(op.kind, imp.id),
        )
        imported += 1

    reported = _payload_account(imp.parsed_payload)
    if reported is not None:
        balance, card_masks = reported
        # момент — время создания импорта: тогда коллектор и обращался в банк
        await ledger_service.apply_reported_balance(
            db, workspace_id, imp.account_id, balance, card_masks, imp.created_at
        )

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
