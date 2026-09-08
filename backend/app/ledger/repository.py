import uuid
from datetime import date
from decimal import Decimal

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased
from sqlalchemy.sql.elements import ColumnElement

from app.core.operation_kinds import IN_STATS_KINDS, counts_in_stats
from app.ledger.models import Account, Category, Counterparty, DescriptionRule, Transaction


def counts_in_stats_sql() -> ColumnElement[bool]:
    """Правило участия операции в статистике и категоризации выражением SQL.

    Само правило — counts_in_stats, здесь только перевод на язык запроса:
    coalesce повторяет её приоритет решения человека, а набор видов тот же.
    """
    return func.coalesce(
        Transaction.spending_override, Transaction.operation_kind.in_(IN_STATS_KINDS)
    )


def transaction_counts_in_stats(transaction: Transaction) -> bool:
    """То же правило для одной прочитанной строки: ответ API и цифры дашборда
    обязаны считаться одинаково."""
    return counts_in_stats(transaction.operation_kind, transaction.spending_override)


async def list_accounts_with_operations_sum(
    db: AsyncSession, workspace_id: uuid.UUID
) -> list[tuple[Account, Decimal]]:
    """Счета и сумма их операций. Это не остаток: остаток считает
    app.ledger.balance, и сумма операций — лишь одно из его слагаемых."""
    operations_sum = func.coalesce(func.sum(Transaction.amount), 0)
    stmt = (
        select(Account, operations_sum)
        .outerjoin(Transaction, Transaction.account_id == Account.id)
        .where(Account.workspace_id == workspace_id)
        .group_by(Account.id)
        .order_by(Account.created_at)
    )
    rows = await db.execute(stmt)
    return [(acc, Decimal(total)) for acc, total in rows.all()]


async def get_account(
    db: AsyncSession, workspace_id: uuid.UUID, account_id: uuid.UUID
) -> Account | None:
    account: Account | None = await db.scalar(
        select(Account).where(Account.id == account_id, Account.workspace_id == workspace_id)
    )
    return account


async def account_operations_sum(
    db: AsyncSession, workspace_id: uuid.UUID, account_id: uuid.UUID
) -> Decimal:
    """Сумма операций одного счёта — см. list_accounts_with_operations_sum."""
    stmt = select(func.coalesce(func.sum(Transaction.amount), 0)).where(
        Transaction.workspace_id == workspace_id, Transaction.account_id == account_id
    )
    return Decimal(await db.scalar(stmt) or 0)


def add_account(db: AsyncSession, account: Account) -> None:
    db.add(account)


async def existing_external_ids(
    db: AsyncSession, workspace_id: uuid.UUID, account_id: uuid.UUID, external_ids: set[str]
) -> set[str]:
    if not external_ids:
        return set()
    rows = await db.execute(
        select(Transaction.external_id).where(
            Transaction.workspace_id == workspace_id,
            Transaction.account_id == account_id,
            Transaction.external_id.in_(external_ids),
        )
    )
    return {value for (value,) in rows.all() if value is not None}


# дефолтный набор при создании workspace (§3 спеки)
DEFAULT_CATEGORIES: tuple[tuple[str, str], ...] = (
    ("Еда", "expense"),
    ("Транспорт", "expense"),
    ("Жильё", "expense"),
    ("Связь", "expense"),
    ("Развлечения", "expense"),
    ("Здоровье", "expense"),
    ("Прочее", "expense"),
    ("Зарплата", "income"),
    ("Прочие доходы", "income"),
)


async def list_categories(db: AsyncSession, workspace_id: uuid.UUID) -> list[Category]:
    rows = await db.execute(
        select(Category)
        .where(Category.workspace_id == workspace_id)
        .order_by(Category.kind, Category.name)
    )
    return list(rows.scalars().all())


async def get_category(
    db: AsyncSession, workspace_id: uuid.UUID, category_id: uuid.UUID
) -> Category | None:
    category: Category | None = await db.scalar(
        select(Category).where(Category.id == category_id, Category.workspace_id == workspace_id)
    )
    return category


async def category_by_hint(db: AsyncSession, workspace_id: uuid.UUID, hint: str) -> Category | None:
    category: Category | None = await db.scalar(
        select(Category).where(Category.workspace_id == workspace_id, Category.hint == hint)
    )
    return category


async def category_by_name(
    db: AsyncSession, workspace_id: uuid.UUID, name: str, parent_id: uuid.UUID | None
) -> Category | None:
    """Категория с таким именем под таким родителем (parent_id = None — верхний
    уровень).

    Имена категорий ничем не ограничены, и одноимённых под одним родителем может
    оказаться несколько; берём самую раннюю. Без порядка выбирал бы план запроса,
    и та же подсказка садилась бы то в одну категорию, то в другую — «вчера
    работало иначе» без единой правки. id — тай-брейк: created_at берётся из
    func.now() и у категорий, созданных в одной транзакции, совпадает.
    """
    category: Category | None = await db.scalar(
        select(Category)
        .where(
            Category.workspace_id == workspace_id,
            Category.name == name,
            Category.parent_id == parent_id,
        )
        .order_by(Category.created_at, Category.id)
    )
    return category


def add_category(db: AsyncSession, category: Category) -> None:
    db.add(category)


def seed_default_categories(db: AsyncSession, workspace_id: uuid.UUID) -> None:
    for name, kind in DEFAULT_CATEGORIES:
        db.add(Category(workspace_id=workspace_id, name=name, kind=kind))


async def find_description_rule(
    db: AsyncSession, workspace_id: uuid.UUID, normalized_text: str
) -> DescriptionRule | None:
    rule: DescriptionRule | None = await db.scalar(
        select(DescriptionRule).where(
            DescriptionRule.workspace_id == workspace_id,
            DescriptionRule.normalized_text == normalized_text,
        )
    )
    return rule


async def list_description_rules(
    db: AsyncSession, workspace_id: uuid.UUID
) -> list[DescriptionRule]:
    rows = await db.execute(
        select(DescriptionRule)
        .where(DescriptionRule.workspace_id == workspace_id)
        .order_by(DescriptionRule.created_at.desc())
    )
    return list(rows.scalars().all())


async def description_rule_targets(
    db: AsyncSession, workspace_id: uuid.UUID
) -> list[tuple[str, uuid.UUID, str]]:
    """Ключ правила, его категория и направление категории — для применения
    правил к пачке операций без запроса на каждую строку.

    Правило ведёт либо прямо в категорию, либо в контрагента, у которого
    категория своя; берём ту, что нашлась. Контрагент без категории — законный
    случай (он может быть просто именем), и такое правило в выборку не попадает:
    подставлять из него нечего.

    Категорию присоединяем с тем же фильтром по workspace: правило и категория
    чужого workspace связаны только друг с другом, и одна снятая проверка
    не должна открывать вторую. Контрагента — по той же причине.
    """
    own = aliased(Category)
    via = aliased(Category)
    counterparty = aliased(Counterparty)
    category_id = func.coalesce(own.id, via.id)
    kind = func.coalesce(own.kind, via.kind)
    rows = await db.execute(
        select(DescriptionRule.normalized_text, category_id, kind)
        .outerjoin(
            own,
            (own.id == DescriptionRule.category_id) & (own.workspace_id == workspace_id),
        )
        .outerjoin(
            counterparty,
            (counterparty.id == DescriptionRule.counterparty_id)
            & (counterparty.workspace_id == workspace_id),
        )
        .outerjoin(via, (via.id == counterparty.category_id) & (via.workspace_id == workspace_id))
        .where(DescriptionRule.workspace_id == workspace_id, category_id.is_not(None))
    )
    return [(text, cid, k) for text, cid, k in rows.all()]


async def get_description_rule(
    db: AsyncSession, workspace_id: uuid.UUID, rule_id: uuid.UUID
) -> DescriptionRule | None:
    rule: DescriptionRule | None = await db.scalar(
        select(DescriptionRule).where(
            DescriptionRule.id == rule_id,
            DescriptionRule.workspace_id == workspace_id,
        )
    )
    return rule


def add_description_rule(db: AsyncSession, rule: DescriptionRule) -> None:
    db.add(rule)


async def delete_description_rule(db: AsyncSession, rule: DescriptionRule) -> None:
    await db.delete(rule)


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
    conditions = [Transaction.workspace_id == workspace_id]
    if account_id is not None:
        conditions.append(Transaction.account_id == account_id)
    if category_id is not None:
        conditions.append(Transaction.category_id == category_id)
    if date_from is not None:
        conditions.append(Transaction.occurred_at >= date_from)
    if date_to is not None:
        conditions.append(Transaction.occurred_at <= date_to)

    total = await db.scalar(select(func.count()).select_from(Transaction).where(*conditions))
    rows = await db.execute(
        select(Transaction)
        .where(*conditions)
        .order_by(Transaction.occurred_at.desc(), Transaction.id.desc())
        .limit(limit)
        .offset(offset)
    )
    return list(rows.scalars().all()), int(total or 0)


async def get_transaction(
    db: AsyncSession, workspace_id: uuid.UUID, transaction_id: uuid.UUID
) -> Transaction | None:
    result: Transaction | None = await db.scalar(
        select(Transaction).where(
            Transaction.id == transaction_id, Transaction.workspace_id == workspace_id
        )
    )
    return result


async def get_transfer_group(
    db: AsyncSession, workspace_id: uuid.UUID, transfer_group_id: uuid.UUID
) -> list[Transaction]:
    rows = await db.execute(
        select(Transaction).where(
            Transaction.workspace_id == workspace_id,
            Transaction.transfer_group_id == transfer_group_id,
        )
    )
    return list(rows.scalars().all())


def add_transaction(db: AsyncSession, transaction: Transaction) -> None:
    db.add(transaction)


async def delete_transaction(db: AsyncSession, transaction: Transaction) -> None:
    await db.delete(transaction)


async def month_expenses_by_category(
    db: AsyncSession, workspace_id: uuid.UUID, month_start: date, next_month_start: date
) -> list[tuple[uuid.UUID | None, str | None, Decimal]]:
    """Расходы месяца по категориям верхнего уровня.

    Подкатегории сворачиваются в родителя: итоги на дашборде считаются по
    верхнему уровню — он стабилен и задан человеком, — а детализация, которую
    приносит банк, видна в ленте операций. Без свёртки первый же сбор с
    подсказками опустошил бы «Еду», разложив её по «Продуктам» и «Кафе».

    Дерево в спеке двухуровневое, и свёртка поднимает ровно на один уровень:
    у категории третьего уровня родитель — подкатегория, в неё она и сложится.
    """
    total = func.sum(-Transaction.amount)
    # COALESCE, а не JOIN на родителя: у категории верхнего уровня parent_id
    # пуст, и она должна считаться сама по себе. У операции без категории пусты
    # обе стороны — она остаётся отдельной строкой без имени, как и была
    top_id = func.coalesce(Category.parent_id, Category.id)
    parent = aliased(Category)
    top_name = func.coalesce(parent.name, Category.name)
    rows = await db.execute(
        select(top_id, top_name, total)
        .outerjoin(Category, Category.id == Transaction.category_id)
        .outerjoin(parent, parent.id == Category.parent_id)
        .where(
            Transaction.workspace_id == workspace_id,
            Transaction.amount < 0,
            counts_in_stats_sql(),
            Transaction.occurred_at >= month_start,
            Transaction.occurred_at < next_month_start,
        )
        .group_by(top_id, top_name)
        .order_by(total.desc())
    )
    return [(cid, name, Decimal(t)) for cid, name, t in rows.all()]


async def recent_transactions(
    db: AsyncSession, workspace_id: uuid.UUID, limit: int = 10
) -> list[tuple[Transaction, str, str | None]]:
    rows = await db.execute(
        select(Transaction, Account.name, Category.name)
        .join(Account, Account.id == Transaction.account_id)
        .outerjoin(Category, Category.id == Transaction.category_id)
        .where(Transaction.workspace_id == workspace_id)
        .order_by(Transaction.occurred_at.desc(), Transaction.id.desc())
        .limit(limit)
    )
    return [(t, acc_name, cat_name) for t, acc_name, cat_name in rows.all()]


async def list_uncategorized(db: AsyncSession, workspace_id: uuid.UUID) -> list[Transaction]:
    """Операции без категории, без активной подсказки и без принятого человеком
    решения; не участвующие в статистике не трогаем. Отклонённая подсказка
    помечается как подтверждённое решение (см. dismiss_suggestion) — поэтому
    такие строки сюда не попадают и не предлагаются повторно."""
    rows = await db.execute(
        select(Transaction).where(
            Transaction.workspace_id == workspace_id,
            Transaction.category_id.is_(None),
            Transaction.suggested_category_id.is_(None),
            counts_in_stats_sql(),
            Transaction.category_confirmed.is_(False),
        )
    )
    return list(rows.scalars().all())


# Потолок выборки кандидатов на разбор. Описания сравниваются уже снаружи
# запроса, поэтому он тянет и заведомо чужие: на истории за годы это тысячи
# строк на каждое подтверждение категории. Потолок разбор не ломает —
# разложенные строки выходят из выборки, и следующее нажатие видит следующие;
# отбираем свежие, они человеку нужнее.
SIMILAR_CANDIDATES_LIMIT = 1000


async def uncategorized_with_description(
    db: AsyncSession,
    workspace_id: uuid.UUID,
    *,
    exclude_id: uuid.UUID,
    amount: Decimal,
) -> list[Transaction]:
    """Кандидаты на разбор по описанию: операции с описанием, которым категорию
    операции-источника проставить можно, кроме неё самой.

    Можно — значит категории нет вовсе и решения человека по ней не было.
    Отклонённая подсказка помечается подтверждённой (см. dismiss_suggestion),
    и по одной пустой категории она неотличима от неразобранной: разбор обязан
    уважать этот отказ так же, как его уважает классификатор.

    Условие участия в статистике — то же, что у пути модели (list_uncategorized):
    на вопрос «какие операции подлежат категоризации» два запроса обязаны
    отвечать одинаково.

    Знак: категория берётся у операции-источника, а её направление уже
    согласовано со знаком её суммы (это стережёт category_matches_amount на всех
    путях записи). Значит кандидату та же категория подходит ровно при
    совпадении знака. Иначе возврат по той же точке получил бы расходную
    категорию, и дальше любая правка этой строки отвечала бы отказом.

    Сравнение описаний остаётся снаружи. Ключ у правил — нормализованное
    описание (регистр, схлопнутые пробелы, NFC), и в SQL эту нормализацию
    не выразить, не заведя её второго определения; два определения одного
    правила рано или поздно разойдутся.
    """
    same_sign = Transaction.amount < 0 if amount < 0 else Transaction.amount > 0
    rows = await db.execute(
        select(Transaction)
        .where(
            Transaction.workspace_id == workspace_id,
            Transaction.category_id.is_(None),
            Transaction.category_confirmed.is_(False),
            counts_in_stats_sql(),
            same_sign,
            Transaction.merchant.is_not(None),
            Transaction.id != exclude_id,
        )
        .order_by(Transaction.occurred_at.desc(), Transaction.id.desc())
        .limit(SIMILAR_CANDIDATES_LIMIT)
    )
    return list(rows.scalars().all())


async def set_category_for(
    db: AsyncSession,
    workspace_id: uuid.UUID,
    transaction_ids: list[uuid.UUID],
    category_id: uuid.UUID,
) -> int:
    """Проставить категорию перечисленным операциям, у которых её нет; вернуть
    число задетых строк. Без commit — им распоряжается сервис.

    Фильтр по workspace здесь не лишний, хотя идентификаторы и пришли из запроса
    с таким же фильтром: запрос обязан стоять на своих ногах, иначе однажды
    чужого идентификатора в списке окажется достаточно. По той же причине
    пустоту категории проверяем повторно, а не верим прочитанному: между
    отбором кандидатов и записью её успевает проставить чужой коммит —
    фоновая категоризация держит транзакцию открытой на весь проход.

    Подсказку гасим вместе с простановкой: категория есть, и вопрос про неё же
    закрыт. Правка человеком гасит её так же — иначе остаётся операция
    с категорией и живой подсказкой, чего в интерфейсе не видно.
    """
    if not transaction_ids:
        return 0
    rows = await db.execute(
        update(Transaction)
        .where(
            Transaction.workspace_id == workspace_id,
            Transaction.id.in_(transaction_ids),
            Transaction.category_id.is_(None),
        )
        .values(category_id=category_id, suggested_category_id=None)
        .returning(Transaction.id)
    )
    return len(rows.all())


async def recent_confirmed_pairs(
    db: AsyncSession, workspace_id: uuid.UUID, kind: str, limit: int
) -> list[tuple[str, str]]:
    """Последние подтверждённые человеком пары merchant→имя категории нужного kind
    — few-shot для промпта (фидбек-луп v1)."""
    rows = await db.execute(
        select(Transaction.merchant, Category.name)
        .join(Category, Category.id == Transaction.category_id)
        .where(
            Transaction.workspace_id == workspace_id,
            Transaction.category_confirmed.is_(True),
            Transaction.merchant.is_not(None),
            Category.kind == kind,
        )
        .order_by(Transaction.created_at.desc())
        .limit(limit)
    )
    return [(m, n) for m, n in rows.all() if m is not None]
