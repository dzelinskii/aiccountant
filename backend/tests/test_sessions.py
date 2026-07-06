import uuid

from redis.asyncio import Redis

from app.identity.sessions import create_session, delete_session, get_session_user_id


async def test_session_roundtrip(redis_client: Redis) -> None:
    user_id = uuid.uuid4()
    token = await create_session(redis_client, user_id)
    assert await get_session_user_id(redis_client, token) == user_id
    await delete_session(redis_client, token)
    assert await get_session_user_id(redis_client, token) is None


async def test_unknown_token_returns_none(redis_client: Redis) -> None:
    assert await get_session_user_id(redis_client, "no-such-token") is None
