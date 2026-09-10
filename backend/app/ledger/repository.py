import uuid
from datetime import date
from decimal import Decimal

from sqlalchemy import SQLColumnExpression, func, select, text, update
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


# Пробел в понимании Python: str.split() режет по str.isspace(), и SQL обязан
# резать по тому же набору. Готовый класс [[:space:]] не подходит — его состав
# зависит от локали базы, и неразрывный пробел в него, как правило, не входит,
# а банки им разделяют слова. Совпадение набора с Python закреплено тестом.
WHITESPACE_CODEPOINTS: tuple[int, ...] = (
    0x09,
    0x0A,
    0x0B,
    0x0C,
    0x0D,
    0x1C,
    0x1D,
    0x1E,
    0x1F,
    0x20,
    0x85,
    0xA0,
    0x1680,
    *range(0x2000, 0x200B),
    0x2028,
    0x2029,
    0x202F,
    0x205F,
    0x3000,
)
_WHITESPACE_CLASS = "[" + "".join(rf"\u{code:04x}" for code in WHITESPACE_CODEPOINTS) + "]+"


def normalized_description_sql(column: SQLColumnExpression[str | None]) -> ColumnElement[str]:
    """Ключ правила «описание → категория» выражением SQL.

    Повторяет service.normalize_description шаг в шаг: схлопнуть пробелы,
    обрезать края, привести регистр, привести к NFC. Порядок тот же — NFC после
    регистра, — потому что разложенная буква приводится к одной форме уже после
    того, как её основа сменила регистр.

    Второе определение одного правила — цена за группировку в базе, и держится
    оно на тесте, который сверяет обе реализации на одних и тех же строках.
    """
    collapsed = func.regexp_replace(column, _WHITESPACE_CLASS, " ", "g")
    return func.normalize(func.btrim(func.lower(collapsed), " "), text("NFC"))


async def unknown_transfer_signatures(
    db: AsyncSession, workspace_id: uuid.UUID
) -> list[tuple[str, int, int, int]]:
    """Описания переводов, про которые ещё не решили: ключ, сколько операций,
    сколько отдано, сколько получено. Из этого человек и выбирает, заводя
    контрагента.

    Ключ — то же нормализованное описание, по которому ищется правило: разойдись
    нормализации, и человек завёл бы контрагента на подпись, которая правилу не
    соответствует, а она осталась бы неопознанной навсегда.

    Берём только переводы людям: покупки в контрагенты не заводим, категории для
    них приходят подсказкой банка.

    Фильтр по workspace стоит дважды, и вторая его роль не в том, чтобы не
    отдать чужие операции. В присоединении он стережёт обратное направление:
    без него чужое правило с тем же текстом опознало бы мою подпись, и она молча
    пропала бы из списка.
    """
    signature = normalized_description_sql(Transaction.merchant)
    operations = func.count()
    sent = func.count().filter(Transaction.amount < 0)
    received = func.count().filter(Transaction.amount > 0)
    rows = await db.execute(
        select(signature, operations, sent, received)
        .select_from(Transaction)
        .outerjoin(
            DescriptionRule,
            (DescriptionRule.normalized_text == signature)
            & (DescriptionRule.workspace_id == workspace_id),
        )
        .where(
            Transaction.workspace_id == workspace_id,
            Transaction.operation_kind == "transfer_person",
            Transaction.merchant.is_not(None),
            # описание из одних пробелов даёт пустой ключ, а правило с пустым
            # ключом завести нельзя: предложить такую подпись — предложить тупик
            signature != "",
            DescriptionRule.id.is_(None),
        )
        .group_by(signature)
        # частые подписи наверх, дальше по алфавиту: без порядка список
        # переставлялся бы от запроса к запросу
        .order_by(operations.desc(), signature)
    )
    return [(key, total, out, back) for key, total, out, back in rows.all()]


async def list_counterparties(db: AsyncSession, workspace_id: uuid.UUID) -> list[Counterparty]:
    """Контрагенты workspace по алфавиту. id — тай-брейк: имена ничем
    не ограничены, и одноимённых завести можно, а порядок обязан быть тем же
    от запроса к запросу."""
    rows = await db.execute(
        select(Counterparty)
        .where(Counterparty.workspace_id == workspace_id)
        .order_by(Counterparty.name, Counterparty.id)
    )
    return list(rows.scalars().all())


async def get_counterparty(
    db: AsyncSession, workspace_id: uuid.UUID, counterparty_id: uuid.UUID
) -> Counterparty | None:
    counterparty: Counterparty | None = await db.scalar(
        select(Counterparty).where(
            Counterparty.id == counterparty_id,
            Counterparty.workspace_id == workspace_id,
        )
    )
    return counterparty


def add_counterparty(db: AsyncSession, counterparty: Counterparty) -> None:
    db.add(counterparty)


async def delete_counterparty(db: AsyncSession, counterparty: Counterparty) -> None:
    """Удалить контрагента. Его подписи уносит внешний ключ description_rules
    с ON DELETE CASCADE: правило без обеих целей ограничение в БД не пропустит,
    так что оставить их всё равно было бы нечем."""
    await db.delete(counterparty)


async def signatures_by_counterparty(
    db: AsyncSession, workspace_id: uuid.UUID
) -> dict[uuid.UUID, list[str]]:
    """Подписи каждого контрагента workspace: подпись — это ключ правила,
    ведущего в него.

    Одним запросом на весь workspace, а не по запросу на контрагента: список
    показывает их все сразу, и запрос на строку превратил бы его в N+1.
    """
    rows = await db.execute(
        select(DescriptionRule.counterparty_id, DescriptionRule.normalized_text)
        .where(
            DescriptionRule.workspace_id == workspace_id,
            DescriptionRule.counterparty_id.is_not(None),
        )
        .order_by(DescriptionRule.normalized_text)
    )
    grouped: dict[uuid.UUID, list[str]] = {}
    for counterparty_id, signature in rows.all():
        grouped.setdefault(counterparty_id, []).append(signature)
    return grouped


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
    positive: bool,
    exclude_id: uuid.UUID | None = None,
) -> list[Transaction]:
    """Кандидаты на разбор: операции с описанием, которым чужую категорию
    проставить можно.

    Можно — значит категории нет вовсе и решения человека по ней не было.
    Отклонённая подсказка помечается подтверждённой (см. dismiss_suggestion),
    и по одной пустой категории она неотличима от неразобранной: разбор обязан
    уважать этот отказ так же, как его уважает классификатор.

    Условие участия в статистике — то же, что у пути модели (list_uncategorized):
    на вопрос «какие операции подлежат категоризации» два запроса обязаны
    отвечать одинаково.

    Знак кандидата обязан подойти категории, которую проставим: расходная
    категория на приходе нарушила бы инвариант, который на всех путях записи
    стережёт category_matches_amount, и дальше любая правка такой строки
    отвечала бы отказом. Какой знак подходит, решает вызывающий: у разбора
    похожих — знак операции-источника, её категория со знаком уже согласована;
    у разбора по контрагенту — направление его категории.

    exclude_id — операция-источник, если она есть: вопрос звучит «сколько ещё
    таких», и саму себя считать нельзя. У разбора по контрагенту источника нет.

    Сравнение описаний остаётся снаружи. Ключ у правил — нормализованное
    описание (регистр, схлопнутые пробелы, NFC), и в SQL эту нормализацию
    не выразить, не заведя её второго определения; два определения одного
    правила рано или поздно разойдутся.
    """
    conditions = [
        Transaction.workspace_id == workspace_id,
        Transaction.category_id.is_(None),
        Transaction.category_confirmed.is_(False),
        counts_in_stats_sql(),
        Transaction.amount > 0 if positive else Transaction.amount < 0,
        Transaction.merchant.is_not(None),
    ]
    if exclude_id is not None:
        conditions.append(Transaction.id != exclude_id)
    rows = await db.execute(
        select(Transaction)
        .where(*conditions)
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
