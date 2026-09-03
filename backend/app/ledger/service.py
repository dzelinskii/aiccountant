import unicodedata
import uuid
from datetime import date, datetime
from decimal import Decimal
from typing import NamedTuple

from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.operation_kinds import OperationKind, kind_from_amount
from app.ledger import repository
from app.ledger.balance import visible_balance
from app.ledger.models import Account, Category, DescriptionRule, Transaction
from app.ledger.schemas import (
    AccountCreate,
    AccountUpdate,
    CategoryCreate,
    CategoryUpdate,
    DashboardAccount,
    DashboardOut,
    MonthExpense,
    RecentTransaction,
    TransactionCreate,
    TransactionUpdate,
    TransferCreate,
)
from app.ledger.tasks import enqueue_categorize


class NotFoundError(Exception):
    pass


def _visible_balance(account: Account, operations_sum: Decimal) -> Decimal:
    """Остаток счёта: наружу отдаём его, а не сумму операций."""
    return visible_balance(account.reported_balance, account.balance_adjustment, operations_sum)


async def list_accounts(db: AsyncSession, workspace_id: uuid.UUID) -> list[tuple[Account, Decimal]]:
    rows = await repository.list_accounts_with_operations_sum(db, workspace_id)
    return [(account, _visible_balance(account, total)) for account, total in rows]


async def create_account(
    db: AsyncSession, workspace_id: uuid.UUID, payload: AccountCreate
) -> tuple[Account, Decimal]:
    account = Account(
        workspace_id=workspace_id,
        name=payload.name,
        type=payload.type,
        currency=payload.currency,
    )
    repository.add_account(db, account)
    await db.commit()
    return account, Decimal(0)


async def update_account(
    db: AsyncSession, workspace_id: uuid.UUID, account_id: uuid.UUID, payload: AccountUpdate
) -> tuple[Account, Decimal]:
    account = await repository.get_account(db, workspace_id, account_id)
    if account is None:
        raise NotFoundError
    if payload.name is not None:
        account.name = payload.name
    if payload.is_archived is not None:
        account.is_archived = payload.is_archived
    await db.commit()
    operations_sum = await repository.account_operations_sum(db, workspace_id, account_id)
    return account, _visible_balance(account, operations_sum)


async def apply_reported_balance(
    db: AsyncSession,
    workspace_id: uuid.UUID,
    account_id: uuid.UUID,
    balance: Decimal,
    card_masks: list[str],
    reported_at: datetime,
) -> None:
    """Записать остаток и метки карт, сообщённые источником.

    Без commit: вызывается из подтверждения импорта, и остаток обязан появиться
    ровно вместе с операциями, а не отдельной транзакцией.
    """
    account = await repository.get_account(db, workspace_id, account_id)
    if account is None:
        raise NotFoundError
    if account.reported_at is not None and reported_at <= account.reported_at:
        # верен последний сбор, а не последнее подтверждение: импорты ждут
        # своей очереди и подтверждаются в произвольном порядке, а список
        # показывает их свежими вверх — то есть скорее в обратном
        return
    account.reported_balance = balance
    account.reported_at = reported_at
    # только присваиванием: колонка — обычный JSONB, правку списка на месте
    # SQLAlchemy молча не заметит
    account.card_masks = card_masks


async def seed_categories(db: AsyncSession, workspace_id: uuid.UUID) -> None:
    repository.seed_default_categories(db, workspace_id)
    await db.commit()


async def list_categories(db: AsyncSession, workspace_id: uuid.UUID) -> list[Category]:
    return await repository.list_categories(db, workspace_id)


async def create_category(
    db: AsyncSession, workspace_id: uuid.UUID, payload: CategoryCreate
) -> Category:
    # родитель обязан жить в том же workspace — иначе межворкспейсная ссылка
    if payload.parent_id is not None:
        parent = await repository.get_category(db, workspace_id, payload.parent_id)
        if parent is None:
            raise NotFoundError
    category = Category(
        workspace_id=workspace_id,
        name=payload.name,
        kind=payload.kind,
        parent_id=payload.parent_id,
    )
    repository.add_category(db, category)
    await db.commit()
    return category


async def update_category(
    db: AsyncSession, workspace_id: uuid.UUID, category_id: uuid.UUID, payload: CategoryUpdate
) -> Category:
    category = await repository.get_category(db, workspace_id, category_id)
    if category is None:
        raise NotFoundError
    if payload.name is not None:
        category.name = payload.name
    if payload.parent_id is not None:
        parent = await repository.get_category(db, workspace_id, payload.parent_id)
        if parent is None:
            raise NotFoundError
        category.parent_id = payload.parent_id
    await db.commit()
    return category


def category_matches_amount(kind: str, amount: Decimal) -> bool:
    """Соответствует ли знак суммы направлению категории: расход записывается
    отрицательной суммой, доход — положительной.

    Правило живёт здесь в единственном экземпляре, потому что спрашивают его
    из разных мест и с разными последствиями: ручной ввод и правка отвечают
    отказом, а импорт молча пропускает категорию, чтобы одна строка не уронила
    всю пачку. Две копии выражения разошлись бы, и импорт снова падал бы там,
    где обязан прощать.
    """
    return (kind == "expense") == (amount < 0)


class DuplicateRuleError(Exception):
    """Правило для такого описания уже есть."""


class InvalidRuleTextError(Exception):
    """Из описания не выходит ключ правила: пусто или длиннее колонки."""


# длина колонки normalized_text; меряем по ключу, а не по присланному тексту
RULE_TEXT_MAX_LENGTH = 300


def normalize_description(text: str) -> str:
    """Ключ правила «описание → категория».

    Нормализация намеренно простая — регистр и лишние пробелы. Вычищать «шум»
    банковских описаний регулярками значит подгонять систему под один банк,
    а формат описания у каждого свой.

    NFC — не подгонка, а приведение к одной форме записи: «й» одним кодпоинтом
    и «й» из «и» с надстрочным знаком выглядят одинаково, и правило, введённое
    руками, обязано совпасть с тем, что прислал банк. Иначе оно молча
    не сработает — худший вид отказа.
    """
    return unicodedata.normalize("NFC", " ".join(text.split()).lower())


async def create_description_rule(
    db: AsyncSession, workspace_id: uuid.UUID, text: str, category_id: uuid.UUID
) -> DescriptionRule:
    # проверяем ключ, а не присланный текст: в базу уходит именно он, и его
    # длина от исходной отличается — строка из одних пробелов даёт пустой ключ,
    # а приведение к нижнему регистру бывает и удлиняет (İ → i + точка)
    normalized = normalize_description(text)
    if not normalized or len(normalized) > RULE_TEXT_MAX_LENGTH:
        raise InvalidRuleTextError
    # категория обязана жить в том же workspace — иначе межворкспейсная ссылка.
    # Проверяем раньше дубля: иначе повтор описания скрыл бы вторую ошибку
    if await repository.get_category(db, workspace_id, category_id) is None:
        raise NotFoundError
    if await repository.find_description_rule(db, workspace_id, normalized) is not None:
        raise DuplicateRuleError
    rule = DescriptionRule(
        workspace_id=workspace_id,
        normalized_text=normalized,
        category_id=category_id,
        source="manual",
    )
    repository.add_description_rule(db, rule)
    try:
        await db.commit()
    except IntegrityError:
        # два одновременных создания: проверка выше их не ловит (обе сессии
        # видят пустоту), ловит уникальный индекс. Ответ должен быть тем же
        # честным «уже есть», а не 500 со сломанной сессией
        await db.rollback()
        raise DuplicateRuleError from None
    return rule


async def list_description_rules(
    db: AsyncSession, workspace_id: uuid.UUID
) -> list[DescriptionRule]:
    return await repository.list_description_rules(db, workspace_id)


async def delete_description_rule(
    db: AsyncSession, workspace_id: uuid.UUID, rule_id: uuid.UUID
) -> None:
    rule = await repository.get_description_rule(db, workspace_id, rule_id)
    if rule is None:
        raise NotFoundError
    await repository.delete_description_rule(db, rule)
    await db.commit()


class RuleTarget(NamedTuple):
    """Куда ведёт правило: категория и её направление. Направление несём рядом,
    чтобы проверить знак суммы, не ходя за категорией отдельным запросом."""

    category_id: uuid.UUID
    kind: str


async def load_description_rules(
    db: AsyncSession, workspace_id: uuid.UUID
) -> dict[str, RuleTarget]:
    """Все правила workspace одним запросом — их единицы, а операций в пачке
    до десятков тысяч; запрос на строку превратил бы импорт в N+1."""
    return {
        text: RuleTarget(category_id, kind)
        for text, category_id, kind in await repository.description_rule_targets(db, workspace_id)
    }


def category_for_description(
    rules: dict[str, RuleTarget], description: str | None, amount: Decimal
) -> uuid.UUID | None:
    """Категория по правилу для описания операции, если правило есть.

    Знак суммы проверяем здесь: инвариант «расход → категория расходов» иначе
    уронил бы весь импорт из-за одной строки, а такая строка — обычное дело
    (тому же человеку и переводят, и он переводит в ответ).
    """
    if not description:
        return None
    target = rules.get(normalize_description(description))
    if target is None or not category_matches_amount(target.kind, amount):
        return None
    return target.category_id


class SignMismatchError(Exception):
    """Знак суммы не соответствует kind категории."""


class InvalidTransferError(Exception):
    """Некорректный перевод (одинаковые счета, чужой счёт и т.п.)."""


class TransferEditError(Exception):
    """Строку перевода нельзя править — только удалить и создать заново."""


async def validate_posting(
    db: AsyncSession,
    workspace_id: uuid.UUID,
    *,
    account_id: uuid.UUID,
    category_id: uuid.UUID | None,
    amount: Decimal,
) -> Account:
    """Проверить счёт (workspace) и, если категория задана, соответствие её kind
    знаку суммы. Категория опциональна; знак ≠ 0 требуется всегда."""
    account = await repository.get_account(db, workspace_id, account_id)
    if account is None:
        raise NotFoundError
    if amount == 0:
        raise SignMismatchError
    if category_id is not None:
        category = await repository.get_category(db, workspace_id, category_id)
        if category is None:
            raise NotFoundError
        if not category_matches_amount(category.kind, amount):
            raise SignMismatchError
    return account


async def post_transaction(
    db: AsyncSession,
    workspace_id: uuid.UUID,
    user_id: uuid.UUID,
    *,
    account_id: uuid.UUID,
    category_id: uuid.UUID | None,
    amount: Decimal,
    occurred_at: date,
    source: str,
    merchant: str | None = None,
    note: str | None = None,
    external_id: str | None = None,
    import_id: uuid.UUID | None = None,
    operation_kind: OperationKind = "unknown",
) -> Transaction:
    """Провести обычную операцию (расход/доход) без commit — для переиспользования
    ручным вводом, регуляркой и импортом выписок."""
    account = await validate_posting(
        db, workspace_id, account_id=account_id, category_id=category_id, amount=amount
    )

    transaction = Transaction(
        workspace_id=workspace_id,
        account_id=account.id,
        category_id=category_id,
        amount=amount,
        currency=account.currency,
        occurred_at=occurred_at,
        merchant=merchant,
        note=note,
        source=source,
        created_by=user_id,
        external_id=external_id,
        import_id=import_id,
        operation_kind=operation_kind,
    )
    repository.add_transaction(db, transaction)
    await db.flush()
    return transaction


async def existing_external_ids(
    db: AsyncSession, workspace_id: uuid.UUID, account_id: uuid.UUID, external_ids: set[str]
) -> set[str]:
    return await repository.existing_external_ids(db, workspace_id, account_id, external_ids)


async def account_exists(db: AsyncSession, workspace_id: uuid.UUID, account_id: uuid.UUID) -> bool:
    return await repository.get_account(db, workspace_id, account_id) is not None


async def get_account_currency(
    db: AsyncSession, workspace_id: uuid.UUID, account_id: uuid.UUID
) -> str | None:
    """Валюта счёта или None, если счёт не найден (в своём workspace) — там, где,
    кроме факта существования, нужна ещё и валюта, чтобы не ходить в БД дважды."""
    account = await repository.get_account(db, workspace_id, account_id)
    return account.currency if account is not None else None


def enqueue_categorization(workspace_id: uuid.UUID) -> None:
    """Публичная точка постановки категоризации в очередь — её зовут роутер и
    модуль imports; так границы соблюдены (imports ходит только в ledger.service)."""
    enqueue_categorize(workspace_id)


async def create_transaction(
    db: AsyncSession, workspace_id: uuid.UUID, user_id: uuid.UUID, payload: TransactionCreate
) -> Transaction:
    transaction = await post_transaction(
        db,
        workspace_id,
        user_id,
        account_id=payload.account_id,
        category_id=payload.category_id,
        amount=payload.amount,
        occurred_at=payload.occurred_at,
        source="manual",
        merchant=payload.merchant,
        note=payload.note,
        operation_kind=kind_from_amount(payload.amount),
    )
    await db.commit()
    return transaction


async def create_transfer(
    db: AsyncSession, workspace_id: uuid.UUID, user_id: uuid.UUID, payload: TransferCreate
) -> list[Transaction]:
    if payload.from_account_id == payload.to_account_id:
        raise InvalidTransferError
    src = await repository.get_account(db, workspace_id, payload.from_account_id)
    dst = await repository.get_account(db, workspace_id, payload.to_account_id)
    if src is None or dst is None:
        raise InvalidTransferError

    group_id = uuid.uuid4()
    outflow = Transaction(
        workspace_id=workspace_id,
        account_id=src.id,
        category_id=None,
        amount=-payload.from_amount,
        currency=src.currency,
        occurred_at=payload.occurred_at,
        note=payload.note,
        source="manual",
        transfer_group_id=group_id,
        operation_kind="transfer_self",
        created_by=user_id,
    )
    inflow = Transaction(
        workspace_id=workspace_id,
        account_id=dst.id,
        category_id=None,
        amount=payload.to_amount,
        currency=dst.currency,
        occurred_at=payload.occurred_at,
        note=payload.note,
        source="manual",
        transfer_group_id=group_id,
        operation_kind="transfer_self",
        created_by=user_id,
    )
    repository.add_transaction(db, outflow)
    repository.add_transaction(db, inflow)
    await db.commit()  # обе строки или ни одной — один commit
    return [outflow, inflow]


async def update_transaction(
    db: AsyncSession,
    workspace_id: uuid.UUID,
    transaction_id: uuid.UUID,
    payload: TransactionUpdate,
) -> Transaction:
    transaction = await repository.get_transaction(db, workspace_id, transaction_id)
    if transaction is None:
        raise NotFoundError
    if transaction.transfer_group_id is not None:
        raise TransferEditError

    # инвариант «знак суммы соответствует kind категории» проверяем всегда по
    # ИТОГОВой паре после правки, даже если меняется только сумма или только
    # категория — иначе расход можно было бы сделать положительным
    new_category_id = (
        payload.category_id if payload.category_id is not None else transaction.category_id
    )
    new_amount = payload.amount if payload.amount is not None else transaction.amount
    if new_amount == 0:
        raise SignMismatchError
    if new_category_id is not None:
        category = await repository.get_category(db, workspace_id, new_category_id)
        if category is None:
            raise NotFoundError
        if not category_matches_amount(category.kind, new_amount):
            raise SignMismatchError

    transaction.category_id = new_category_id
    if payload.category_id is not None:
        # пользователь явно выбрал категорию (подтвердил подсказку или переопределил)
        transaction.category_confirmed = True
        transaction.suggested_category_id = None
    if payload.amount is not None:
        transaction.amount = payload.amount
        if transaction.source == "manual":
            # вид ручной операции выведен из знака суммы, поэтому при смене знака
            # обязан пересчитаться. У остальных источников вид — факт от банка
            # или правила, и правка суммы человеком его не затирает
            transaction.operation_kind = kind_from_amount(payload.amount)
    if payload.occurred_at is not None:
        transaction.occurred_at = payload.occurred_at
    if payload.merchant is not None:
        transaction.merchant = payload.merchant
    if payload.note is not None:
        transaction.note = payload.note
    # именно model_fields_set, а не "is not None": здесь null — осмысленное
    # значение «сбросить решение, пусть снова решает правило по виду операции».
    # Обычная проверка на None их не различает, и сбросить переопределение
    # через API стало бы невозможно
    if "spending_override" in payload.model_fields_set:
        transaction.spending_override = payload.spending_override
    await db.commit()
    return transaction


async def dismiss_suggestion(
    db: AsyncSession, workspace_id: uuid.UUID, transaction_id: uuid.UUID
) -> Transaction:
    transaction = await repository.get_transaction(db, workspace_id, transaction_id)
    if transaction is None:
        raise NotFoundError
    transaction.suggested_category_id = None
    # отклонение подсказки — это решение человека оставить операцию без категории;
    # помечаем как подтверждённое, чтобы классификатор не предлагал её снова
    transaction.category_confirmed = True
    await db.commit()
    return transaction


async def delete_transaction(
    db: AsyncSession, workspace_id: uuid.UUID, transaction_id: uuid.UUID
) -> None:
    transaction = await repository.get_transaction(db, workspace_id, transaction_id)
    if transaction is None:
        raise NotFoundError
    if transaction.transfer_group_id is not None:
        group = await repository.get_transfer_group(db, workspace_id, transaction.transfer_group_id)
        for row in group:
            await repository.delete_transaction(db, row)
    else:
        await repository.delete_transaction(db, transaction)
    await db.commit()  # обе строки перевода удаляются атомарно


async def list_transactions(
    db: AsyncSession,
    workspace_id: uuid.UUID,
    *,
    account_id: uuid.UUID | None = None,
    category_id: uuid.UUID | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
    limit: int = 50,
    offset: int = 0,
) -> tuple[list[Transaction], int]:
    return await repository.list_transactions(
        db,
        workspace_id,
        account_id=account_id,
        category_id=category_id,
        date_from=date_from,
        date_to=date_to,
        limit=limit,
        offset=offset,
    )


async def build_dashboard(db: AsyncSession, workspace_id: uuid.UUID) -> DashboardOut:
    today = date.today()
    month_start = today.replace(day=1)
    # начало следующего месяца — верхняя граница периода (полуинтервал)
    next_month_start = (
        month_start.replace(year=month_start.year + 1, month=1)
        if month_start.month == 12
        else month_start.replace(month=month_start.month + 1)
    )

    # через list_accounts, а не напрямую из repository: дашборд и список счетов
    # показывают одну и ту же величину, и считать её обязаны одинаково
    accounts = await list_accounts(db, workspace_id)
    expenses = await repository.month_expenses_by_category(
        db, workspace_id, month_start, next_month_start
    )
    recent = await repository.recent_transactions(db, workspace_id)

    return DashboardOut(
        accounts=[
            DashboardAccount(id=a.id, name=a.name, currency=a.currency, balance=bal)
            for a, bal in accounts
        ],
        month_expenses=[
            MonthExpense(category_id=cid, category_name=name or "Без категории", total=total)
            for cid, name, total in expenses
        ],
        recent=[
            RecentTransaction(
                id=t.id,
                occurred_at=t.occurred_at,
                amount=t.amount,
                currency=t.currency,
                account_name=acc_name,
                category_name=cat_name,
                merchant=t.merchant,
                counts_in_stats=repository.transaction_counts_in_stats(t),
            )
            for t, acc_name, cat_name in recent
        ],
    )
