import uuid
from datetime import date
from decimal import Decimal
from typing import Annotated, Literal

from pydantic import BaseModel, Field, field_validator, model_validator

from app.core.money import MoneyStr

ImportStatus = Literal["processing", "ready", "failed", "completed"]


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


class ImportStartedOut(BaseModel):
    import_id: uuid.UUID
    status: ImportStatus


class ImportStatusOut(BaseModel):
    import_id: uuid.UUID
    status: ImportStatus
    parser: str | None
    error: str | None
    warnings: list[str]
    preview: ImportPreviewOut | None


# границы совпадают с NUMERIC(20,4) в ledger — иначе переполнение всплывёт уже
# на вставке транзакции, после того как запись импорта успела уйти в ready
# (тот же приём — в app/imports/llm_parser.py)
Money = Annotated[Decimal, Field(max_digits=20, decimal_places=4)]

# префикс отделяет пространство id банка от наших sha256-хешей дедупа (тоже
# 64-символьный hex): без него банковский id мог бы случайно совпасть с хешем
# чужой операции и потерять её как «дубль»
BANK_EXTERNAL_ID_PREFIX = "bank:"


def _reject_control_chars(value: str) -> str:
    # клиент — коллектор, а не файл: NUL и прочие управляющие символы здесь
    # не опечатка пользователя, а либо баг коллектора, либо испорченный ответ
    # банка — Postgres такой текст всё равно не примет, лучше 422, чем 500
    if any(ord(ch) < 0x20 or ord(ch) == 0x7F for ch in value):
        raise ValueError("недопустимый управляющий символ")
    return value


class ParsedOperationIn(BaseModel):
    occurred_at: date
    amount: Money
    currency: str = Field(min_length=3, max_length=3)
    description: str = Field(default="", max_length=1000)
    # идентификатор операции у банка — на нём держится дедуп; префикс bank:
    # добавляем сами при сохранении, длину здесь ограничиваем с запасом под него
    external_id: str = Field(min_length=1, max_length=64 - len(BANK_EXTERNAL_ID_PREFIX))

    @field_validator("amount")
    @classmethod
    def _amount_not_zero(cls, value: Decimal) -> Decimal:
        if value == 0:
            # в ledger нулевая сумма и так запрещена (SignMismatchError), но там уже
            # поздно: запись импорта успела бы уйти в ready и застрять на этом навсегда
            raise ValueError("операция с нулевой суммой")
        return value

    @field_validator("description", "external_id")
    @classmethod
    def _no_control_chars(cls, value: str) -> str:
        return _reject_control_chars(value)


class ParsedImportIn(BaseModel):
    parser: str = Field(min_length=1, max_length=30, pattern=r"^[a-z0-9_]+$")
    operations: list[ParsedOperationIn] = Field(min_length=1)

    @model_validator(mode="after")
    def _unique_external_ids(self) -> "ParsedImportIn":
        ids = [op.external_id for op in self.operations]
        if len(ids) != len(set(ids)):
            # одинаковые id в одном запросе — баг коллектора: вторая операция
            # молча пропадёт как «дубль» первой, хотя это разные операции
            raise ValueError("повторяющийся external_id в одном запросе")
        return self
