import hashlib
import secrets

TOKEN_BYTES = 32


def generate_token() -> str:
    """Токен для программного доступа: 32 байта из криптостойкого генератора."""
    return secrets.token_urlsafe(TOKEN_BYTES)


def hash_token(token: str) -> str:
    """sha256, а не argon2: токен высокоэнтропийный, подбор невозможен, зато по
    детерминированному хешу можно искать в индексе за один запрос."""
    return hashlib.sha256(token.encode("utf-8")).hexdigest()
