import uuid
from datetime import date, datetime
from decimal import Decimal

from pydantic import BaseModel, Field, field_serializer

from app.core.money import MoneyStr

ACCOUNT_TYPES = "^(card|cash|savings)$"
CATEGORY_KINDS = "^(income|expense)$"
COUNTERPARTY_KINDS = "^(person|organization)$"


class AccountCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    type: str = Field(pattern=ACCOUNT_TYPES)
    currency: str = Field(default="RUB", min_length=3, max_length=3)


class AccountUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    is_archived: bool | None = None
    # текущий остаток, каким его видит человек; поправку к сумме операций
    # считает бэкенд, наружу это понятие не выносится
    balance: Decimal | None = None


class AccountOut(BaseModel):
    id: uuid.UUID
    name: str
    type: str
    currency: str
    is_archived: bool
    balance: MoneyStr
    # момент, на который верен остаток от источника; пусто — счёт ведётся
    # руками, и остаток считается по операциям
    reported_at: datetime | None
    # последние четыре цифры карт; пусто у счетов без карт
    card_masks: list[str]


class CategoryCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    kind: str = Field(pattern=CATEGORY_KINDS)
    parent_id: uuid.UUID | None = None


class CategoryUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    parent_id: uuid.UUID | None = None


class CategoryOut(BaseModel):
    id: uuid.UUID
    parent_id: uuid.UUID | None
    name: str
    kind: str


class DescriptionRuleCreate(BaseModel):
    text: str = Field(min_length=1, max_length=300)
    category_id: uuid.UUID


class DescriptionRuleOut(BaseModel):
    # отдаём нормализованный текст, а не исходный: правило ищется именно по нему,
    # и человек должен видеть тот ключ, который реально сработает
    id: uuid.UUID
    normalized_text: str
    # ровно одно из двух непусто: правило ведёт либо прямо в категорию, либо в
    # контрагента, у которого категория своя (ограничение в БД это и требует).
    # Объяви category_id обязательным — первое же правило через контрагента
    # уронило бы выдачу правил пятисоткой на проверке схемы
    category_id: uuid.UUID | None
    counterparty_id: uuid.UUID | None
    source: str


class CounterpartyCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    kind: str = Field(pattern=COUNTERPARTY_KINDS)
    # необязательная: контрагент без категории — просто имя вместо банковской
    # строки, и такой контрагент полезен сам по себе
    category_id: uuid.UUID | None = None
    # подписи — то, как контрагента пишет каждый банк; в базе они лягут
    # правилами, ведущими в него
    signatures: list[str] = Field(default_factory=list)


class CounterpartyUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    # null здесь — не «поле не прислали», а «снять категорию»; различает их
    # update_counterparty по model_fields_set
    category_id: uuid.UUID | None = None


class CounterpartyOut(BaseModel):
    id: uuid.UUID
    name: str
    kind: str
    category_id: uuid.UUID | None
    # нормализованные ключи правил, ведущих в этого контрагента: человек должен
    # видеть то, что действительно сработает
    signatures: list[str]


class UnknownSignatureOut(BaseModel):
    """Подпись переводов, про которую ещё не решили. Сумм здесь нет намеренно:
    для узнавания человека довольно счётчиков."""

    text: str
    operations: int
    sent: int
    received: int


class TransactionCreate(BaseModel):
    account_id: uuid.UUID
    category_id: uuid.UUID | None = None
    amount: Decimal
    occurred_at: date
    merchant: str | None = Field(default=None, max_length=300)
    note: str | None = Field(default=None, max_length=1000)


class TransactionUpdate(BaseModel):
    category_id: uuid.UUID | None = None
    amount: Decimal | None = None
    occurred_at: date | None = None
    merchant: str | None = Field(default=None, max_length=300)
    note: str | None = Field(default=None, max_length=1000)
    # null здесь — не «поле не прислали», а «сбросить решение человека»;
    # различает их update_transaction по model_fields_set
    spending_override: bool | None = None


class TransferCreate(BaseModel):
    from_account_id: uuid.UUID
    to_account_id: uuid.UUID
    from_amount: Decimal = Field(gt=0)
    to_amount: Decimal = Field(gt=0)
    occurred_at: date
    note: str | None = Field(default=None, max_length=1000)


class TransactionOut(BaseModel):
    id: uuid.UUID
    account_id: uuid.UUID
    category_id: uuid.UUID | None
    amount: MoneyStr
    currency: str
    occurred_at: date
    merchant: str | None
    note: str | None
    transfer_group_id: uuid.UUID | None
    operation_kind: str
    spending_override: bool | None
    # решение правила по виду и переопределению: фронт его читает, а не считает
    # сам — иначе появилась бы вторая реализация правила
    counts_in_stats: bool
    category_confirmed: bool
    suggested_category_id: uuid.UUID | None
    category_confidence: Decimal | None

    @field_serializer("category_confidence")
    def _serialize_confidence(self, value: Decimal | None) -> str | None:
        return None if value is None else format(value.quantize(Decimal("0.001")), "f")


class TransactionList(BaseModel):
    items: list[TransactionOut]
    total: int


class SimilarUncategorizedOut(BaseModel):
    """Сколько ещё операций без категории описаны так же, как эта."""

    count: int


class SimilarAppliedOut(BaseModel):
    """Сколько операций получили категорию при разборе похожих."""

    applied: int


class DashboardAccount(BaseModel):
    id: uuid.UUID
    name: str
    type: str
    currency: str
    balance: MoneyStr
    # то же, что в AccountOut: остаток без момента и счёт без опознавательного
    # знака непонятны на любом экране, а дашборд обязан отдавать всё одним ответом
    reported_at: datetime | None
    card_masks: list[str]


class MonthExpense(BaseModel):
    category_id: uuid.UUID | None
    category_name: str
    total: MoneyStr


class RecentTransaction(BaseModel):
    id: uuid.UUID
    occurred_at: date
    amount: MoneyStr
    currency: str
    account_name: str
    category_name: str | None
    merchant: str | None
    # то же правило, что и в расходах месяца: строку, которой в них нет, лента
    # обязана пометить — иначе прочерк в колонке категории нечем объяснить
    counts_in_stats: bool


class DashboardOut(BaseModel):
    accounts: list[DashboardAccount]
    month_expenses: list[MonthExpense]
    recent: list[RecentTransaction]
