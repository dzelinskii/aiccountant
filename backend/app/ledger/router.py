import uuid
from datetime import date
from decimal import Decimal
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query
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
    DashboardOut,
    TransactionCreate,
    TransactionList,
    TransactionOut,
    TransactionUpdate,
    TransferCreate,
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
    try:
        category = await service.create_category(db, workspace_id, payload)
    except service.NotFoundError:
        raise HTTPException(status_code=404, detail="Родительская категория не найдена") from None
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


def _transaction_out(t: object) -> TransactionOut:
    return TransactionOut.model_validate(t, from_attributes=True)


@router.get("/transactions")
async def list_transactions(
    workspace_id: uuid.UUID,
    _user: Annotated[User, Depends(require_workspace_member)],
    db: Annotated[AsyncSession, Depends(get_db)],
    account_id: uuid.UUID | None = None,
    category_id: uuid.UUID | None = None,
    date_from: Annotated[date | None, Query(alias="from")] = None,
    date_to: Annotated[date | None, Query(alias="to")] = None,
    limit: int = 50,
    offset: int = 0,
) -> TransactionList:
    items, total = await service.list_transactions(
        db,
        workspace_id,
        account_id=account_id,
        category_id=category_id,
        date_from=date_from,
        date_to=date_to,
        limit=limit,
        offset=offset,
    )
    return TransactionList(items=[_transaction_out(t) for t in items], total=total)


@router.post("/transactions", status_code=201)
async def create_transaction(
    payload: TransactionCreate,
    workspace_id: uuid.UUID,
    user: Annotated[User, Depends(require_workspace_member)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> TransactionOut:
    try:
        transaction = await service.create_transaction(db, workspace_id, user.id, payload)
    except service.NotFoundError:
        raise HTTPException(status_code=404, detail="Счёт или категория не найдены") from None
    except service.SignMismatchError:
        raise HTTPException(
            status_code=422, detail="Знак суммы не соответствует типу категории"
        ) from None
    if transaction.category_id is None:
        service.enqueue_categorization(workspace_id)
    return _transaction_out(transaction)


@router.post("/transactions/transfer", status_code=201)
async def create_transfer(
    payload: TransferCreate,
    workspace_id: uuid.UUID,
    user: Annotated[User, Depends(require_workspace_member)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> TransactionList:
    try:
        rows = await service.create_transfer(db, workspace_id, user.id, payload)
    except service.InvalidTransferError:
        raise HTTPException(status_code=422, detail="Некорректный перевод") from None
    return TransactionList(items=[_transaction_out(t) for t in rows], total=len(rows))


@router.patch("/transactions/{transaction_id}")
async def update_transaction(
    transaction_id: uuid.UUID,
    payload: TransactionUpdate,
    workspace_id: uuid.UUID,
    _user: Annotated[User, Depends(require_workspace_member)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> TransactionOut:
    try:
        transaction = await service.update_transaction(db, workspace_id, transaction_id, payload)
    except service.NotFoundError:
        raise HTTPException(status_code=404, detail="Операция не найдена") from None
    except service.TransferEditError:
        raise HTTPException(status_code=409, detail="Строку перевода нельзя править") from None
    except service.SignMismatchError:
        raise HTTPException(
            status_code=422, detail="Знак суммы не соответствует типу категории"
        ) from None
    return _transaction_out(transaction)


@router.delete("/transactions/{transaction_id}", status_code=204)
async def delete_transaction(
    transaction_id: uuid.UUID,
    workspace_id: uuid.UUID,
    _user: Annotated[User, Depends(require_workspace_member)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> None:
    try:
        await service.delete_transaction(db, workspace_id, transaction_id)
    except service.NotFoundError:
        raise HTTPException(status_code=404, detail="Операция не найдена") from None


@router.get("/dashboard")
async def dashboard(
    workspace_id: uuid.UUID,
    _user: Annotated[User, Depends(require_workspace_member)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> DashboardOut:
    return await service.build_dashboard(db, workspace_id)
