"""Pin the process environment for tests so nothing reaches real services."""

from __future__ import annotations

import os

from dotenv import dotenv_values

from app.config import REPO_ROOT
from tests.support.tokens import TEST_SUPABASE_URL, jwks_json

# Secrets a developer may have exported in their shell. Tests never use them.
_BLANKED = (
    "ANTHROPIC_API_KEY",
    "PLAID_CLIENT_ID",
    "PLAID_SECRET",
    "PLAID_TOKEN_KEY",
    "PLAID_WEBHOOK_URL",
    "SUPABASE_JWKS_URL",
    "CORS_ORIGINS",
    "CORS_ORIGIN_REGEX",
)


def resolve_test_database_url() -> str | None:
    """TEST_DATABASE_URL from the environment, else from the repo's .env file."""
    url = os.environ.get("TEST_DATABASE_URL") or dotenv_values(REPO_ROOT / ".env").get(
        "TEST_DATABASE_URL"
    )
    return url.strip() if url and url.strip() else None


def pin_test_environment() -> str | None:
    """Point every setting at test values and return the test database URL."""
    test_url = resolve_test_database_url()
    os.environ["APP_ENV"] = "test"
    os.environ["TEST_DATABASE_URL"] = test_url or ""
    # The app's own engines use the test database and nothing else.
    os.environ["DATABASE_URL"] = test_url or ""
    os.environ["DATABASE_URL_PRIVILEGED"] = test_url or ""
    os.environ["SUPABASE_URL"] = TEST_SUPABASE_URL
    os.environ["SUPABASE_JWKS"] = jwks_json()
    os.environ["LLM_FAKE"] = "true"
    for name in _BLANKED:
        os.environ[name] = ""
    return test_url
