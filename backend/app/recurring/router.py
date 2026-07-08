import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_db
from app.identity.deps import require_workspace_member
from app.identity.models import User
from app.recurring import service
from app.recurring.schemas import RuleCreate, RuleOut, RuleUpdate

router = APIRouter(prefix="/api")

_SIGN_DETAIL = "Знак суммы не соответствует типу категории"


@router.get("/recurring")
async def list_rules(
    workspace_id: uuid.UUID,
    _user: Annotated[User, Depends(require_workspace_member)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> list[RuleOut]:
    rules = await service.list_rules(db, workspace_id)
    return [RuleOut.model_validate(r, from_attributes=True) for r in rules]


@router.post("/recurring", status_code=201)
async def create_rule(
    payload: RuleCreate,
    workspace_id: uuid.UUID,
    user: Annotated[User, Depends(require_workspace_member)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> RuleOut:
    try:
        rule = await service.create_rule(db, workspace_id, user.id, payload)
    except service.RuleValidationError:
        raise HTTPException(status_code=422, detail="month-правило требует anchor_day") from None
    except service.NotFoundError:
        raise HTTPException(status_code=404, detail="Счёт или категория не найдены") from None
    except service.SignMismatchError:
        raise HTTPException(status_code=422, detail=_SIGN_DETAIL) from None
    return RuleOut.model_validate(rule, from_attributes=True)


@router.patch("/recurring/{rule_id}")
async def update_rule(
    rule_id: uuid.UUID,
    payload: RuleUpdate,
    workspace_id: uuid.UUID,
    _user: Annotated[User, Depends(require_workspace_member)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> RuleOut:
    try:
        rule = await service.update_rule(db, workspace_id, rule_id, payload)
    except service.NotFoundError:
        raise HTTPException(status_code=404, detail="Правило не найдено") from None
    except service.SignMismatchError:
        raise HTTPException(status_code=422, detail=_SIGN_DETAIL) from None
    return RuleOut.model_validate(rule, from_attributes=True)


@router.delete("/recurring/{rule_id}", status_code=204)
async def delete_rule(
    rule_id: uuid.UUID,
    workspace_id: uuid.UUID,
    _user: Annotated[User, Depends(require_workspace_member)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> None:
    try:
        await service.delete_rule(db, workspace_id, rule_id)
    except service.NotFoundError:
        raise HTTPException(status_code=404, detail="Правило не найдено") from None
