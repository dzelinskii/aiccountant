from app.core.security import hash_password, verify_password


def test_hash_is_not_plaintext() -> None:
    hashed = hash_password("secret-password")
    assert hashed != "secret-password"
    assert hashed.startswith("$argon2")


def test_verify_roundtrip() -> None:
    hashed = hash_password("secret-password")
    assert verify_password(hashed, "secret-password") is True
    assert verify_password(hashed, "wrong-password") is False
