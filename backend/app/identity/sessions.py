import hashlib
import secrets
import uuid

from redis.asyncio import Redis

from app.core.settings import get_settings

_PREFIX = "session:"


def _key(token: str) -> str:
    # в Redis хранится sha256 токена: дамп или бэкап Redis не выдаёт живые токены
    return _PREFIX + hashlib.sha256(token.encode()).hexdigest()


def _ttl_seconds() -> int:
    return get_settings().session_ttl_days * 24 * 60 * 60


async def create_session(redis: Redis, user_id: uuid.UUID) -> str:
    token = secrets.token_urlsafe(32)
    await redis.set(_key(token), str(user_id), ex=_ttl_seconds())
    return token


async def get_session_user_id(redis: Redis, token: str) -> uuid.UUID | None:
    value = await redis.get(_key(token))
    # str(): redis-py типизирует get() как bytes | str даже при decode_responses=True
    return uuid.UUID(str(value)) if value else None


async def delete_session(redis: Redis, token: str) -> None:
    await redis.delete(_key(token))
