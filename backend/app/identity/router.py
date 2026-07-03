from typing import Annotated

from fastapi import APIRouter, Cookie, Depends, HTTPException, Response
from redis.asyncio import Redis
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_db
from app.core.redis import get_redis
from app.core.settings import get_settings
from app.identity import service, sessions
from app.identity.deps import SESSION_COOKIE, get_current_user
from app.identity.models import User
from app.identity.schemas import LoginIn, MeOut, RegisterIn, UserOut, WorkspaceOut

router = APIRouter(prefix="/api")


def _set_session_cookie(response: Response, token: str) -> None:
    settings = get_settings()
    response.set_cookie(
        SESSION_COOKIE,
        token,
        max_age=settings.session_ttl_days * 24 * 60 * 60,
        httponly=True,
        samesite="lax",
        secure=settings.cookie_secure,
    )


@router.post("/auth/register", status_code=201)
async def register(
    payload: RegisterIn,
    response: Response,
    db: Annotated[AsyncSession, Depends(get_db)],
    redis: Annotated[Redis, Depends(get_redis)],
) -> UserOut:
    try:
        user = await service.register_user(db, payload.email, payload.password)
    except service.EmailTakenError:
        raise HTTPException(status_code=409, detail="Email уже зарегистрирован") from None
    token = await sessions.create_session(redis, user.id)
    _set_session_cookie(response, token)
    return UserOut(id=user.id, email=user.email)


@router.post("/auth/login")
async def login(
    payload: LoginIn,
    response: Response,
    db: Annotated[AsyncSession, Depends(get_db)],
    redis: Annotated[Redis, Depends(get_redis)],
) -> UserOut:
    user = await service.authenticate(db, payload.email, payload.password)
    if user is None:
        raise HTTPException(status_code=401, detail="Неверный email или пароль")
    token = await sessions.create_session(redis, user.id)
    _set_session_cookie(response, token)
    return UserOut(id=user.id, email=user.email)


@router.post("/auth/logout", status_code=204)
async def logout(
    response: Response,
    redis: Annotated[Redis, Depends(get_redis)],
    session: Annotated[str | None, Cookie()] = None,
) -> None:
    if session is not None:
        await sessions.delete_session(redis, session)
    response.delete_cookie(SESSION_COOKIE)


@router.get("/me")
async def me(
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> MeOut:
    pairs = await service.list_workspaces(db, user.id)
    return MeOut(
        id=user.id,
        email=user.email,
        workspaces=[
            WorkspaceOut(id=workspace.id, name=workspace.name, role=role)
            for workspace, role in pairs
        ],
    )
