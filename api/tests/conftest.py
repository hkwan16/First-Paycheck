"""Shared test setup.

The environment is pinned before any app module reads settings: APP_ENV=test
makes Settings ignore the developer's .env file, the database URLs point at
TEST_DATABASE_URL only, and JWTs are verified against an in-memory ES256 key
whose JWKS is injected through the SUPABASE_JWKS setting.

Database fixtures: the test database is migrated to head once per session;
each test runs inside one outer transaction that is rolled back afterwards, and
app sessions join it through savepoints (``client_as`` and ``db_connection``).
"""

from __future__ import annotations

from tests.support.env import pin_test_environment

pin_test_environment()

# The imports below read settings, so they come after the environment is pinned.
import importlib
import os
import uuid
from collections.abc import Callable, Iterator
from dataclasses import dataclass

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import Connection, Engine, make_url, text

from app.config import get_settings
from app.db import dispose_engines, make_engine
from app.deps import get_db_bind, get_plaid_client, get_queue_bind
from app.main import create_app
from tests.support.auth_shim import ensure_auth_shim
from tests.support.database import (
    drop_database,
    recreate_database,
    sibling_database_url,
    upgrade,
)
from tests.support.documents import tesseract_available
from tests.support.fake_plaid import FakePlaidClient
from tests.support.tokens import make_token

# Password given to app_api in the test cluster so tests can connect as it.
APP_API_TEST_PASSWORD = "app_api_test"


@dataclass(frozen=True)
class FixtureUser:
    id: uuid.UUID
    email: str

    @property
    def claims(self) -> dict[str, str]:
        return {"sub": str(self.id), "role": "authenticated", "aud": "authenticated"}


USER_A = FixtureUser(uuid.UUID("00000000-0000-4000-8000-00000000000a"), "a@example.test")
USER_B = FixtureUser(uuid.UUID("00000000-0000-4000-8000-00000000000b"), "b@example.test")


@pytest.fixture
def tesseract() -> None:
    """For tests that OCR: they skip on a laptop without the tesseract binary
    and fail in CI, where the ``ingest-in-docker`` job runs them against the
    pinned Debian build."""
    if tesseract_available():
        return
    if os.environ.get("CI"):
        pytest.fail("tesseract must be installed in CI")
    pytest.skip("tesseract is not installed; OCR tests run in the ingest-in-docker job")


@pytest.fixture
def weasyprint() -> None:
    """For tests that render a PDF: WeasyPrint loads pango when imported, so
    they skip on a laptop where it cannot be found and fail in CI, which
    installs it (and runs them again inside the Docker image).

    On macOS with Homebrew's pango, run pytest directly (not through make,
    whose protected shell drops DYLD variables) with
    ``DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib``.
    """
    try:
        importlib.import_module("weasyprint")
    except OSError as exc:
        if os.environ.get("CI"):
            pytest.fail(f"WeasyPrint must load in CI: {exc}")
        pytest.skip("WeasyPrint cannot load pango here; PDF tests run in CI")


@pytest.fixture(scope="session", autouse=True)
def _dispose_app_engines() -> Iterator[None]:
    """Close the app's own pooled connections when the session ends."""
    yield
    dispose_engines()


@pytest.fixture(scope="session")
def test_database_url() -> str:
    url = get_settings().test_database_url
    if not url:
        if os.environ.get("CI"):
            pytest.fail("TEST_DATABASE_URL must be set in CI")
        pytest.skip("TEST_DATABASE_URL is not set; database tests need a local Postgres")
    return url


@pytest.fixture(scope="session")
def migrated_engine(test_database_url: str) -> Iterator[Engine]:
    """The test database with the auth shim installed and migrations at head."""
    engine = make_engine(test_database_url, pool_size=2)
    with engine.begin() as connection:
        ensure_auth_shim(connection)
    upgrade(test_database_url, "head")
    yield engine
    engine.dispose()


@pytest.fixture
def db_connection(migrated_engine: Engine) -> Iterator[Connection]:
    """A connection inside a transaction that is rolled back after the test."""
    with migrated_engine.connect() as connection:
        transaction = connection.begin()
        try:
            yield connection
        finally:
            transaction.rollback()


def _insert_user(connection: Connection, user: FixtureUser) -> FixtureUser:
    connection.execute(
        text("INSERT INTO auth.users (id, email) VALUES (:id, :email)"),
        {"id": user.id, "email": user.email},
    )
    return user


@pytest.fixture
def no_seed_rules(db_connection: Connection) -> Connection:
    """Remove committed seed category rules for this test (rolled back after).

    ``make seed`` may have loaded them into the test database; tests that
    count or write seed rows start from none.
    """
    db_connection.execute(text("DELETE FROM category_rules WHERE user_id IS NULL"))
    return db_connection


@pytest.fixture
def seeded_rules(no_seed_rules: Connection) -> Connection:
    """Exactly the committed seed file's category rules, for this test."""
    from db.seed.load import load_category_rules, read_seed_rules

    load_category_rules(no_seed_rules, read_seed_rules())
    return no_seed_rules


@pytest.fixture
def seeded_citations(db_connection: Connection) -> Connection:
    """Exactly the committed seed file's IRS citations, for this test."""
    from db.seed.load import load_irs_citations, read_seed_citations

    db_connection.execute(text("DELETE FROM irs_citations"))
    load_irs_citations(db_connection, read_seed_citations())
    return db_connection


@pytest.fixture
def user_a(db_connection: Connection) -> FixtureUser:
    return _insert_user(db_connection, USER_A)


@pytest.fixture
def user_b(db_connection: Connection) -> FixtureUser:
    return _insert_user(db_connection, USER_B)


@pytest.fixture
def fake_plaid() -> FakePlaidClient:
    return FakePlaidClient()


@pytest.fixture
def app(db_connection: Connection, fake_plaid: FakePlaidClient) -> FastAPI:
    """The app with every request session bound to the test's transaction and
    Plaid replaced by ``fake_plaid``."""
    application = create_app()
    application.dependency_overrides[get_db_bind] = lambda: db_connection
    application.dependency_overrides[get_queue_bind] = lambda: db_connection
    application.dependency_overrides[get_plaid_client] = lambda: fake_plaid
    return application


@pytest.fixture
def client_as(app: FastAPI) -> Callable[[FixtureUser], TestClient]:
    """``client_as(user)`` returns a client that sends a signed JWT for ``user``."""

    def build(user: FixtureUser) -> TestClient:
        return TestClient(app, headers={"Authorization": f"Bearer {make_token(user.id)}"})

    return build


@pytest.fixture(scope="session")
def app_api_url(migrated_engine: Engine, test_database_url: str) -> str:
    """A URL that logs in to the test database as ``app_api``, like production."""
    with migrated_engine.begin() as connection:
        connection.execute(
            text(f"ALTER ROLE app_api WITH LOGIN PASSWORD '{APP_API_TEST_PASSWORD}'")
        )
    return (
        make_url(test_database_url)
        .set(username="app_api", password=APP_API_TEST_PASSWORD)
        .render_as_string(hide_password=False)
    )


@pytest.fixture
def scratch_database(test_database_url: str) -> Iterator[tuple[str, Engine]]:
    """An empty sibling database with only the auth shim, dropped afterwards."""
    url = sibling_database_url(test_database_url, "migrations")
    recreate_database(test_database_url, url)
    engine = make_engine(url, pool_size=1)
    try:
        with engine.begin() as connection:
            ensure_auth_shim(connection)
        yield url, engine
    finally:
        engine.dispose()
        drop_database(test_database_url, url)
