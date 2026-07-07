import uuid
from decimal import Decimal
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_db
from app.identity.deps import require_workspace_member
from app.identity.models import User
from app.ledger import service
from app.ledger.models import Account
from app.ledger.schemas import (
    AccountCreate,
    AccountOut,
    AccountUpdate,
    CategoryCreate,
    CategoryOut,
    CategoryUpdate,
)

router = APIRouter(prefix="/api")


def _account_out(account: Account, balance: Decimal) -> AccountOut:
    # balance нет в модели Account — считается по транзакциям, подставляем отдельно
    return AccountOut(
        id=account.id,
        name=account.name,
        type=account.type,
        currency=account.currency,
        is_archived=account.is_archived,
        balance=balance,
    )


@router.get("/accounts")
async def list_accounts(
    workspace_id: uuid.UUID,
    _user: Annotated[User, Depends(require_workspace_member)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> list[AccountOut]:
    rows = await service.list_accounts(db, workspace_id)
    return [_account_out(acc, bal) for acc, bal in rows]


@router.post("/accounts", status_code=201)
async def create_account(
    payload: AccountCreate,
    workspace_id: uuid.UUID,
    _user: Annotated[User, Depends(require_workspace_member)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> AccountOut:
    account, balance = await service.create_account(db, workspace_id, payload)
    return _account_out(account, balance)


@router.patch("/accounts/{account_id}")
async def update_account(
    account_id: uuid.UUID,
    payload: AccountUpdate,
    workspace_id: uuid.UUID,
    _user: Annotated[User, Depends(require_workspace_member)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> AccountOut:
    try:
        account, balance = await service.update_account(db, workspace_id, account_id, payload)
    except service.NotFoundError:
        raise HTTPException(status_code=404, detail="Счёт не найден") from None
    return _account_out(account, balance)


@router.get("/categories")
async def list_categories(
    workspace_id: uuid.UUID,
    _user: Annotated[User, Depends(require_workspace_member)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> list[CategoryOut]:
    cats = await service.list_categories(db, workspace_id)
    return [CategoryOut.model_validate(c, from_attributes=True) for c in cats]


@router.post("/categories", status_code=201)
async def create_category(
    payload: CategoryCreate,
    workspace_id: uuid.UUID,
    _user: Annotated[User, Depends(require_workspace_member)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> CategoryOut:
    category = await service.create_category(db, workspace_id, payload)
    return CategoryOut.model_validate(category, from_attributes=True)


@router.patch("/categories/{category_id}")
async def update_category(
    category_id: uuid.UUID,
    payload: CategoryUpdate,
    workspace_id: uuid.UUID,
    _user: Annotated[User, Depends(require_workspace_member)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> CategoryOut:
    try:
        category = await service.update_category(db, workspace_id, category_id, payload)
    except service.NotFoundError:
        raise HTTPException(status_code=404, detail="Категория не найдена") from None
    return CategoryOut.model_validate(category, from_attributes=True)
