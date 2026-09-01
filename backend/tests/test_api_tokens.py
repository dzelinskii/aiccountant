from app.identity.tokens import generate_token, hash_token


def test_generate_token_is_long_and_unique() -> None:
    a, b = generate_token(), generate_token()
    assert a != b
    # 32 байта в base64url — подбор невозможен, поэтому хеш может быть быстрым
    assert len(a) >= 43


def test_hash_token_is_deterministic_and_not_the_token() -> None:
    token = generate_token()
    assert hash_token(token) == hash_token(token)
    assert hash_token(token) != token
    assert len(hash_token(token)) == 64  # sha256 hex


def test_different_tokens_hash_differently() -> None:
    assert hash_token(generate_token()) != hash_token(generate_token())
