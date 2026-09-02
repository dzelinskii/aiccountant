import uuid
from typing import Annotated

import structlog
from fastapi import Cookie, Depends, Header, HTTPException, Request
from redis.asyncio import Redis
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_db
from app.core.redis import get_redis
from app.identity import service
from app.identity.models import Membership, User
from app.identity.sessions import get_session_user_id

SESSION_COOKIE = "session"


def token_scope(request: Request) -> uuid.UUID | None:
    """Workspace, для которого выдан токен текущего запроса; None — сессия из
    браузера. Публичная: нужна не только зависимостям здесь (запрет действий),
    но и роутеру — сузить выдачу /api/me до своего workspace."""
    return getattr(request.state, "token_workspace_id", None)


async def get_current_user(
    request: Request,
    db: Annotated[AsyncSession, Depends(get_db)],
    redis: Annotated[Redis, Depends(get_redis)],
    session: Annotated[str | None, Cookie()] = None,
    authorization: Annotated[str | None, Header()] = None,
) -> User:
    # программный доступ (коллектор, боты) — по токену; браузер — по куке сессии.
    # если заголовок Authorization вообще присутствует, на куку не откатываемся —
    # иначе исполнитель запроса зависит от форматирования заголовка, а не от
    # факта авторизации
    if authorization is not None:
        scheme, _, raw = authorization.partition(" ")
        if scheme.lower() != "bearer" or not raw.strip():
            raise HTTPException(status_code=401, detail="Неверный токен")
        result = await service.user_by_api_token(db, raw.strip())
        if result is None:
            raise HTTPException(status_code=401, detail="Неверный токен")
        user, token_workspace_id = result
        # область действия токена запоминаем в request.state — её проверит
        # require_workspace_member, а require_session_user запретит по ней
        # действия, которые машинному токену доверять нельзя
        request.state.token_workspace_id = token_workspace_id
        return user
    if session is None:
        raise HTTPException(status_code=401, detail="Не авторизован")
    user_id = await get_session_user_id(redis, session)
    if user_id is None:
        raise HTTPException(status_code=401, detail="Сессия истекла")
    session_user = await db.get(User, user_id)
    if session_user is None:
        raise HTTPException(status_code=401, detail="Пользователь не найден")
    return session_user


async def require_session_user(
    request: Request, user: Annotated[User, Depends(get_current_user)]
) -> User:
    """Действия, расширяющие доступ, машинному токену запрещены: иначе утёкший
    токен превращается в постоянный доступ, который отзывом уже не убрать."""
    if token_scope(request) is not None:
        raise HTTPException(status_code=403, detail="Действие доступно только из браузера")
    return user


async def require_owner(
    workspace_id: uuid.UUID,
    user: Annotated[User, Depends(require_session_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> User:
    membership = await db.get(Membership, (user.id, workspace_id))
    if membership is None or membership.role != "owner":
        raise HTTPException(status_code=403, detail="Требуется роль владельца")
    return user


async def require_workspace_member(
    request: Request,
    workspace_id: uuid.UUID,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> User:
    # токен привязан к одному workspace — владелец нескольких workspace не
    # должен получать доступ ко всем через один утёкший токен
    scope = token_scope(request)
    if scope is not None and scope != workspace_id:
        raise HTTPException(status_code=403, detail="Токен выдан для другого workspace")
    membership = await db.get(Membership, (user.id, workspace_id))
    if membership is None:
        raise HTTPException(status_code=403, detail="Нет доступа к workspace")
    structlog.contextvars.bind_contextvars(workspace_id=str(workspace_id), user_id=str(user.id))
    return user
