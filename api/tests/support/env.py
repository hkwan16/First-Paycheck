"""Pin the process environment for tests so nothing reaches real services."""

from __future__ import annotations

import os

from dotenv import dotenv_values

from app.config import REPO_ROOT
from tests.support.tokens import TEST_SUPABASE_URL, jwks_json

# Secrets a developer may have exported in their shell. Default tests never use
# them; the live-marked tests read them through ``live_credential``.
_LIVE = ("ANTHROPIC_API_KEY", "PLAID_CLIENT_ID", "PLAID_SECRET")
_BLANKED = (
    *_LIVE,
    "PLAID_WEBHOOK_URL",
    "SUPABASE_JWKS_URL",
    "CORS_ORIGINS",
    "CORS_ORIGIN_REGEX",
)


# A fixed Fernet key for tests only; it encrypts nothing real.
TEST_PLAID_TOKEN_KEY = "dGVzdC1vbmx5LWZlcm5ldC1rZXktMzItYnl0ZXMhIT0="

_live_credentials: dict[str, str] = {}


def live_credential(name: str) -> str | None:
    """A real credential for a ``plaid_sandbox`` or ``llm_live`` test, if one is set."""
    return _live_credentials.get(name)


def _capture_live_credentials() -> None:
    from_file = dotenv_values(REPO_ROOT / ".env")
    for name in _LIVE:
        value = os.environ.get(name) or from_file.get(name)
        if value and value.strip():
            _live_credentials[name] = value.strip()


def resolve_test_database_url() -> str | None:
    """TEST_DATABASE_URL from the environment, else from the repo's .env file."""
    url = os.environ.get("TEST_DATABASE_URL") or dotenv_values(REPO_ROOT / ".env").get(
        "TEST_DATABASE_URL"
    )
    return url.strip() if url and url.strip() else None


def pin_test_environment() -> str | None:
    """Point every setting at test values and return the test database URL."""
    test_url = resolve_test_database_url()
    _capture_live_credentials()
    os.environ["APP_ENV"] = "test"
    os.environ["TEST_DATABASE_URL"] = test_url or ""
    # The app's own engines use the test database and nothing else.
    os.environ["DATABASE_URL"] = test_url or ""
    os.environ["DATABASE_URL_PRIVILEGED"] = test_url or ""
    os.environ["SUPABASE_URL"] = TEST_SUPABASE_URL
    os.environ["SUPABASE_JWKS"] = jwks_json()
    os.environ["LLM_FAKE"] = "true"
    os.environ["PLAID_TOKEN_KEY"] = TEST_PLAID_TOKEN_KEY
    for name in _BLANKED:
        os.environ[name] = ""
    return test_url
