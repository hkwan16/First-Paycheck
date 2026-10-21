"""A Plaid client double for route tests, plus webhook signing with a test key.

``FakePlaidClient`` implements the ``PlaidLinking`` protocol the routes use.
Each public token exchanges for a distinct access token and item id; any
method can be made to raise by putting an exception in ``fail``.
"""

from __future__ import annotations

import hashlib
import json
import time
from typing import Any

import jwt
from cryptography.hazmat.primitives.asymmetric import ec
from jwt.algorithms import ECAlgorithm
from pydantic import SecretStr

from sync.plaid.client import PlaidError

WEBHOOK_KID = "test-webhook-key"
_WEBHOOK_KEY = ec.generate_private_key(ec.SECP256R1())


def webhook_jwk(kid: str = WEBHOOK_KID) -> dict[str, Any]:
    jwk: dict[str, Any] = json.loads(ECAlgorithm.to_jwk(_WEBHOOK_KEY.public_key()))
    jwk.update(kid=kid, alg="ES256", use="sig", created_at=0, expired_at=None)
    return jwk


def sign_webhook(body: bytes, *, iat: float | None = None, kid: str = WEBHOOK_KID) -> str:
    """A ``Plaid-Verification`` header for ``body``, signed the way Plaid signs."""
    claims = {
        "iat": int(time.time() if iat is None else iat),
        "request_body_sha256": hashlib.sha256(body).hexdigest(),
    }
    return jwt.encode(claims, _WEBHOOK_KEY, algorithm="ES256", headers={"kid": kid})


def plaid_error(code: str, error_type: str = "INVALID_INPUT", status: int = 400) -> PlaidError:
    return PlaidError(
        code=code, error_type=error_type, message=code.lower(), request_id="req-test", status=status
    )


class FakePlaidClient:
    def __init__(self) -> None:
        self.calls: list[tuple[str, Any]] = []
        self.fail: dict[str, Exception] = {}
        self.removed: list[str] = []

    def _enter(self, name: str, argument: Any = None) -> None:
        self.calls.append((name, argument))
        if name in self.fail:
            raise self.fail[name]

    def link_token_create(self, *, user_id: str, webhook: str | None) -> dict[str, str]:
        self._enter("link_token_create", {"user_id": user_id, "webhook": webhook})
        return {"link_token": f"link-sandbox-{user_id}", "expiration": "2026-10-21T20:00:00Z"}

    def sandbox_public_token_create(
        self, institution_id: str, *, webhook: str | None = None, username: str | None = None
    ) -> str:
        self._enter("sandbox_public_token_create", institution_id)
        return f"public-sandbox-{institution_id}"

    def institution_name(self, institution_id: str) -> str:
        self._enter("institution_name", institution_id)
        return "First Platypus Bank"

    def item_public_token_exchange(self, public_token: str) -> tuple[SecretStr, str]:
        self._enter("item_public_token_exchange", public_token)
        suffix = public_token.rsplit("-", 1)[-1]
        return SecretStr(f"access-sandbox-{suffix}"), f"item-{suffix}"

    def item_remove(self, access_token: SecretStr) -> None:
        self._enter("item_remove")
        self.removed.append(access_token.get_secret_value())

    def webhook_verification_key_get(self, key_id: str) -> dict[str, Any]:
        self._enter("webhook_verification_key_get", key_id)
        if key_id != WEBHOOK_KID:
            raise plaid_error("INVALID_WEBHOOK_VERIFICATION_KEY_ID")
        return webhook_jwk(key_id)
