import uuid
from datetime import date, datetime
from decimal import Decimal

from pydantic import BaseModel, Field, field_serializer, field_validator, model_validator

from app.core.banks import BANK_CODE_PATTERN
from app.core.card_masks import MAX_CARD_MASKS, validate_card_masks
from app.core.money import Money, MoneyStr, reject_float

ACCOUNT_TYPES = "^(card|cash|savings)$"
CATEGORY_KINDS = "^(income|expense)$"
COUNTERPARTY_KINDS = "^(person|organization)$"

# столько счетов не бывает ни у одного банка: ограничение отбивает пачку,
# которая заведомо не про счета
MAX_DISCOVERED_ACCOUNTS = 100
FINGERPRINT = r"^[0-9a-f]{64}$"


class AccountCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    type: str = Field(pattern=ACCOUNT_TYPES)
    currency: str = Field(default="RUB", min_length=3, max_length=3)
    # банк необязателен: у наличных его нет. Отпечаток — только вместе с банком
    # и только для счёта, который банк уже показал (см. service.create_account)
    bank_code: str | None = Field(default=None, pattern=BANK_CODE_PATTERN)
    bank_account_fingerprint: str | None = Field(default=None, pattern=FINGERPRINT)

    @model_validator(mode="after")
    def _fingerprint_needs_bank(self) -> "AccountCreate":
        if self.bank_account_fingerprint is not None and self.bank_code is None:
            # отпечаток считается от банка и без него не значит ничего
            raise ValueError("отпечаток счёта банка без кода банка")
        return self


class AccountLink(BaseModel):
    """Привязка уже заведённого счёта к счёту банка.

    Отдельно от AccountUpdate: та меняет то, что человек правит в форме счёта,
    а привязка — разовое событие со своими отказами.
    """

    bank_code: str = Field(pattern=BANK_CODE_PATTERN)
    bank_account_fingerprint: str = Field(pattern=FINGERPRINT)


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
    # банк счёта; null — наличные или банк без плагина
    bank_code: str | None
    # привязан ли счёт к счёту банка: фронт предлагает привязывать только
    # непривязанные. Сам отпечаток наружу не отдаём — он там не нужен
    is_bank_linked: bool
    # кредитный лимит и момент, когда его в последний раз называл банк; пусто —
    # лимита у счёта не наблюдали
    credit_limit: MoneyStr | None
    credit_limit_at: datetime | None
    # сколько можно потратить: лимит плюс остаток. Пусто — лимит и остаток
    # известны на разные моменты, и считать их вместе значило бы соврать
    credit_available: MoneyStr | None


class BankOut(BaseModel):
    code: str
    name: str


class DiscoveredAccountIn(BaseModel):
    """Счёт, который банк показал коллектору.

    Банковского типа счёта здесь нет: это слово банка, и в ядро оно не едет
    (спека 2026-09-15, §5.2). Тип своего счёта человек выбирает при заведении.
    """

    fingerprint: str = Field(pattern=FINGERPRINT)
    # пустое имя законно: банк не всегда даёт счёту название, и все три плагина
    # подставляют пустую строку. Потребуй мы непустого — сбор падал бы целиком
    # из-за счёта, который человек и так узнаёт по картам
    name: str = Field(max_length=200)
    # плагин не всегда распознаёт валюту, и это не повод скрывать счёт
    currency: str | None = Field(default=None, min_length=3, max_length=3)
    balance: Money | None = None
    card_masks: list[str] = Field(default_factory=list, max_length=MAX_CARD_MASKS)

    @field_validator("balance", mode="before")
    @classmethod
    def _balance_not_float(cls, value: object) -> object:
        return reject_float(value)

    @field_validator("card_masks")
    @classmethod
    def _masks_are_four_digits(cls, value: list[str]) -> list[str]:
        return validate_card_masks(value)


class DiscoveredSyncIn(BaseModel):
    accounts: list[DiscoveredAccountIn] = Field(max_length=MAX_DISCOVERED_ACCOUNTS)

    @model_validator(mode="after")
    def _unique_fingerprints(self) -> "DiscoveredSyncIn":
        fingerprints = [item.fingerprint for item in self.accounts]
        if len(fingerprints) != len(set(fingerprints)):
            # один счёт банка дважды в одной пачке — баг коллектора; без этой
            # проверки на него отвечал бы уникальный индекс, то есть 500 вместо
            # названной причины. Так же устроен приём операций импорта
            raise ValueError("повторяющийся отпечаток счёта в одном запросе")
        return self


class DiscoveredSyncOut(BaseModel):
    # отпечаток → счёт приложения: по нему коллектор понимает, куда слать импорт
    linked: dict[str, uuid.UUID]


class DiscoveredAccountOut(BaseModel):
    fingerprint: str
    bank_code: str
    # название банка отдаёт бэкенд: словарь живёт в одном месте
    bank_name: str
    name: str
    currency: str | None
    balance: MoneyStr | None
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
    # имя контрагента, за которым закреплена эта банковская строка; пусто —
    # никого не закрепили. Едет рядом с merchant, а не вместо него: банковскую
    # строку подменять нельзя, иначе не разобрать, почему подпись сопоставилась
    counterparty_name: str | None
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
    """Сколько операций без категории подпадает под разбор: у операции — ещё
    столько же описанных так же, у контрагента — подписанных им."""

    count: int


class SimilarAppliedOut(BaseModel):
    """Сколько операций получили категорию при разборе."""

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
    # и по той же причине — банк: список счетов и дашборд обязаны раскладывать
    # одни и те же счета одинаково
    bank_code: str | None
    credit_limit: MoneyStr | None
    credit_limit_at: datetime | None
    credit_available: MoneyStr | None


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
