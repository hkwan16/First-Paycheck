"""Database engines and the per-request RLS session.

Two engines, two roles:

* ``get_engine()`` connects as ``app_api`` through the Supavisor transaction
  pooler. Every request and job handler uses it.
* ``get_privileged_engine()`` connects as ``postgres``. Only Alembic,
  ``jobs/queue.py`` and ``jobs/scheduler.py`` may use it
  (``tests/unit/test_boundaries.py`` enforces this).
"""

from __future__ import annotations

import json
import uuid
from collections.abc import Iterator, Mapping
from contextlib import AbstractContextManager, contextmanager
from functools import lru_cache
from typing import Any

from sqlalchemy import Connection, Engine, create_engine, text
from sqlalchemy.orm import Session

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


def dispose_engines() -> None:
    """Close every pooled connection and forget the cached engines.

    Called on application shutdown and by tests that change database settings.
    """
    for factory in (get_engine, get_privileged_engine):
        if factory.cache_info().currsize:
            factory().dispose()
        factory.cache_clear()


def _claims_json(claims: Mapping[str, Any]) -> str:
    if not claims.get("sub"):
        raise ValueError("JWT claims must carry a 'sub'")
    return json.dumps(dict(claims), separators=(",", ":"), sort_keys=True, default=str)


@contextmanager
def _restore_session_state(bind: Engine | Connection) -> Iterator[None]:
    """Put back the role and JWT claims of a caller-owned connection.

    ``SET LOCAL`` lasts until the end of the enclosing transaction. On an
    Engine that transaction is the session's own, so commit or rollback resets
    everything. A caller-owned Connection (tests, nested sessions) keeps its
    outer transaction open after the session's savepoint is released, so the
    previous values are restored explicitly. On an error the savepoint
    rollback has already undone them.
    """
    if not isinstance(bind, Connection):
        yield
        return
    role, claims = bind.execute(
        text(
            "SELECT current_setting('role'),"
            " coalesce(current_setting('request.jwt.claims', true), '')"
        )
    ).one()
    yield
    bind.execute(
        text(
            "SELECT set_config('role', :role, true),"
            " set_config('request.jwt.claims', :claims, true)"
        ),
        {"role": role, "claims": claims},
    )


@contextmanager
def _scoped_session(
    bind: Engine | Connection | None, *setup: tuple[str, dict[str, Any]]
) -> Iterator[Session]:
    target = bind if bind is not None else get_engine()
    with _restore_session_state(target):
        session = Session(
            bind=target, join_transaction_mode="create_savepoint", expire_on_commit=False
        )
        with session, session.begin():
            for statement, params in setup:
                session.execute(text(statement), params)
            yield session


@contextmanager
def user_session(
    claims: Mapping[str, Any], *, bind: Engine | Connection | None = None
) -> Iterator[Session]:
    """A session that runs every statement as the user the claims describe.

    One transaction: ``SET LOCAL ROLE authenticated`` and
    ``set_config('request.jwt.claims', <claims>, true)`` come first, so
    ``auth.uid()`` and every RLS policy see the user. Both settings are
    transaction-local, so commit or rollback hands a clean connection back to
    the pool. The block commits on success and rolls back on any exception.

    ``bind`` defaults to the app_api engine. Tests pass a connection that is
    already inside a transaction; the session then joins it with a savepoint
    and the connection's previous role and claims are restored afterwards.
    """
    claims_json = _claims_json(claims)
    with _scoped_session(
        bind,
        ("SET LOCAL ROLE authenticated", {}),
        ("SELECT set_config('request.jwt.claims', :claims, true)", {"claims": claims_json}),
    ) as session:
        yield session


@contextmanager
def service_session(*, bind: Engine | Connection | None = None) -> Iterator[Session]:
    """A session with no user: ``SET LOCAL ROLE app_api``, which owns nothing.

    It can only call functions granted to ``app_api``, such as the webhook's
    ``enqueue_sync_for_plaid_item``. In production the connection already is
    app_api, so the role switch is a no-op; under tests it drops the
    superuser's privileges so the grants are exercised.
    """
    with _scoped_session(bind, ("SET LOCAL ROLE app_api", {})) as session:
        yield session


def user_session_for(
    user_id: uuid.UUID, *, bind: Engine | Connection | None = None
) -> AbstractContextManager[Session]:
    """``user_session`` for a job handler, which knows the user id but has no JWT."""
    return user_session(
        {"sub": str(user_id), "role": "authenticated", "aud": "authenticated"}, bind=bind
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
