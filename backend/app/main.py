from fastapi import FastAPI

from app.logging import configure_logging

configure_logging()

app = FastAPI(title="AIccountant")


@app.get("/api/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}
