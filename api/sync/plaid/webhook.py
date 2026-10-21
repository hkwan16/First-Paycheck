"""Plaid webhook signature verification (spec 002 rules 21-24).

Plaid signs each webhook with an ES256 JWT in the ``Plaid-Verification`` header.
The JWT's ``request_body_sha256`` claim binds it to the exact body bytes, and its
``iat`` bounds replay to a five-minute window.
"""

from __future__ import annotations

import hashlib
import hmac
import threading
import time
from collections.abc import Callable, Mapping
from typing import Any

import jwt
from cryptography.hazmat.primitives.asymmetric import ec
from jwt.algorithms import ECAlgorithm

from sync.plaid.client import PlaidError

KEY_TTL_SECONDS = 24 * 60 * 60
MAX_AGE_SECONDS = 5 * 60

KeyFetcher = Callable[[str], Mapping[str, Any]]

__all__ = ["WebhookKeyCache", "WebhookVerificationError", "verify_plaid_webhook"]


class WebhookVerificationError(Exception):
    """The webhook is not provably from Plaid; answer 401 and do nothing."""


class WebhookKeyCache:
    """Plaid verification keys by ``kid``, each kept for 24 hours.

    Failed lookups are not cached, so a forged ``kid`` costs a Plaid call but
    never grows the cache.
    """

    def __init__(
        self,
        fetch: KeyFetcher,
        *,
        ttl_seconds: float = KEY_TTL_SECONDS,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._fetch = fetch
        self._ttl = ttl_seconds
        self._clock = clock
        self._keys: dict[str, tuple[float, Mapping[str, Any]]] = {}
        self._lock = threading.Lock()

    def get(self, kid: str) -> Mapping[str, Any]:
        with self._lock:
            cached = self._keys.get(kid)
            if cached is not None and self._clock() - cached[0] < self._ttl:
                return cached[1]
        key = self._fetch(kid)
        with self._lock:
            self._keys[kid] = (self._clock(), key)
        return key


def verify_plaid_webhook(
    body: bytes,
    header: str | None,
    keys: WebhookKeyCache,
    *,
    now: float | None = None,
) -> None:
    """Raise ``WebhookVerificationError`` unless Plaid signed exactly this body."""
    current = time.time() if now is None else now
    if not header:
        raise WebhookVerificationError("missing Plaid-Verification header")
    try:
        unverified = jwt.get_unverified_header(header)
    except jwt.PyJWTError:
        raise WebhookVerificationError("malformed Plaid-Verification header") from None
    if unverified.get("alg") != "ES256":
        raise WebhookVerificationError("Plaid-Verification must use alg ES256")
    kid = unverified.get("kid")
    if not isinstance(kid, str) or not kid:
        raise WebhookVerificationError("Plaid-Verification header has no kid")

    try:
        jwk = keys.get(kid)
    except PlaidError:
        raise WebhookVerificationError("unknown verification key") from None
    expired_at = jwk.get("expired_at")
    if expired_at is not None and expired_at <= current:
        raise WebhookVerificationError("verification key has expired")
    try:
        public_key = ECAlgorithm.from_jwk(dict(jwk))
    except (jwt.PyJWTError, ValueError, TypeError):
        raise WebhookVerificationError("invalid verification key") from None
    if not isinstance(public_key, ec.EllipticCurvePublicKey):
        raise WebhookVerificationError("invalid verification key")

    try:
        claims = jwt.decode(
            header,
            public_key,
            algorithms=["ES256"],
            options={"verify_iat": False, "verify_exp": False, "require": ["iat"]},
        )
    except jwt.InvalidSignatureError:
        raise WebhookVerificationError("bad signature") from None
    except jwt.PyJWTError:
        raise WebhookVerificationError("invalid Plaid-Verification token") from None

    iat = claims["iat"]
    if (
        isinstance(iat, bool)
        or not isinstance(iat, int | float)
        or abs(current - iat) > MAX_AGE_SECONDS
    ):
        raise WebhookVerificationError("iat is not within 5 minutes of now")

    claimed = claims.get("request_body_sha256")
    actual = hashlib.sha256(body).hexdigest()
    if not isinstance(claimed, str) or not hmac.compare_digest(claimed, actual):
        raise WebhookVerificationError("body does not match request_body_sha256")
