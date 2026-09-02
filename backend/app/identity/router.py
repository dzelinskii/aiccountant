import uuid
from typing import Annotated

from fastapi import APIRouter, Cookie, Depends, HTTPException, Request, Response
from redis.asyncio import Redis
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_db
from app.core.redis import get_redis
from app.core.settings import get_settings
from app.identity import service, sessions
from app.identity.deps import (
    SESSION_COOKIE,
    get_current_user,
    require_owner,
    require_session_user,
    require_workspace_member,
    token_scope,
)
from app.identity.models import User
from app.identity.schemas import (
    ApiTokenCreate,
    ApiTokenCreated,
    ApiTokenOut,
    LoginIn,
    MemberIn,
    MeOut,
    RegisterIn,
    UserOut,
    WorkspaceOut,
)
from app.ledger import service as ledger_service

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
        user, workspace = await service.register_user(db, payload.email, payload.password)
    except service.EmailTakenError:
        raise HTTPException(status_code=409, detail="Email уже зарегистрирован") from None
    token = await sessions.create_session(redis, user.id)
    _set_session_cookie(response, token)
    await ledger_service.seed_categories(db, workspace.id)
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
    request: Request,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> MeOut:
    pairs = await service.list_workspaces(db, user.id)
    scope = token_scope(request)
    if scope is not None:
        # токен ограничен своим workspace — не раскрываем остальные workspace
        # владельца (иначе это перечисление чужих домохозяйств через токен)
        pairs = [(workspace, role) for workspace, role in pairs if workspace.id == scope]
    return MeOut(
        id=user.id,
        email=user.email,
        workspaces=[
            WorkspaceOut(id=workspace.id, name=workspace.name, role=role)
            for workspace, role in pairs
        ],
    )


@router.post("/workspaces/{workspace_id}/members", status_code=201)
async def add_member(
    workspace_id: uuid.UUID,
    payload: MemberIn,
    _owner: Annotated[User, Depends(require_owner)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> dict[str, str]:
    try:
        membership = await service.invite_member(db, workspace_id, payload.email)
    except LookupError:
        raise HTTPException(
            status_code=404, detail="Пользователь с таким email не найден"
        ) from None
    except service.AlreadyMemberError:
        raise HTTPException(status_code=409, detail="Уже участник") from None
    return {"user_id": str(membership.user_id), "role": membership.role}


@router.post("/tokens", status_code=201)
async def create_token(
    payload: ApiTokenCreate,
    workspace_id: uuid.UUID,
    user: Annotated[User, Depends(require_workspace_member)],
    _session: Annotated[User, Depends(require_session_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> ApiTokenCreated:
    api_token, token = await service.create_api_token(db, workspace_id, user.id, payload.name)
    return ApiTokenCreated(
        id=api_token.id,
        name=api_token.name,
        created_at=api_token.created_at,
        last_used_at=api_token.last_used_at,
        token=token,
    )


@router.get("/tokens")
async def list_tokens(
    workspace_id: uuid.UUID,
    _user: Annotated[User, Depends(require_workspace_member)],
    _session: Annotated[User, Depends(require_session_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> list[ApiTokenOut]:
    rows = await service.list_api_tokens(db, workspace_id)
    return [ApiTokenOut.model_validate(t, from_attributes=True) for t in rows]


@router.delete("/tokens/{token_id}", status_code=204)
async def revoke_token(
    token_id: uuid.UUID,
    workspace_id: uuid.UUID,
    _user: Annotated[User, Depends(require_workspace_member)],
    _session: Annotated[User, Depends(require_session_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> None:
    if not await service.revoke_api_token(db, workspace_id, token_id):
        raise HTTPException(status_code=404, detail="Токен не найден")
