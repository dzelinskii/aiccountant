import uuid

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import hash_password, verify_password
from app.identity.models import Membership, User, Workspace

DEFAULT_WORKSPACE_NAME = "Домохозяйство"


class EmailTakenError(Exception):
    pass


class AlreadyMemberError(Exception):
    pass


async def register_user(db: AsyncSession, email: str, password: str) -> User:
    # email нормализуется к нижнему регистру: Alice@x.com и alice@x.com — один адрес
    email = email.lower()
    existing = await db.scalar(select(User).where(User.email == email))
    if existing is not None:
        raise EmailTakenError
    user = User(email=email, password_hash=hash_password(password))
    workspace = Workspace(name=DEFAULT_WORKSPACE_NAME, type="personal")
    db.add_all([user, workspace])
    await db.flush()
    db.add(Membership(user_id=user.id, workspace_id=workspace.id, role="owner"))
    # проверка выше отсекает обычный дубль; commit ловит гонку двух
    # параллельных регистраций — уникальный индекс на email даёт IntegrityError
    try:
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        raise EmailTakenError from exc
    return user


# verify выполняется и когда пользователь не найден — иначе разница во времени
# ответа выдаёт существование email (user enumeration)
_DUMMY_HASH = hash_password("dummy-password-for-timing")


async def authenticate(db: AsyncSession, email: str, password: str) -> User | None:
    user = await db.scalar(select(User).where(User.email == email.lower()))
    password_hash = user.password_hash if user is not None else _DUMMY_HASH
    if not verify_password(password_hash, password) or user is None:
        return None
    return user


async def list_workspaces(db: AsyncSession, user_id: uuid.UUID) -> list[tuple[Workspace, str]]:
    rows = await db.execute(
        select(Workspace, Membership.role)
        .join(Membership, Membership.workspace_id == Workspace.id)
        .where(Membership.user_id == user_id)
    )
    return [(workspace, role) for workspace, role in rows.all()]


async def invite_member(db: AsyncSession, workspace_id: uuid.UUID, email: str) -> Membership:
    user = await db.scalar(select(User).where(User.email == email.lower()))
    if user is None:
        raise LookupError(email)
    existing = await db.get(Membership, (user.id, workspace_id))
    if existing is not None:
        raise AlreadyMemberError
    membership = Membership(user_id=user.id, workspace_id=workspace_id, role="member")
    db.add(membership)
    # как в register_user: commit ловит гонку двух owner'ов, зовущих одного —
    # составной PK memberships даёт IntegrityError
    try:
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        raise AlreadyMemberError from exc
    return membership
