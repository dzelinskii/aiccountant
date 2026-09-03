import re
import uuid
from datetime import date, datetime
from decimal import Decimal
from typing import Annotated, Literal

from pydantic import BaseModel, Field, field_validator, model_validator

from app.core.money import MoneyStr
from app.core.operation_kinds import OperationKind

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


class ImportListItemOut(BaseModel):
    import_id: uuid.UUID
    account_id: uuid.UUID
    parser: str | None
    status: ImportStatus
    file_name: str
    created_at: datetime
    operations_count: int


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
    # вид операции в нашем словаре; словарь конкретного банка переводит коннектор.
    # unknown по умолчанию — источники без классификации (PDF-выписка) валидны
    kind: OperationKind = "unknown"

    @field_validator("amount", mode="before")
    @classmethod
    def _amount_not_float(cls, value: object) -> object:
        if isinstance(value, float):
            # к моменту валидации разряды уже потеряны: 12345678901234.5678
            # приходит как 12345678901234.568, и починить это здесь нечем.
            # На проводе сумма — строка, как и везде в проекте (тот же приём —
            # parse_float=Decimal в app/imports/llm_parser.py)
            raise ValueError("сумма должна быть строкой, а не числом JSON")
        return value

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


# десять лет истории по счёту — это порядка 8000 операций одним ответом банка,
# так что запас втрое покрывает первичный импорт с большим окном. Верхняя
# граница нужна затем же, зачем MAX_UPLOAD_BYTES у загрузки файла: тело
# читается в память целиком, и предсказуемость важнее гостеприимства
MAX_PARSED_OPERATIONS = 25_000


CARD_MASK = r"^[0-9]{4}$"
# счёт с десятком карт — уже нечто иное, чем домашний счёт; ограничение здесь
# затем же, зачем MAX_PARSED_OPERATIONS: предсказуемость размера тела запроса
MAX_CARD_MASKS = 10


class ParsedAccountIn(BaseModel):
    """Что источник знает о самом счёте на момент сбора.

    Момент не присылаем: временем считается создание импорта — оно и есть
    момент обращения к банку, а доверять часам чужой машины незачем.
    """

    balance: Money
    card_masks: list[str] = Field(default_factory=list, max_length=MAX_CARD_MASKS)

    @field_validator("balance", mode="before")
    @classmethod
    def _balance_not_float(cls, value: object) -> object:
        if isinstance(value, float):
            # к моменту валидации разряды уже потеряны — то же правило, что
            # у сумм операций (см. ParsedOperationIn)
            raise ValueError("остаток должен быть строкой, а не числом JSON")
        return value

    @field_validator("card_masks")
    @classmethod
    def _masks_are_four_digits(cls, value: list[str]) -> list[str]:
        for mask in value:
            # хранить кусок номера карты сверх последних четырёх цифр мы не
            # собираемся, а укороченная метка не опознаёт счёт — и то и другое
            # означает баг коллектора
            if not re.fullmatch(CARD_MASK, mask):
                raise ValueError("метка карты — ровно четыре цифры")
        return value


class ParsedImportIn(BaseModel):
    parser: str = Field(min_length=1, max_length=30, pattern=r"^[a-z0-9_]+$")
    operations: list[ParsedOperationIn] = Field(min_length=1, max_length=MAX_PARSED_OPERATIONS)
    # необязательный: разбор PDF-выписки про счёт ничего не знает
    account: ParsedAccountIn | None = None

    @model_validator(mode="after")
    def _unique_external_ids(self) -> "ParsedImportIn":
        ids = [op.external_id for op in self.operations]
        if len(ids) != len(set(ids)):
            # одинаковые id в одном запросе — баг коллектора: вторая операция
            # молча пропадёт как «дубль» первой, хотя это разные операции
            raise ValueError("повторяющийся external_id в одном запросе")
        return self
