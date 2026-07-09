import uuid
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import Date, DateTime, ForeignKey, Index, Numeric, String, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base


class RecurringRule(Base):
    __tablename__ = "recurring_rules"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    workspace_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("workspaces.id"))
    account_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("accounts.id"))
    category_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("categories.id"))
    # знаковая: знак сверяется с kind категории (как у транзакций)
    amount: Mapped[Decimal] = mapped_column(Numeric(20, 4))
    currency: Mapped[str] = mapped_column(String(3))
    period: Mapped[str] = mapped_column(String(10))  # day/week/month/year
    interval: Mapped[int] = mapped_column()
    anchor_day: Mapped[int | None] = mapped_column(nullable=True)
    start_date: Mapped[date] = mapped_column(Date)
    next_run_at: Mapped[date] = mapped_column(Date)
    mode: Mapped[str] = mapped_column(String(10))  # autopost/remind
    is_active: Mapped[bool] = mapped_column(default=True)
    end_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    note: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    created_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (Index("ix_recurring_rules_active_next", "is_active", "next_run_at"),)


class RecurringOccurrence(Base):
    __tablename__ = "recurring_occurrences"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    workspace_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("workspaces.id"))
    rule_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("recurring_rules.id", ondelete="CASCADE"))
    due_date: Mapped[date] = mapped_column(Date)
    amount: Mapped[Decimal] = mapped_column(Numeric(20, 4))
    status: Mapped[str] = mapped_column(String(10))  # posted/pending/confirmed/skipped
    transaction_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("transactions.id"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        UniqueConstraint("rule_id", "due_date", name="uq_recurring_occurrences_rule_due"),
        Index("ix_recurring_occurrences_workspace_status", "workspace_id", "status"),
    )
