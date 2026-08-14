import asyncio
import uuid
from typing import Annotated, cast

import structlog
from fastapi import APIRouter, Depends, HTTPException, UploadFile
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_db
from app.identity.deps import require_workspace_member
from app.identity.models import User
from app.imports import service
from app.imports.parser import extract_lines
from app.imports.schemas import ImportResultOut, ImportStartedOut, ImportStatus, ImportStatusOut
from app.imports.tasks import enqueue_parse
from app.ledger import service as ledger_service

router = APIRouter(prefix="/api")

# выписку целиком читаем в память — ограничиваем размер, чтобы аплоад не съел RAM
MAX_UPLOAD_BYTES = 10 * 1024 * 1024
ALLOWED_CONTENT_TYPES = {"application/pdf", "application/octet-stream"}

logger = structlog.get_logger()


@router.post("/imports", status_code=202)
async def start_import(
    workspace_id: uuid.UUID,
    account_id: uuid.UUID,
    user: Annotated[User, Depends(require_workspace_member)],
    db: Annotated[AsyncSession, Depends(get_db)],
    file: UploadFile,
) -> ImportStartedOut:
    if file.content_type not in ALLOWED_CONTENT_TYPES:
        raise HTTPException(status_code=415, detail="Ожидается PDF-файл")
    if file.size is not None and file.size > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="Файл слишком большой (максимум 10 МБ)")
    if not await ledger_service.account_exists(db, workspace_id, account_id):
        raise HTTPException(status_code=404, detail="Счёт не найден")
    pdf_bytes = await file.read()
    try:
        # pypdf синхронный и CPU-bound — на многостраничной выписке extract_text()
        # может идти секунды и подвесить весь event loop воркера, поэтому уносим в поток
        lines = await asyncio.to_thread(extract_lines, pdf_bytes)
    except Exception as exc:
        # битый/не-PDF файл: разбирать нечего, в фон не ставим. Тип пишем в лог —
        # иначе баг в нашем коде неотличим от кривого файла; сообщение не логируем,
        # оно может нести текст выписки
        logger.warning("import_extract_failed", error_type=type(exc).__name__)
        raise HTTPException(status_code=422, detail="Не удалось прочитать PDF") from None
    imp = await service.start_import(
        db, workspace_id, account_id, user.id, file.filename or "statement.pdf", lines
    )
    try:
        enqueue_parse(imp.id)
    except Exception as exc:
        # брокер недоступен: не оставляем строку с текстом выписки (PII) висеть в
        # processing до reaper'а (у него порог 15 минут) — гасим сразу
        await service.mark_import_failed(
            db, imp.id, "Не удалось поставить разбор в очередь — попробуйте позже"
        )
        logger.warning(
            "import_enqueue_failed", import_id=str(imp.id), error_type=type(exc).__name__
        )
        raise HTTPException(status_code=503, detail="Сервис разбора недоступен") from None
    return ImportStartedOut(import_id=imp.id, status=cast(ImportStatus, imp.status))


@router.get("/imports/{import_id}")
async def import_status(
    import_id: uuid.UUID,
    workspace_id: uuid.UUID,
    _user: Annotated[User, Depends(require_workspace_member)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> ImportStatusOut:
    status = await service.get_import_status(db, workspace_id, import_id)
    if status is None:
        raise HTTPException(status_code=404, detail="Импорт не найден")
    return status


@router.post("/imports/{import_id}/commit")
async def commit_import(
    import_id: uuid.UUID,
    workspace_id: uuid.UUID,
    user: Annotated[User, Depends(require_workspace_member)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> ImportResultOut:
    try:
        return await service.commit_from_import(db, workspace_id, import_id, user.id)
    except service.ImportNotFoundError:
        raise HTTPException(status_code=404, detail="Импорт не найден") from None
    except service.ImportNotReadyError:
        raise HTTPException(status_code=409, detail="Импорт не готов к подтверждению") from None
