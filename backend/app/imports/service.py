import hashlib
import uuid
from decimal import Decimal

import structlog
from sqlalchemy.ext.asyncio import AsyncSession

from app.imports import repository
from app.imports.models import Import
from app.imports.parser import ParsedOperation, ParsedStatement, extract_lines, parse_statement
from app.imports.schemas import ImportOperationOut, ImportPreviewOut, ImportResultOut
from app.ledger import service as ledger_service

BANK_PROFILE = "tbank_statement"

logger = structlog.get_logger()


def _external_id(account_id: uuid.UUID, op: ParsedOperation) -> str:
    raw = f"{account_id}|{op.occurred_at.isoformat()}|{op.amount}|{op.description}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


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
    ext_ids = [_external_id(account_id, op) for op in statement.operations]
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
    ext_ids = [_external_id(account_id, op) for op in statement.operations]
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
    return ImportResultOut(import_id=imp.id, imported=imported, duplicates=duplicates)
