"""An ES256 signing key for tests and helpers that mint Supabase-shaped JWTs."""

from __future__ import annotations

import json
import time
import uuid
from typing import Any

import jwt
from cryptography.hazmat.primitives.asymmetric import ec
from jwt.algorithms import ECAlgorithm

TEST_SUPABASE_URL = "http://supabase.test"
TEST_ISSUER = f"{TEST_SUPABASE_URL}/auth/v1"
TEST_KID = "test-es256"

_PRIVATE_KEY = ec.generate_private_key(ec.SECP256R1())


def jwks_json() -> str:
    """The public half of the test key as a JWKS document."""
    jwk = json.loads(ECAlgorithm.to_jwk(_PRIVATE_KEY.public_key()))
    jwk.update({"kid": TEST_KID, "alg": "ES256", "use": "sig"})
    return json.dumps({"keys": [jwk]})


def make_token(
    sub: uuid.UUID | str,
    *,
    expires_in: int = 3600,
    audience: str = "authenticated",
    issuer: str = TEST_ISSUER,
    kid: str = TEST_KID,
    private_key: ec.EllipticCurvePrivateKey | None = None,
    **claims: Any,
) -> str:
    """Mint a token shaped like the ones Supabase Auth issues."""
    now = int(time.time())
    payload: dict[str, Any] = {
        "sub": str(sub),
        "aud": audience,
        "iss": issuer,
        "iat": now,
        "exp": now + expires_in,
        "role": "authenticated",
        "email": f"{sub}@example.test",
    }
    payload.update(claims)
    return jwt.encode(payload, private_key or _PRIVATE_KEY, algorithm="ES256", headers={"kid": kid})


def other_private_key() -> ec.EllipticCurvePrivateKey:
    """A key the API does not trust, for negative tests."""
    return ec.generate_private_key(ec.SECP256R1())
