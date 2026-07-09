from decimal import Decimal
from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgresql+asyncpg://aiccountant:change-me@localhost:5432/aiccountant"
    redis_url: str = "redis://localhost:6379/0"
    session_ttl_days: int = 30
    cookie_secure: bool = False
    allowed_origins: list[str] = ["http://localhost:5173"]

    # LLM-слой: OpenAI-совместимый эндпоинт (облако по умолчанию; Ollama — иной base_url)
    llm_base_url: str = "https://api.openai.com/v1"
    llm_api_key: str = ""
    llm_model_categorize: str = "gpt-4o-mini"
    # порог уверенности: выше — авто-простановка, ниже — подсказка на подтверждение
    categorize_confidence_threshold: Decimal = Decimal("0.8")
    # сколько подтверждённых примеров merchant→категория подмешивать в промпт (few-shot)
    categorize_fewshot_limit: int = 10


@lru_cache
def get_settings() -> Settings:
    return Settings()
