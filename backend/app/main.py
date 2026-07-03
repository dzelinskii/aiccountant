from fastapi import FastAPI

from app.identity.router import router as identity_router
from app.logging import configure_logging

configure_logging()

app = FastAPI(title="AIccountant")
app.include_router(identity_router)


@app.get("/api/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}
