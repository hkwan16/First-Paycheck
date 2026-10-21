"""The local real-API e2e harness: its Supabase Auth stand-in, environments and database."""

from __future__ import annotations

import base64
import http.client
import json
import os
import uuid
from collections.abc import Iterator
from typing import Any
from urllib.parse import urlsplit

import pytest
from sqlalchemy import create_engine, make_url, text

from app.auth import verify_jwt
from app.config import Settings
from scripts import e2e_stack
from scripts.e2e_stack import FakeSupabaseAuth, FixtureUser, StackConfig
from tests.support.env import resolve_test_database_url

USER = FixtureUser(
    id=uuid.UUID("00000000-0000-4000-8000-0000000000e2"),
    email="someone@example.test",
    password="correct horse battery staple",
)


@pytest.fixture
def auth() -> Iterator[FakeSupabaseAuth]:
    server = FakeSupabaseAuth([USER], port=0)
    server.start()
    try:
        yield server
    finally:
        server.stop()


def call(
    method: str,
    url: str,
    body: dict[str, Any] | None = None,
    headers: dict[str, str] | None = None,
) -> tuple[int, dict[str, str], Any]:
    parsed = urlsplit(url)
    connection = http.client.HTTPConnection(parsed.netloc, timeout=5)
    sent = dict(headers or {})
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        sent["Content-Type"] = "application/json"
    try:
        target = f"{parsed.path}?{parsed.query}" if parsed.query else parsed.path
        connection.request(method, target, body=data, headers=sent)
        response = connection.getresponse()
        raw = response.read()
        return response.status, dict(response.headers), json.loads(raw) if raw else None
    finally:
        connection.close()


def sign_in(auth: FakeSupabaseAuth, email: str, password: str) -> tuple[int, Any]:
    status, _, body = call(
        "POST",
        f"{auth.url}/auth/v1/token?grant_type=password",
        {"email": email, "password": password, "gotrue_meta_security": {}},
    )
    return status, body


def api_settings(auth: FakeSupabaseAuth) -> Settings:
    """The settings the API runs with under the harness, as far as auth goes."""
    # Explicit values win over any .env file the developer has.
    return Settings(
        app_env="test", supabase_url=auth.url, supabase_jwks_url=None, supabase_jwks=None
    )


# ---------------------------------------------------------------- Supabase Auth stand-in


def test_password_sign_in_returns_a_session_the_api_verifies(auth: FakeSupabaseAuth) -> None:
    status, session = sign_in(auth, USER.email, USER.password)

    assert status == 200
    assert session["token_type"] == "bearer"
    assert session["expires_in"] > 0
    assert session["refresh_token"]
    assert session["user"]["id"] == str(USER.id)
    assert session["user"]["email"] == USER.email
    # The API fetches the stand-in's JWKS (<SUPABASE_URL>/auth/v1/.well-known/jwks.json)
    # and checks the issuer and audience exactly as it does for the hosted project.
    verified = verify_jwt(session["access_token"], api_settings(auth))
    assert verified.id == USER.id
    assert verified.claims["role"] == "authenticated"
    assert verified.claims["email"] == USER.email


def test_a_wrong_password_is_supabases_invalid_credentials_error(auth: FakeSupabaseAuth) -> None:
    status, body = sign_in(auth, USER.email, "not the right password")
    assert status == 400
    # supabase-js reads error_code without an API version header; the web maps
    # invalid_credentials to its "do not match" sentence.
    assert body["error_code"] == "invalid_credentials"

    status, body = sign_in(auth, "nobody@example.test", USER.password)
    assert status == 400
    assert body["error_code"] == "invalid_credentials"


def test_the_user_endpoint_needs_a_valid_token(auth: FakeSupabaseAuth) -> None:
    _, session = sign_in(auth, USER.email, USER.password)

    status, _, user = call(
        "GET",
        f"{auth.url}/auth/v1/user",
        headers={"Authorization": f"Bearer {session['access_token']}"},
    )
    assert status == 200
    assert user["id"] == str(USER.id)
    assert user["aud"] == "authenticated"

    for headers in ({}, {"Authorization": "Bearer not-a-token"}):
        status, _, body = call("GET", f"{auth.url}/auth/v1/user", headers=headers)
        assert status == 401
        assert body["error_code"] == "bad_jwt"


def test_a_refresh_token_gives_a_new_session_once(auth: FakeSupabaseAuth) -> None:
    _, session = sign_in(auth, USER.email, USER.password)
    url = f"{auth.url}/auth/v1/token?grant_type=refresh_token"

    status, _, refreshed = call("POST", url, {"refresh_token": session["refresh_token"]})
    assert status == 200
    assert refreshed["refresh_token"] != session["refresh_token"]
    assert verify_jwt(refreshed["access_token"], api_settings(auth)).id == USER.id

    # Refresh tokens are single use, as in Supabase.
    status, _, body = call("POST", url, {"refresh_token": session["refresh_token"]})
    assert status == 400
    assert body["error_code"] == "refresh_token_not_found"


def test_sign_out_and_unsupported_routes(auth: FakeSupabaseAuth) -> None:
    _, session = sign_in(auth, USER.email, USER.password)
    status, _, _ = call(
        "POST",
        f"{auth.url}/auth/v1/logout?scope=local",
        headers={"Authorization": f"Bearer {session['access_token']}"},
    )
    assert status == 204

    status, _, body = call("POST", f"{auth.url}/auth/v1/signup", {"email": "x@example.test"})
    assert status == 422
    assert body["error_code"] == "signup_disabled"


def test_the_jwks_names_the_key_tokens_are_signed_with(auth: FakeSupabaseAuth) -> None:
    status, _, jwks = call("GET", f"{auth.url}/auth/v1/.well-known/jwks.json")
    assert status == 200
    [key] = jwks["keys"]
    assert key["kty"] == "EC"
    assert key["alg"] == "ES256"
    assert "d" not in key  # the public half only

    _, session = sign_in(auth, USER.email, USER.password)
    header = json.loads(_b64url(session["access_token"].split(".")[0]))
    assert header == {"alg": "ES256", "kid": key["kid"], "typ": "JWT"}


def test_browsers_may_call_it_from_the_web_origin(auth: FakeSupabaseAuth) -> None:
    status, headers, _ = call(
        "OPTIONS",
        f"{auth.url}/auth/v1/user",
        headers={
            "Origin": "http://localhost:3247",
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "authorization, apikey, x-client-info",
        },
    )
    assert status == 204
    assert headers["Access-Control-Allow-Origin"] == "*"
    assert headers["Access-Control-Allow-Headers"] == "authorization, apikey, x-client-info"
    assert "GET" in headers["Access-Control-Allow-Methods"]

    _, headers, _ = call("GET", f"{auth.url}/auth/v1/.well-known/jwks.json")
    assert headers["Access-Control-Allow-Origin"] == "*"


def _b64url(part: str) -> bytes:
    return base64.urlsafe_b64decode(part + "=" * (-len(part) % 4))


# ---------------------------------------------------------------- configuration


def config(**overrides: Any) -> StackConfig:
    values: dict[str, Any] = {
        "database_url": "postgresql://localhost:5432/first_paycheck_e2e",
        "api_port": 8247,
        "auth_port": 54347,
        "web_port": 3247,
        "plaid_client_id": None,
        "plaid_secret": None,
    }
    values.update(overrides)
    return StackConfig(**values)


def test_config_reads_ports_database_and_plaid_from_the_environment() -> None:
    env = {
        "E2E_DATABASE_URL": "postgresql://postgres:postgres@postgres:5432/first_paycheck_e2e",
        "E2E_API_PORT": "9001",
        "E2E_AUTH_PORT": "9002",
        "E2E_PORT": "9003",
        "PLAID_CLIENT_ID": "client-from-env",
        "PLAID_SECRET": "secret-from-env",
    }
    loaded = StackConfig.from_env(env, dotenv={})
    assert loaded.database_url == env["E2E_DATABASE_URL"]
    assert (loaded.api_port, loaded.auth_port, loaded.web_port) == (9001, 9002, 9003)
    assert loaded.plaid_configured


def test_config_defaults_and_plaid_from_the_dotenv_file() -> None:
    loaded = StackConfig.from_env(
        {}, dotenv={"PLAID_CLIENT_ID": "client-from-file", "PLAID_SECRET": "secret-from-file"}
    )
    assert make_url(loaded.database_url).database == "first_paycheck_e2e"
    assert loaded.web_port not in (3000, 3100, 3147)
    assert loaded.plaid_client_id == "client-from-file"

    blank = StackConfig.from_env({"PLAID_CLIENT_ID": " ", "PLAID_SECRET": ""}, dotenv={})
    assert not blank.plaid_configured


def test_config_refuses_a_database_that_is_not_disposable() -> None:
    # The harness drops and recreates it, so it must say e2e in its name.
    with pytest.raises(ValueError, match="e2e"):
        StackConfig.from_env({"E2E_DATABASE_URL": "postgresql://localhost/postgres"}, dotenv={})


def test_config_repr_never_shows_the_plaid_secret() -> None:
    shown = repr(config(plaid_client_id="client-id", plaid_secret="shh-secret"))
    assert "shh-secret" not in shown


def test_api_environment_is_isolated_fake_llm_and_plaid_sandbox() -> None:
    inherited = {
        "PATH": "/usr/bin",
        "ANTHROPIC_API_KEY": "sk-from-the-shell",
        "SENTRY_DSN": "https://dsn.example",
        "DATABASE_URL": "postgresql://hosted.example/postgres",
        "SUPABASE_JWKS": '{"keys": []}',
        "RENDER_GIT_COMMIT": "abc",
    }
    env = e2e_stack.api_environment(
        config(plaid_client_id="client-id", plaid_secret="secret"),
        auth_url="http://127.0.0.1:54347",
        app_api_url="postgresql://app_api:pw@localhost:5432/first_paycheck_e2e",
        token_key="fernet-key",
        inherited=inherited,
    )

    assert env["PATH"] == "/usr/bin"
    # APP_ENV=test keeps the API from reading the developer's .env file.
    assert env["APP_ENV"] == "test"
    assert env["LLM_FAKE"] == "true"
    assert env["ANTHROPIC_API_KEY"] == ""
    assert env["SENTRY_DSN"] == ""
    assert env["SUPABASE_JWKS"] == ""
    assert "RENDER_GIT_COMMIT" not in env
    assert env["SUPABASE_URL"] == "http://127.0.0.1:54347"
    assert env["CORS_ORIGINS"] == "http://localhost:3247"
    assert env["PORT"] == "8247"
    assert env["PLAID_ENV"] == "sandbox"
    assert env["PLAID_CLIENT_ID"] == "client-id"
    assert env["PLAID_SECRET"] == "secret"
    assert env["PLAID_TOKEN_KEY"] == "fernet-key"
    assert env["PLAID_WEBHOOK_URL"] == ""

    # The API and worker connect as app_api, under RLS, as in production; the
    # queue and scheduler use the privileged URL.
    assert env["DATABASE_URL"] == "postgresql://app_api:pw@localhost:5432/first_paycheck_e2e"
    assert env["DATABASE_URL_PRIVILEGED"] == "postgresql://localhost:5432/first_paycheck_e2e"


def test_api_environment_without_plaid_leaves_it_unconfigured() -> None:
    env = e2e_stack.api_environment(
        config(), auth_url="http://127.0.0.1:1", app_api_url="x", token_key="k", inherited={}
    )
    assert env["PLAID_CLIENT_ID"] == ""
    assert env["PLAID_SECRET"] == ""


def test_playwright_environment_points_the_web_at_the_stack() -> None:
    users = e2e_stack.fixture_users()
    env = e2e_stack.playwright_environment(
        config(), auth_url="http://127.0.0.1:54347", users=users, inherited={"PATH": "/bin"}
    )
    assert env["PATH"] == "/bin"
    assert env["E2E_API_URL"] == "http://127.0.0.1:8247"
    assert env["E2E_PORT"] == "3247"
    assert env["NEXT_PUBLIC_SUPABASE_URL"] == "http://127.0.0.1:54347"
    assert env["NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"]
    assert env["E2E_USER_EMAIL"] == users.shared.email
    assert env["E2E_USER_PASSWORD"] == users.shared.password
    assert env["E2E_ALPHA_USER_EMAIL"] == users.alpha.email
    assert env["E2E_ALPHA_USER_PASSWORD"] == users.alpha.password
    assert env["E2E_PLAID_SANDBOX"] == "0"

    with_plaid = e2e_stack.playwright_environment(
        config(plaid_client_id="c", plaid_secret="s"),
        auth_url="http://127.0.0.1:54347",
        users=users,
        inherited={},
    )
    assert with_plaid["E2E_PLAID_SANDBOX"] == "1"
    # The web never needs the Plaid keys; only the API does.
    assert "PLAID_SECRET" not in with_plaid


def test_fixture_users_are_distinct_and_get_fresh_passwords() -> None:
    first, second = e2e_stack.fixture_users(), e2e_stack.fixture_users()
    assert first.shared.id != first.alpha.id
    assert first.shared.email != first.alpha.email
    assert first.shared.id == second.shared.id
    assert first.shared.password != second.shared.password
    assert len(first.alpha.password) >= 20


# ---------------------------------------------------------------- database


@pytest.fixture
def e2e_database_url() -> Iterator[str]:
    """A disposable ``<TEST_DATABASE_URL>_e2e_harness`` database, dropped afterwards."""
    base = resolve_test_database_url()
    if not base:
        if os.environ.get("CI"):
            pytest.fail("TEST_DATABASE_URL must be set in CI")
        pytest.skip("TEST_DATABASE_URL is not set; the database test needs a local Postgres")
    parsed = make_url(base)
    url = parsed.set(database=f"{parsed.database}_e2e_harness").render_as_string(
        hide_password=False
    )
    yield url
    e2e_stack.drop_database(url)


def test_prepare_database_migrates_seeds_and_adds_the_fixture_users(e2e_database_url: str) -> None:
    users = e2e_stack.fixture_users()
    e2e_stack.prepare_database(e2e_database_url, users)
    # Twice: a second run starts from an empty database again.
    app_api_url = e2e_stack.prepare_database(e2e_database_url, users)

    engine = create_engine(e2e_stack.psycopg_url(e2e_database_url))
    try:
        with engine.connect() as connection:
            emails = connection.execute(text("SELECT email FROM auth.users ORDER BY email")).all()
            citations = connection.execute(text("SELECT count(*) FROM irs_citations")).scalar_one()
            rules = connection.execute(
                text("SELECT count(*) FROM category_rules WHERE user_id IS NULL")
            ).scalar_one()
    finally:
        engine.dispose()
    assert [row.email for row in emails] == sorted(u.email for u in users)
    assert citations > 0
    assert rules > 0

    # The API's URL logs in as app_api, the production role.
    app_api = create_engine(app_api_url)
    try:
        with app_api.connect() as connection:
            assert connection.execute(text("SELECT current_user")).scalar_one() == "app_api"
    finally:
        app_api.dispose()
