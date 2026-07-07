import pytest
import structlog
from httpx import AsyncClient


@pytest.mark.skip(reason="ждёт эндпоинт accounts (Задача 6)")
async def test_workspace_id_bound_in_request_context(client: AsyncClient) -> None:
    await client.post(
        "/api/auth/register", json={"email": "ctx@example.com", "password": "password123"}
    )
    me = await client.get("/api/me")
    workspace_id = me.json()["workspaces"][0]["id"]

    await client.get("/api/accounts", params={"workspace_id": workspace_id})
    bound = structlog.contextvars.get_contextvars()
    assert bound.get("workspace_id") == workspace_id
