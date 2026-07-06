from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgresql+asyncpg://aiccountant:change-me@localhost:5432/aiccountant"
    redis_url: str = "redis://localhost:6379/0"
    session_ttl_days: int = 30
    cookie_secure: bool = False
    allowed_origins: list[str] = ["http://localhost:5173"]


@lru_cache
def get_settings() -> Settings:
    return Settings()
