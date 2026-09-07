import unicodedata
import uuid
from datetime import date, datetime
from decimal import Decimal
from typing import NamedTuple

from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.category_hints import HINT_DEFAULTS
from app.core.operation_kinds import OperationKind, kind_from_amount
from app.ledger import repository
from app.ledger.balance import adjustment_for, visible_balance
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


class ReportedBalanceError(Exception):
    """У счёта есть остаток от источника — править его руками нельзя."""


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
    if payload.balance is not None:
        if account.reported_balance is not None:
            # следующий сбор всё равно перезапишет правку: принять её значит
            # пообещать то, чего мы не сделаем
            raise ReportedBalanceError
        operations_sum = await repository.account_operations_sum(db, workspace_id, account_id)
        account.balance_adjustment = adjustment_for(payload.balance, operations_sum)
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


async def learn_rule_from(
    db: AsyncSession, workspace_id: uuid.UUID, transaction: Transaction
) -> None:
    """Запомнить решение человека: это описание даёт эту категорию.

    Правило, заведённое руками, не трогаем: тот, кто завёл его сам, знал, что
    делает, и не ждёт, что оно поменяется от правки одной операции. Выученное
    обновляем свободно — последнее подтверждение и есть текущее намерение.

    Пустой ключ пропускаем: он ловил бы любую операцию с пробельным описанием.

    Своим commit'ом и после того, как правка операции уже сохранена: правило —
    побочная польза от подтверждения, и провалить из-за него саму правку нельзя.
    """
    category_id = transaction.category_id
    if category_id is None or not transaction.merchant:
        return
    normalized = normalize_description(transaction.merchant)
    if not normalized or len(normalized) > RULE_TEXT_MAX_LENGTH:
        return

    existing = await repository.find_description_rule(db, workspace_id, normalized)
    if existing is not None:
        if existing.source == "manual":
            return
        existing.category_id = category_id
    else:
        repository.add_description_rule(
            db,
            DescriptionRule(
                workspace_id=workspace_id,
                normalized_text=normalized,
                category_id=category_id,
                source="learned",
            ),
        )

    try:
        await db.commit()
    except IntegrityError:
        # обе ветки прикрыты одинаково: то же описание подтвердили одновременно
        # в другом запросе (проверка выше этого не видит — обе сессии видят
        # пустоту, видит уникальный индекс), или категория правила исчезла между
        # чтением и записью. Правило — побочная польза, ронять из-за неё
        # сохранённую правку операции нельзя
        await db.rollback()
        # откат помечает всё прочитанное сессией устаревшим, а операцию ещё
        # отдавать наружу: перечитываем явно, иначе догрузка полей полезет
        # из синхронного кода сериализации
        await db.refresh(transaction)


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


async def find_category_by_name(
    db: AsyncSession, workspace_id: uuid.UUID, name: str
) -> Category | None:
    """Категория верхнего уровня по имени — родитель для подсказки."""
    return await repository.category_by_name(db, workspace_id, name, None)


async def resolve_hint_category(
    db: AsyncSession, workspace_id: uuid.UUID, hint: str, amount: Decimal
) -> uuid.UUID | None:
    """Категория, в которую садится подсказка банка; None — подсказка не сработала.

    Заводит подкатегорию при первой же операции с такой подсказкой: дерево
    пополняется только тем, на что человек действительно тратит.

    Не срабатывает молча в трёх случаях, и все три — не ошибка:
    подсказки нет в словаре (разошлись версии коннектора и приложения),
    знак суммы не совпал с направлением категории, родителя удалили.
    """
    target = HINT_DEFAULTS.get(hint)
    if target is None or not category_matches_amount(target.kind, amount):
        return None

    existing = await repository.category_by_hint(db, workspace_id, hint)
    if existing is not None:
        return existing.id

    parent = await repository.category_by_name(db, workspace_id, target.parent, None)
    if parent is None:
        # человек удалил родителя — воскрешать его подсказкой не наше дело
        return None
    if target.sub is None:
        # подсказка садится в самого родителя: помечаем его и не плодим уровень
        parent.hint = hint
        await db.flush()
        return parent.id

    # имя могло быть занято своей категорией человека — тогда берём её и
    # помечаем, а не заводим вторую с тем же именем под тем же родителем
    child = await repository.category_by_name(db, workspace_id, target.sub, parent.id)
    if child is None:
        child = Category(
            workspace_id=workspace_id,
            parent_id=parent.id,
            name=target.sub,
            kind=target.kind,
        )
        repository.add_category(db, child)
    child.hint = hint
    await db.flush()
    return child.id


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
    if payload.category_id is not None:
        # тот же признак, что и у category_confirmed выше: человек явно выбрал
        # категорию — значит, есть чему учиться. После commit'а: правка операции
        # уже сохранена и от судьбы правила не зависит
        await learn_rule_from(db, workspace_id, transaction)
    return transaction


async def _similar_uncategorized(
    db: AsyncSession, workspace_id: uuid.UUID, transaction: Transaction
) -> list[Transaction]:
    """Операции, описанные так же, как заданная, и пригодные под её категорию.

    Пригодность целиком решает запрос (uncategorized_with_description): пустая
    категория, отсутствие решения человека, участие в статистике и подходящий
    знак суммы. Здесь остаётся только сравнение описаний.

    «Так же» — по тому же ключу, что и у правил: «КОФЕЙНЯ  У ДОМА» и «Кофейня
    у дома» для человека одно и то же место, и разбираться они обязаны вместе.
    Пустой ключ не ищем — он собрал бы в одну кучу все операции с пробельным
    описанием.
    """
    if not transaction.merchant:
        return []
    key = normalize_description(transaction.merchant)
    if not key:
        return []
    candidates = await repository.uncategorized_with_description(
        db, workspace_id, exclude_id=transaction.id, amount=transaction.amount
    )
    return [t for t in candidates if t.merchant and normalize_description(t.merchant) == key]


async def count_similar_uncategorized(
    db: AsyncSession, workspace_id: uuid.UUID, transaction_id: uuid.UUID
) -> int:
    """Сколько ещё операций без категории описаны так же — это интерфейс
    спрашивает после подтверждения, прежде чем предложить разбор."""
    transaction = await repository.get_transaction(db, workspace_id, transaction_id)
    if transaction is None:
        raise NotFoundError
    return len(await _similar_uncategorized(db, workspace_id, transaction))


async def apply_category_to_similar(
    db: AsyncSession, workspace_id: uuid.UUID, transaction_id: uuid.UUID
) -> int:
    """Распространить категорию операции на такие же операции без категории.

    Трогаем только пустые, и то не всякую пустоту: отклонённая подсказка — тоже
    решение человека, и оно остаётся. Ни выбор человека, ни то, что проставила
    машина, не переписываем — именно это делает согласие на разбор безопасным,
    худшее последствие которого — заполнится пустота.

    category_confirmed при этом не ставим. Человек подтвердил одну операцию,
    а остальные глазами не видел; пометив их подтверждёнными, мы отправили бы
    их в примеры для модели наравне с проверенными и размножили бы ошибку.
    """
    transaction = await repository.get_transaction(db, workspace_id, transaction_id)
    if transaction is None:
        raise NotFoundError
    category_id = transaction.category_id
    if category_id is None:
        return 0
    similar = await _similar_uncategorized(db, workspace_id, transaction)
    applied = await repository.set_category_for(
        db, workspace_id, [t.id for t in similar], category_id
    )
    await db.commit()
    return applied


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
            DashboardAccount(
                id=a.id,
                name=a.name,
                type=a.type,
                currency=a.currency,
                balance=bal,
                reported_at=a.reported_at,
                card_masks=a.card_masks,
            )
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
