"""JWT verification against the project's JWKS."""

from __future__ import annotations

import json
import time
import uuid
from typing import Annotated

import jwt
import pytest
from fastapi import APIRouter, Depends
from fastapi.testclient import TestClient

from app import auth
from app.auth import AuthUser, get_current_user, verify_jwt
from app.config import Settings, get_settings
from app.errors import AppError, Unauthorized
from app.main import create_app
from tests.support.tokens import TEST_ISSUER, make_token, other_private_key

USER_ID = uuid.UUID("11111111-1111-4111-8111-111111111111")


@pytest.fixture
def settings() -> Settings:
    return get_settings()


def test_valid_token_yields_the_user(settings: Settings) -> None:
    user = verify_jwt(make_token(USER_ID), settings)
    assert user.id == USER_ID
    assert user.claims["sub"] == str(USER_ID)
    assert user.claims["aud"] == "authenticated"


def test_expired_token_is_rejected(settings: Settings) -> None:
    with pytest.raises(Unauthorized, match="expired"):
        verify_jwt(make_token(USER_ID, expires_in=-60), settings)


def test_clock_skew_within_leeway_is_accepted(settings: Settings) -> None:
    assert verify_jwt(make_token(USER_ID, expires_in=-10), settings).id == USER_ID


def test_wrong_audience_is_rejected(settings: Settings) -> None:
    with pytest.raises(Unauthorized):
        verify_jwt(make_token(USER_ID, audience="anon"), settings)


def test_wrong_issuer_is_rejected(settings: Settings) -> None:
    with pytest.raises(Unauthorized):
        verify_jwt(make_token(USER_ID, issuer="https://evil.example/auth/v1"), settings)


def test_untrusted_key_is_rejected(settings: Settings) -> None:
    with pytest.raises(Unauthorized):
        verify_jwt(make_token(USER_ID, private_key=other_private_key()), settings)


def test_unknown_kid_is_rejected(settings: Settings) -> None:
    with pytest.raises(Unauthorized):
        verify_jwt(make_token(USER_ID, kid="rotated-away"), settings)


def test_hs256_token_is_rejected(settings: Settings) -> None:
    jwks = json.loads(settings.supabase_jwks or "{}")
    kid = jwks["keys"][0]["kid"]
    now = int(time.time())
    claims = {"sub": str(USER_ID), "aud": "authenticated", "iss": TEST_ISSUER}
    token = jwt.encode(
        {**claims, "iat": now, "exp": now + 60},
        "shared-secret-guess-long-enough-for-hmac-256",
        algorithm="HS256",
        headers={"kid": kid},
    )
    with pytest.raises(Unauthorized):
        verify_jwt(token, settings)


@pytest.mark.parametrize("sub", ["not-a-uuid", ""])
def test_subject_must_be_a_uuid(settings: Settings, sub: str) -> None:
    with pytest.raises(Unauthorized):
        verify_jwt(make_token(sub), settings)


def test_garbage_is_rejected(settings: Settings) -> None:
    with pytest.raises(Unauthorized):
        verify_jwt("not.a.jwt", settings)


def test_missing_configuration_is_a_503() -> None:
    bare = Settings(_env_file=None, supabase_url=None, supabase_jwks=None)
    with pytest.raises(AppError) as excinfo:
        verify_jwt(make_token(USER_ID), bare)
    assert excinfo.value.status_code == 503


def test_jwks_endpoint_outage_is_a_503(monkeypatch: pytest.MonkeyPatch) -> None:
    remote = Settings(
        _env_file=None, supabase_url="https://unreachable.invalid", supabase_jwks=None
    )

    def offline(self: object) -> object:
        raise jwt.PyJWKClientConnectionError("connection refused")

    monkeypatch.setattr(jwt.PyJWKClient, "fetch_data", offline)
    with pytest.raises(AppError) as excinfo:
        verify_jwt(make_token(USER_ID), remote)
    assert excinfo.value.status_code == 503


def test_remote_client_fetches_the_derived_jwks_url() -> None:
    remote = Settings(_env_file=None, supabase_url="https://abc.supabase.co", supabase_jwks=None)
    client = auth.jwk_client_for(remote)
    assert client.uri == "https://abc.supabase.co/auth/v1/.well-known/jwks.json"
    assert auth.jwk_client_for(remote) is client


def whoami_client() -> TestClient:
    app = create_app()
    router = APIRouter()

    @router.get("/whoami")
    def whoami(user: Annotated[AuthUser, Depends(get_current_user)]) -> dict[str, str]:
        return {"id": str(user.id)}

    app.include_router(router)
    return TestClient(app)


def test_current_user_dependency_reads_the_bearer_token() -> None:
    response = whoami_client().get(
        "/whoami", headers={"Authorization": f"Bearer {make_token(USER_ID)}"}
    )
    assert response.status_code == 200
    assert response.json() == {"id": str(USER_ID)}


@pytest.mark.parametrize("header", [None, "Basic dXNlcjpwYXNz", "Bearer", "Bearer junk"])
def test_current_user_dependency_rejects_bad_headers(header: str | None) -> None:
    headers = {"Authorization": header} if header is not None else {}
    response = whoami_client().get("/whoami", headers=headers)
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "unauthorized"
    assert response.headers["www-authenticate"] == "Bearer"
