"""Access-token encryption at rest (spec 002 rules 19-20)."""

from __future__ import annotations

import logging

import pytest
from cryptography.fernet import Fernet
from pydantic import SecretStr

from app.config import Settings
from sync.crypto import (
    TokenCipher,
    TokenCipherNotConfigured,
    TokenDecryptError,
    cipher_from_settings,
)

TOKEN = "access-sandbox-1b2c3d4e-0000-4000-8000-feedfacecafe"


def key() -> str:
    return Fernet.generate_key().decode()


def test_round_trip() -> None:
    cipher = TokenCipher([key()])
    ciphertext = cipher.encrypt(SecretStr(TOKEN))
    assert TOKEN.encode() not in ciphertext
    assert cipher.decrypt(ciphertext).get_secret_value() == TOKEN


def test_each_encryption_differs() -> None:
    cipher = TokenCipher([key()])
    assert cipher.encrypt(SecretStr(TOKEN)) != cipher.encrypt(SecretStr(TOKEN))


def test_rotation_reads_old_tokens_and_rewrites_them_with_the_new_key() -> None:
    old, new = key(), key()
    stored = TokenCipher([old]).encrypt(SecretStr(TOKEN))

    rotating = TokenCipher([new, old])
    assert rotating.decrypt(stored).get_secret_value() == TOKEN
    rotated = rotating.rotate(stored)

    # Once every row is rotated, the old key can be removed.
    assert TokenCipher([new]).decrypt(rotated).get_secret_value() == TOKEN
    with pytest.raises(TokenDecryptError):
        TokenCipher([new]).decrypt(stored)


def test_wrong_key_fails() -> None:
    stored = TokenCipher([key()]).encrypt(SecretStr(TOKEN))
    with pytest.raises(TokenDecryptError):
        TokenCipher([key()]).decrypt(stored)


def test_tampered_ciphertext_fails() -> None:
    cipher = TokenCipher([key()])
    stored = bytearray(cipher.encrypt(SecretStr(TOKEN)))
    stored[-5] ^= 0x01
    with pytest.raises(TokenDecryptError):
        cipher.decrypt(bytes(stored))


def test_plaintext_never_appears_in_reprs_errors_or_logs(caplog: pytest.LogCaptureFixture) -> None:
    cipher = TokenCipher([key()])
    secret = cipher.decrypt(cipher.encrypt(SecretStr(TOKEN)))
    assert TOKEN not in repr(secret)
    assert TOKEN not in str(secret)
    assert TOKEN not in repr(cipher)
    with caplog.at_level(logging.DEBUG), pytest.raises(TokenDecryptError) as failure:
        TokenCipher([key()]).decrypt(cipher.encrypt(SecretStr(TOKEN)))
    assert TOKEN not in str(failure.value)
    assert failure.value.__cause__ is None
    assert TOKEN not in caplog.text


def test_keys_come_from_settings_newest_first() -> None:
    old, new = key(), key()
    stored = TokenCipher([old]).encrypt(SecretStr(TOKEN))
    settings = Settings(_env_file=None, plaid_token_key=SecretStr(f"{new}, {old}"))
    cipher = cipher_from_settings(settings)
    assert cipher.decrypt(stored).get_secret_value() == TOKEN
    assert TokenCipher([new]).decrypt(cipher.encrypt(SecretStr(TOKEN))).get_secret_value() == TOKEN


@pytest.mark.parametrize("value", [None, "", " , "])
def test_missing_key_is_a_configuration_error(value: str | None) -> None:
    settings = Settings(
        _env_file=None, plaid_token_key=SecretStr(value) if value is not None else None
    )
    with pytest.raises(TokenCipherNotConfigured, match="PLAID_TOKEN_KEY"):
        cipher_from_settings(settings)


def test_malformed_key_is_a_configuration_error() -> None:
    with pytest.raises(TokenCipherNotConfigured, match="PLAID_TOKEN_KEY"):
        TokenCipher(["not-a-fernet-key"])
