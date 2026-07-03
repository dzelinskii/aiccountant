import secrets
import uuid

from redis.asyncio import Redis

from app.core.settings import get_settings

_PREFIX = "session:"


def _ttl_seconds() -> int:
    return get_settings().session_ttl_days * 24 * 60 * 60


async def create_session(redis: Redis, user_id: uuid.UUID) -> str:
    token = secrets.token_urlsafe(32)
    await redis.set(_PREFIX + token, str(user_id), ex=_ttl_seconds())
    return token


async def get_session_user_id(redis: Redis, token: str) -> uuid.UUID | None:
    # redis-py типизирует get() как bytes | str | None вне зависимости от
    # decode_responses; клиент настроен с decode_responses=True, поэтому
    # значение фактически всегда str — str() здесь только сужает тип для mypy.
    value = await redis.get(_PREFIX + token)
    return uuid.UUID(str(value)) if value else None


async def delete_session(redis: Redis, token: str) -> None:
    await redis.delete(_PREFIX + token)
