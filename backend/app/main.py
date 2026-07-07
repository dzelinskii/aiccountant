from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.core.csrf import OriginCheckMiddleware
from app.core.db import engine
from app.core.log_context import LogContextMiddleware
from app.core.redis import redis_client
from app.identity.router import router as identity_router
from app.logging import configure_logging

configure_logging()


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    yield
    await engine.dispose()
    await redis_client.aclose()


app = FastAPI(title="AIccountant", lifespan=lifespan)
app.add_middleware(OriginCheckMiddleware)
app.add_middleware(LogContextMiddleware)
app.include_router(identity_router)


@app.get("/api/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}
