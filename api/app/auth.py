"""Supabase JWT verification.

Supabase Auth signs access tokens with an asymmetric key (ES256, or RS256 for
older projects) and publishes the public keys as a JWKS. Tokens are verified
against that JWKS for signature, expiry (30 s leeway), audience
``authenticated`` and the project's issuer. HS256 tokens are never accepted.
"""

from __future__ import annotations

import json
import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from functools import lru_cache
from typing import Annotated, Any

import jwt
from fastapi import Depends
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.config import Settings, get_settings
from app.errors import AppError, Unauthorized

ALGORITHMS = ("ES256", "RS256")
AUDIENCE = "authenticated"
LEEWAY_SECONDS = 30
JWKS_CACHE_SECONDS = 600


@dataclass(frozen=True)
class AuthUser:
    id: uuid.UUID
    # The verified claims, forwarded to Postgres as request.jwt.claims.
    claims: Mapping[str, Any]


class _StaticJWKClient(jwt.PyJWKClient):
    """A PyJWKClient serving a JWKS given inline (SUPABASE_JWKS) instead of fetched."""

    def __init__(self, jwks: dict[str, Any]) -> None:
        super().__init__("https://inline.invalid/jwks.json", cache_jwk_set=False)
        self._jwks = jwks

    def fetch_data(self) -> Any:
        return self._jwks


@lru_cache(maxsize=4)
def _client(jwks_url: str | None, inline_jwks: str | None) -> jwt.PyJWKClient:
    if inline_jwks is not None:
        return _StaticJWKClient(json.loads(inline_jwks))
    if jwks_url is None:
        raise _auth_unavailable("Auth is not configured: set SUPABASE_URL")
    return jwt.PyJWKClient(jwks_url, cache_keys=True, lifespan=JWKS_CACHE_SECONDS, timeout=5)


def _auth_unavailable(message: str) -> AppError:
    return AppError(message, code="auth_unavailable", status_code=503)


def jwk_client_for(settings: Settings) -> jwt.PyJWKClient:
    """The (cached) JWKS client for these settings."""
    return _client(settings.jwks_url, settings.supabase_jwks)


def verify_jwt(token: str, settings: Settings) -> AuthUser:
    """Verify a Supabase access token. Raises Unauthorized (401) or a 503 AppError."""
    issuer = settings.jwt_issuer
    if issuer is None:
        raise _auth_unavailable("Auth is not configured: set SUPABASE_URL")
    client = jwk_client_for(settings)
    try:
        signing_key = client.get_signing_key_from_jwt(token)
    except jwt.PyJWKClientConnectionError as exc:
        # The user's token may be fine; do not send them back to sign-in.
        raise _auth_unavailable("Could not fetch the token signing keys") from exc
    except jwt.PyJWTError as exc:
        raise Unauthorized("Invalid token") from exc

    if signing_key.algorithm_name not in ALGORITHMS:
        raise Unauthorized("Invalid token")
    try:
        claims: dict[str, Any] = jwt.decode(
            token,
            signing_key.key,
            algorithms=[signing_key.algorithm_name],
            audience=AUDIENCE,
            issuer=issuer,
            leeway=LEEWAY_SECONDS,
            options={"require": ["exp", "iat", "sub", "aud", "iss"]},
        )
    except jwt.ExpiredSignatureError as exc:
        raise Unauthorized("Token expired") from exc
    except jwt.PyJWTError as exc:
        raise Unauthorized("Invalid token") from exc

    try:
        user_id = uuid.UUID(str(claims["sub"]))
    except ValueError as exc:
        raise Unauthorized("Invalid token subject") from exc
    return AuthUser(id=user_id, claims=claims)


_bearer = HTTPBearer(auto_error=False, description="Supabase access token")


def get_current_user(
    settings: Annotated[Settings, Depends(get_settings)],
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
) -> AuthUser:
    if credentials is None or not credentials.credentials:
        raise Unauthorized("Missing bearer token")
    return verify_jwt(credentials.credentials, settings)


CurrentUser = Annotated[AuthUser, Depends(get_current_user)]
