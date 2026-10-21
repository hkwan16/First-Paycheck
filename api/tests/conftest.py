"""Shared test setup.

The environment is pinned before any app module reads settings: APP_ENV=test
makes Settings ignore the developer's .env file, the database URLs point at
TEST_DATABASE_URL only, and JWTs are verified against an in-memory ES256 key
whose JWKS is injected through the SUPABASE_JWKS setting.
"""

from __future__ import annotations

from tests.support.env import pin_test_environment

TEST_DATABASE_URL = pin_test_environment()
