import uuid
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import hash_password, verify_password
from app.identity.models import ApiToken, Membership, User, Workspace
from app.identity.tokens import generate_token, hash_token

DEFAULT_WORKSPACE_NAME = "Домохозяйство"


class EmailTakenError(Exception):
    pass


class AlreadyMemberError(Exception):
    pass


async def register_user(db: AsyncSession, email: str, password: str) -> tuple[User, Workspace]:
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
    return user, workspace


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


async def user_by_api_token(db: AsyncSession, token: str) -> User | None:
    """Найти владельца действующего токена. Ищем по хешу — одним запросом по индексу."""
    api_token = await db.scalar(
        select(ApiToken).where(
            ApiToken.token_hash == hash_token(token), ApiToken.revoked_at.is_(None)
        )
    )
    if api_token is None:
        return None
    api_token.last_used_at = datetime.now(UTC)
    await db.commit()
    return await db.get(User, api_token.created_by)


async def create_api_token(
    db: AsyncSession, workspace_id: uuid.UUID, user_id: uuid.UUID, name: str
) -> tuple[ApiToken, str]:
    """Вернуть запись и сам токен — показать его можно только сейчас."""
    token = generate_token()
    api_token = ApiToken(
        workspace_id=workspace_id, created_by=user_id, name=name, token_hash=hash_token(token)
    )
    db.add(api_token)
    await db.commit()
    return api_token, token


async def list_api_tokens(db: AsyncSession, workspace_id: uuid.UUID) -> list[ApiToken]:
    rows = await db.execute(
        select(ApiToken)
        .where(ApiToken.workspace_id == workspace_id, ApiToken.revoked_at.is_(None))
        .order_by(ApiToken.created_at.desc())
    )
    return list(rows.scalars().all())


async def revoke_api_token(db: AsyncSession, workspace_id: uuid.UUID, token_id: uuid.UUID) -> bool:
    api_token = await db.scalar(
        select(ApiToken).where(ApiToken.id == token_id, ApiToken.workspace_id == workspace_id)
    )
    if api_token is None:
        return False
    api_token.revoked_at = datetime.now(UTC)
    await db.commit()
    return True
