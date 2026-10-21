"""Engine configuration and the missing-configuration paths (no database needed)."""

from __future__ import annotations

from collections.abc import Iterator

import pytest
from sqlalchemy.pool import QueuePool

from app import db
from app.config import get_settings
from app.deps import get_db_bind
from app.errors import AppError


@pytest.fixture
def fresh_settings(monkeypatch: pytest.MonkeyPatch) -> Iterator[pytest.MonkeyPatch]:
    """Reset the cached settings and engines around a test that changes the environment."""
    db.dispose_engines()
    get_settings.cache_clear()
    yield monkeypatch
    db.dispose_engines()
    get_settings.cache_clear()


def test_dispose_engines_closes_and_forgets_cached_engines(
    fresh_settings: pytest.MonkeyPatch,
) -> None:
    fresh_settings.setenv("DATABASE_URL", "postgresql://app_api:x@pooler:6543/db")
    engine = db.get_engine()
    db.dispose_engines()
    assert db.get_engine.cache_info().currsize == 0
    assert db.get_engine() is not engine


def test_engine_is_configured_for_the_transaction_pooler() -> None:
    engine = db.make_engine("postgresql+psycopg://u:p@localhost:6543/postgres")
    try:
        assert engine.url.drivername == "postgresql+psycopg"
        assert isinstance(engine.pool, QueuePool)
        assert engine.pool.size() == db.POOL_SIZE == 5
        assert engine.pool._pre_ping is True
    finally:
        engine.dispose()


def test_app_engine_requires_database_url(fresh_settings: pytest.MonkeyPatch) -> None:
    fresh_settings.setenv("DATABASE_URL", "")
    with pytest.raises(db.DatabaseNotConfigured, match="DATABASE_URL"):
        db.get_engine()


def test_privileged_engine_requires_its_url(fresh_settings: pytest.MonkeyPatch) -> None:
    fresh_settings.setenv("DATABASE_URL_PRIVILEGED", "")
    with pytest.raises(db.DatabaseNotConfigured, match="DATABASE_URL_PRIVILEGED"):
        db.get_privileged_engine()


def test_privileged_engine_uses_its_own_url(fresh_settings: pytest.MonkeyPatch) -> None:
    fresh_settings.setenv("DATABASE_URL_PRIVILEGED", "postgresql://postgres:x@pooler:5432/db")
    engine = db.get_privileged_engine()
    assert engine.url.username == "postgres"
    assert engine.url.port == 5432
    assert db.get_privileged_engine() is engine


def test_request_bind_is_a_503_without_a_database(fresh_settings: pytest.MonkeyPatch) -> None:
    fresh_settings.setenv("DATABASE_URL", "")
    with pytest.raises(AppError) as excinfo:
        get_db_bind()
    assert excinfo.value.status_code == 503
    assert excinfo.value.code == "database_unavailable"
