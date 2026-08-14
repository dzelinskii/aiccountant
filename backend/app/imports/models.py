import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base


class Import(Base):
    __tablename__ = "imports"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    workspace_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("workspaces.id"))
    account_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("accounts.id"))
    file_name: Mapped[str] = mapped_column(String(300))
    bank_profile: Mapped[str] = mapped_column(String(30))
    status: Mapped[str] = mapped_column(String(20))
    stats: Mapped[dict[str, int]] = mapped_column(JSONB)
    # какой парсер разобрал выписку (профиль банка или "llm"); пусто, пока идёт разбор
    parser: Mapped[str | None] = mapped_column(String(30), nullable=True)
    # результат разбора: операции и итоги строками (деньги в JSON — строки, не float)
    parsed_payload: Mapped[dict[str, object] | None] = mapped_column(JSONB, nullable=True)
    # текст ошибки для статуса failed — показываем пользователю, не глотаем
    error: Mapped[str | None] = mapped_column(String(500), nullable=True)
    # текст выписки нужен фоновой задаче; PII — очищаем сразу после разбора
    raw_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
