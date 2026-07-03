from httpx import AsyncClient

PAYLOAD = {"email": "csrf@example.com", "password": "password123"}


async def test_unsafe_request_with_foreign_origin_rejected(client: AsyncClient) -> None:
    response = await client.post(
        "/api/auth/register", json=PAYLOAD, headers={"Origin": "https://evil.example"}
    )
    assert response.status_code == 403


async def test_same_origin_allowed(client: AsyncClient) -> None:
    response = await client.post(
        "/api/auth/register", json=PAYLOAD, headers={"Origin": "http://test"}
    )
    assert response.status_code == 201


async def test_get_with_foreign_origin_allowed(client: AsyncClient) -> None:
    response = await client.get("/api/health", headers={"Origin": "https://evil.example"})
    assert response.status_code == 200
