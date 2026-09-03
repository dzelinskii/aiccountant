import uuid
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import (
    Date,
    DateTime,
    ForeignKey,
    Index,
    Numeric,
    String,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base


class Account(Base):
    __tablename__ = "accounts"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    workspace_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("workspaces.id"))
    name: Mapped[str] = mapped_column(String(200))
    type: Mapped[str] = mapped_column(String(20))
    currency: Mapped[str] = mapped_column(String(3), default="RUB")
    is_archived: Mapped[bool] = mapped_column(default=False)
    # остаток, сообщённый источником (коллектором банка), и момент, на который
    # он верен. Пусто — источника у счёта нет, счёт ведётся руками
    reported_balance: Mapped[Decimal | None] = mapped_column(Numeric(20, 4), nullable=True)
    reported_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # поправка к сумме операций для счетов без источника: человек задаёт текущий
    # остаток, разницу храним здесь. В интерфейс это понятие не выносится
    balance_adjustment: Mapped[Decimal] = mapped_column(
        Numeric(20, 4), default=Decimal(0), server_default=text("0")
    )
    # последние четыре цифры карт счёта; пусто у счетов без карт
    card_masks: Mapped[list[str]] = mapped_column(JSONB, default=list, server_default=text("'[]'"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Category(Base):
    __tablename__ = "categories"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    workspace_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("workspaces.id"))
    parent_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("categories.id"), nullable=True)
    name: Mapped[str] = mapped_column(String(200))
    kind: Mapped[str] = mapped_column(String(20))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Transaction(Base):
    __tablename__ = "transactions"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    workspace_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("workspaces.id"))
    account_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("accounts.id"))
    category_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("categories.id"), nullable=True
    )
    # знаковая: < 0 отток, > 0 приток; NUMERIC(20,4) — деньги, не float
    amount: Mapped[Decimal] = mapped_column(Numeric(20, 4))
    currency: Mapped[str] = mapped_column(String(3))
    occurred_at: Mapped[date] = mapped_column(Date)
    merchant: Mapped[str | None] = mapped_column(String(300), nullable=True)
    note: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    source: Mapped[str] = mapped_column(String(20), default="manual")
    # общий id для двух строк перевода; null у обычных операций
    transfer_group_id: Mapped[uuid.UUID | None] = mapped_column(nullable=True)
    # вид операции в нашем словаре (app/core/operation_kinds.py) — факт от
    # источника, не меняется человеком
    operation_kind: Mapped[str] = mapped_column(
        String(20), default="unknown", server_default=text("'unknown'")
    )
    # решение человека «считать тратой»; null — решает правило по виду операции.
    # Держим отдельно от вида, чтобы смена правил не затирала ручные правки
    spending_override: Mapped[bool | None] = mapped_column(nullable=True)
    # дедуп импорта: хеш операции; мягкая ссылка на запись imports (без FK,
    # чтобы ledger не зависел от модуля imports)
    external_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    import_id: Mapped[uuid.UUID | None] = mapped_column(nullable=True)
    # AI-категоризация: подтвердил ли человек текущую категорию (авто-простановка = false)
    category_confirmed: Mapped[bool] = mapped_column(default=False, server_default=text("false"))
    # уверенность последнего прогона классификатора (0..1); NUMERIC, не float
    category_confidence: Mapped[Decimal | None] = mapped_column(Numeric(4, 3), nullable=True)
    # предложение классификатора ниже порога (категория ещё не применена)
    suggested_category_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("categories.id"), nullable=True
    )
    created_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        Index("ix_transactions_workspace_occurred", "workspace_id", "occurred_at"),
        Index("ix_transactions_account_occurred", "account_id", "occurred_at"),
        Index(
            "uq_transactions_account_external",
            "account_id",
            "external_id",
            unique=True,
            postgresql_where=text("external_id IS NOT NULL"),
        ),
    )


class DescriptionRule(Base):
    """Правило «описание операции → категория».

    Одна таблица и для белого списка контрагентов (задаёт человек), и для будущих
    правил, выученных из подтверждений: по сути это одно и то же — точное
    совпадение описания даёт категорию, — а различает их происхождение колонка
    source. Две таблицы означали бы два одинаковых поиска по одному ключу.
    """

    __tablename__ = "description_rules"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    workspace_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("workspaces.id"))
    # ключ поиска: описание, пропущенное через normalize_description
    normalized_text: Mapped[str] = mapped_column(String(300))
    # правило без категории бессмысленно: удалили категорию — удалилось правило
    category_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("categories.id", ondelete="CASCADE"))
    # manual — задал человек, learned — выучено из подтверждений категорий
    source: Mapped[str] = mapped_column(String(20), default="manual")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        # одно описание — одна категория: иначе поиск по ключу отвечал бы
        # по-разному в зависимости от порядка строк
        UniqueConstraint("workspace_id", "normalized_text", name="uq_description_rules_text"),
    )
