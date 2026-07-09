import uuid
from datetime import date

from pydantic import BaseModel

from app.core.money import MoneyStr


class ImportOperationOut(BaseModel):
    occurred_at: date
    amount: MoneyStr
    currency: str
    description: str
    is_duplicate: bool


class ImportPreviewOut(BaseModel):
    operations: list[ImportOperationOut]
    new_count: int
    duplicate_count: int
    total_income: MoneyStr | None
    total_expense: MoneyStr | None


class ImportResultOut(BaseModel):
    import_id: uuid.UUID
    imported: int
    duplicates: int
