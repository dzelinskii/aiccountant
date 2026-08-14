import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, UploadFile
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_db
from app.identity.deps import require_workspace_member
from app.identity.models import User
from app.imports import service
from app.imports.parser import extract_lines
from app.imports.schemas import ImportResultOut, ImportStartedOut, ImportStatusOut
from app.imports.tasks import enqueue_parse
from app.ledger import service as ledger_service

router = APIRouter(prefix="/api")

# выписку целиком читаем в память — ограничиваем размер, чтобы аплоад не съел RAM
MAX_UPLOAD_BYTES = 10 * 1024 * 1024
ALLOWED_CONTENT_TYPES = {"application/pdf", "application/octet-stream"}


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
        lines = extract_lines(pdf_bytes)
    except Exception:
        # битый/не-PDF файл: разбирать нечего, в фон не ставим
        raise HTTPException(status_code=422, detail="Не удалось прочитать PDF") from None
    imp = await service.start_import(
        db, workspace_id, account_id, user.id, file.filename or "statement.pdf", lines
    )
    enqueue_parse(imp.id)
    return ImportStartedOut(import_id=imp.id, status=imp.status)


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
