"""Database engines.

Two engines, two roles:

* ``get_engine()`` connects as ``app_api`` through the Supavisor transaction
  pooler. Every request and job handler uses it.
* ``get_privileged_engine()`` connects as ``postgres``. Only Alembic,
  ``jobs/queue.py`` and ``jobs/scheduler.py`` may use it
  (``tests/unit/test_boundaries.py`` enforces this).
"""

from __future__ import annotations

from functools import lru_cache

from sqlalchemy import Connection, Engine, create_engine, text

from app.config import get_settings

POOL_SIZE = 5


class DatabaseNotConfigured(RuntimeError):
    """A database URL setting is missing."""


def make_engine(url: str, *, pool_size: int = POOL_SIZE, max_overflow: int = 5) -> Engine:
    """An engine suited to the Supavisor transaction pooler.

    ``prepare_threshold=None`` turns off server-side prepared statements, which
    a transaction-mode pooler cannot route back to the right backend.
    """
    return create_engine(
        url,
        pool_size=pool_size,
        max_overflow=max_overflow,
        pool_pre_ping=True,
        connect_args={"prepare_threshold": None},
    )


def _require(url: str | None, name: str) -> str:
    if not url:
        raise DatabaseNotConfigured(f"{name} is not set")
    return url


@lru_cache(maxsize=1)
def get_engine() -> Engine:
    """The ``app_api`` engine (DATABASE_URL)."""
    return make_engine(_require(get_settings().database_url, "DATABASE_URL"))


@lru_cache(maxsize=1)
def get_privileged_engine() -> Engine:
    """The ``postgres`` engine (DATABASE_URL_PRIVILEGED). See the module docstring."""
    settings = get_settings()
    return make_engine(
        _require(settings.database_url_privileged, "DATABASE_URL_PRIVILEGED"), pool_size=2
    )


def current_alembic_revision(connection: Connection) -> str | None:
    """The revision the database is migrated to, or None before the first migration."""
    exists = connection.execute(
        text("SELECT to_regclass('public.alembic_version') IS NOT NULL")
    ).scalar_one()
    if not exists:
        return None
    revision: str | None = connection.execute(
        text("SELECT version_num FROM public.alembic_version")
    ).scalar()
    return revision
