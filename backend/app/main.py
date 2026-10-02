from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.core.csrf import OriginCheckMiddleware
from app.core.db import engine
from app.core.log_context import LogContextMiddleware
from app.core.redis import redis_client
from app.core.settings import get_settings
from app.identity.router import router as identity_router
from app.imports.router import router as imports_router
from app.ledger.router import router as ledger_router
from app.logging import configure_logging
from app.recurring.router import router as recurring_router

configure_logging()


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    yield
    await engine.dispose()
    await redis_client.aclose()


app = FastAPI(title="AIccountant", lifespan=lifespan)
app.add_middleware(OriginCheckMiddleware)
app.add_middleware(LogContextMiddleware)
# Порядок слоёв сейчас ни на что не влияет: проверка origin не трогает OPTIONS
# и пропускает origin'ы из списка. CORS добавлен последним, то есть стоит снаружи:
# для origin'ов из списка его заголовки ложатся и на ответы внутренних слоёв.
# allow_credentials=False намеренно: приложению незачем читать ответ на запрос
# с cookie — сессию оно предъявляет заголовком
app.add_middleware(
    CORSMiddleware,
    allow_origins=get_settings().allowed_origins,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
    allow_headers=["Authorization", "Content-Type"],
    allow_credentials=False,
)
app.include_router(identity_router)
app.include_router(ledger_router)
app.include_router(recurring_router)
app.include_router(imports_router)


@app.get("/api/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}
