"""Provider access tokens, encrypted at rest (spec 002 rules 19-20).

``PLAID_TOKEN_KEY`` holds one or more Fernet keys, newest first. Encryption
always uses the newest; decryption tries each (``MultiFernet``), so a key is
rotated by prepending a new one, calling ``rotate`` on every stored token,
then dropping the old key. Plaintext is a ``SecretStr`` everywhere, so it
never shows up in a repr, a log line or an exception.
"""

from __future__ import annotations

from collections.abc import Sequence

from cryptography.fernet import Fernet, InvalidToken, MultiFernet
from pydantic import SecretStr

from app.config import Settings


class TokenCipherNotConfigured(RuntimeError):
    """PLAID_TOKEN_KEY is missing or malformed."""


class TokenDecryptError(Exception):
    """The ciphertext was not made by any configured key, or was altered."""


class TokenCipher:
    def __init__(self, keys: Sequence[str]) -> None:
        if not keys:
            raise TokenCipherNotConfigured("PLAID_TOKEN_KEY has no keys")
        try:
            self._fernet = MultiFernet([Fernet(key.encode()) for key in keys])
        except (ValueError, TypeError) as exc:
            raise TokenCipherNotConfigured(
                "PLAID_TOKEN_KEY must hold url-safe base64 Fernet keys"
            ) from exc
        self._count = len(keys)

    def __repr__(self) -> str:
        return f"TokenCipher(keys={self._count})"

    def encrypt(self, token: SecretStr) -> bytes:
        return self._fernet.encrypt(token.get_secret_value().encode())

    def decrypt(self, ciphertext: bytes) -> SecretStr:
        try:
            return SecretStr(self._fernet.decrypt(ciphertext).decode())
        except InvalidToken:
            raise TokenDecryptError("access token could not be decrypted") from None

    def rotate(self, ciphertext: bytes) -> bytes:
        """Re-encrypt ``ciphertext`` with the newest key."""
        try:
            return self._fernet.rotate(ciphertext)
        except InvalidToken:
            raise TokenDecryptError("access token could not be decrypted") from None


def cipher_from_settings(settings: Settings) -> TokenCipher:
    raw = settings.plaid_token_key.get_secret_value() if settings.plaid_token_key else ""
    keys = [part.strip() for part in raw.split(",") if part.strip()]
    if not keys:
        raise TokenCipherNotConfigured("PLAID_TOKEN_KEY is not set")
    return TokenCipher(keys)
