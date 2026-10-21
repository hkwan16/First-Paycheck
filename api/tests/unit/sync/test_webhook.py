"""Plaid webhook signature verification (spec 002 rules 21-24, example 8)."""

from __future__ import annotations

import hashlib
import json
import time
from typing import Any

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import ec
from jwt.algorithms import ECAlgorithm

from sync.plaid.client import PlaidError
from sync.plaid.webhook import (
    WebhookKeyCache,
    WebhookVerificationError,
    verify_plaid_webhook,
)

KID = "6c5516e1-92dc-479e-a8ff-5a51992e0001"
NOW = 1_792_600_000
BODY = json.dumps(
    {"webhook_type": "TRANSACTIONS", "webhook_code": "SYNC_UPDATES_AVAILABLE", "item_id": "item-1"},
    indent=2,
).encode()

_KEY = ec.generate_private_key(ec.SECP256R1())


def public_jwk(kid: str = KID, *, expired_at: int | None = None) -> dict[str, Any]:
    jwk: dict[str, Any] = json.loads(ECAlgorithm.to_jwk(_KEY.public_key()))
    jwk.update(kid=kid, alg="ES256", use="sig", created_at=NOW - 86_400, expired_at=expired_at)
    return jwk


def sign(
    body: bytes = BODY,
    *,
    iat: int = NOW,
    kid: str = KID,
    key: Any = _KEY,
    algorithm: str = "ES256",
) -> str:
    claims = {"iat": iat, "request_body_sha256": hashlib.sha256(body).hexdigest()}
    return jwt.encode(claims, key, algorithm=algorithm, headers={"kid": kid})


class Keys:
    def __init__(self, *jwks: dict[str, Any]) -> None:
        self.jwks = {jwk["kid"]: jwk for jwk in jwks}
        self.fetched: list[str] = []

    def __call__(self, kid: str) -> dict[str, Any]:
        self.fetched.append(kid)
        if kid not in self.jwks:
            raise PlaidError(
                code="INVALID_WEBHOOK_VERIFICATION_KEY_ID",
                error_type="INVALID_INPUT",
                message="unknown key",
                request_id="r",
            )
        return self.jwks[kid]


def cache(keys: Keys, clock: float = 0.0) -> WebhookKeyCache:
    return WebhookKeyCache(keys, clock=lambda: clock)


def verify(body: bytes, header: str | None, keys: Keys | None = None) -> None:
    verify_plaid_webhook(body, header, cache(keys or Keys(public_jwk())), now=NOW)


def test_valid_webhook_passes() -> None:
    verify(BODY, sign())


def test_tampered_body_is_rejected() -> None:
    tampered = BODY.replace(b"item-1", b"item-2")
    with pytest.raises(WebhookVerificationError, match="body"):
        verify(tampered, sign())


@pytest.mark.parametrize("iat", [NOW - 360, NOW + 360])
def test_stale_or_future_iat_is_rejected(iat: int) -> None:
    with pytest.raises(WebhookVerificationError, match="iat"):
        verify(BODY, sign(iat=iat))


def test_iat_within_five_minutes_passes() -> None:
    verify(BODY, sign(iat=NOW - 299))


def test_wrong_kid_is_rejected() -> None:
    with pytest.raises(WebhookVerificationError, match="key"):
        verify(BODY, sign(kid="not-a-plaid-key"))


def test_hs256_is_rejected_before_any_key_lookup() -> None:
    keys = Keys(public_jwk())
    with pytest.raises(WebhookVerificationError, match="ES256"):
        verify(BODY, sign(key="a-shared-secret-chosen-by-an-attacker", algorithm="HS256"), keys)
    assert keys.fetched == []


def test_a_signature_from_another_key_is_rejected() -> None:
    other = ec.generate_private_key(ec.SECP256R1())
    with pytest.raises(WebhookVerificationError, match="signature"):
        verify(BODY, sign(key=other))


def test_expired_key_is_rejected() -> None:
    with pytest.raises(WebhookVerificationError, match="expired"):
        verify(BODY, sign(), Keys(public_jwk(expired_at=NOW - 1)))


@pytest.mark.parametrize("header", [None, "", "not.a.jwt", "a.b"])
def test_missing_or_malformed_header_is_rejected(header: str | None) -> None:
    with pytest.raises(WebhookVerificationError):
        verify(BODY, header)


def test_missing_kid_is_rejected() -> None:
    token = jwt.encode(
        {"iat": NOW, "request_body_sha256": hashlib.sha256(BODY).hexdigest()},
        _KEY,
        algorithm="ES256",
    )
    with pytest.raises(WebhookVerificationError, match="kid"):
        verify(BODY, token)


def test_keys_are_cached_for_24_hours() -> None:
    keys = Keys(public_jwk())
    clock = [0.0]
    key_cache = WebhookKeyCache(keys, clock=lambda: clock[0])
    verify_plaid_webhook(BODY, sign(), key_cache, now=NOW)
    clock[0] = 86_399
    verify_plaid_webhook(BODY, sign(), key_cache, now=NOW)
    assert keys.fetched == [KID]
    clock[0] = 86_401
    verify_plaid_webhook(BODY, sign(), key_cache, now=NOW)
    assert keys.fetched == [KID, KID]


def test_failed_lookups_are_not_cached() -> None:
    keys = Keys()
    key_cache = WebhookKeyCache(keys, clock=time.monotonic)
    for _ in range(2):
        with pytest.raises(WebhookVerificationError):
            verify_plaid_webhook(BODY, sign(), key_cache, now=NOW)
    assert keys.fetched == [KID, KID]
