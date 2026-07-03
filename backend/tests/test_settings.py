import pytest

from app.core.settings import Settings


def test_defaults() -> None:
    settings = Settings(_env_file=None)
    assert settings.session_ttl_days == 30
    assert settings.cookie_secure is False
    assert "asyncpg" in settings.database_url


def test_env_override(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DATABASE_URL", "postgresql+asyncpg://u:p@example:5432/db")
    settings = Settings(_env_file=None)
    assert settings.database_url == "postgresql+asyncpg://u:p@example:5432/db"
