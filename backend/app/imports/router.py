import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, UploadFile
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_db
from app.identity.deps import require_workspace_member
from app.identity.models import User
from app.imports import service
from app.imports.parser import StatementParseError
from app.imports.schemas import ImportPreviewOut, ImportResultOut
from app.ledger import service as ledger_service

router = APIRouter(prefix="/api")


@router.post("/imports")
async def import_statement(
    workspace_id: uuid.UUID,
    account_id: uuid.UUID,
    user: Annotated[User, Depends(require_workspace_member)],
    db: Annotated[AsyncSession, Depends(get_db)],
    file: UploadFile,
    commit: bool = False,
) -> ImportPreviewOut | ImportResultOut:
    if not await ledger_service.account_exists(db, workspace_id, account_id):
        raise HTTPException(status_code=404, detail="Счёт не найден")
    pdf_bytes = await file.read()
    try:
        if commit:
            return await service.commit_import(
                db, workspace_id, account_id, user.id, file.filename or "statement.pdf", pdf_bytes
            )
        return await service.preview(db, workspace_id, account_id, pdf_bytes)
    except StatementParseError:
        raise HTTPException(status_code=422, detail="Не удалось разобрать выписку") from None
