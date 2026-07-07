import uuid
from typing import Annotated

from fastapi import Cookie, Depends, HTTPException
from redis.asyncio import Redis
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_db
from app.core.redis import get_redis
from app.identity.models import Membership, User
from app.identity.sessions import get_session_user_id

SESSION_COOKIE = "session"


async def get_current_user(
    db: Annotated[AsyncSession, Depends(get_db)],
    redis: Annotated[Redis, Depends(get_redis)],
    session: Annotated[str | None, Cookie()] = None,
) -> User:
    if session is None:
        raise HTTPException(status_code=401, detail="Не авторизован")
    user_id = await get_session_user_id(redis, session)
    if user_id is None:
        raise HTTPException(status_code=401, detail="Сессия истекла")
    user = await db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=401, detail="Пользователь не найден")
    return user


async def require_owner(
    workspace_id: uuid.UUID,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> User:
    membership = await db.get(Membership, (user.id, workspace_id))
    if membership is None or membership.role != "owner":
        raise HTTPException(status_code=403, detail="Требуется роль владельца")
    return user


async def require_workspace_member(
    workspace_id: uuid.UUID,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> User:
    membership = await db.get(Membership, (user.id, workspace_id))
    if membership is None:
        raise HTTPException(status_code=403, detail="Нет доступа к workspace")
    return user
