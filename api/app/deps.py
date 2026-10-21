"""FastAPI dependencies shared by routers."""

from __future__ import annotations

import logging
from collections.abc import Iterator
from typing import Annotated

from fastapi import Depends
from sqlalchemy import Connection, Engine
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.auth import CurrentUser
from app.config import Settings, get_settings
from app.db import DatabaseNotConfigured, current_alembic_revision, get_engine, user_session
from app.errors import AppError

logger = logging.getLogger(__name__)

SettingsDep = Annotated[Settings, Depends(get_settings)]


def _unavailable() -> AppError:
    return AppError("Database unavailable", code="database_unavailable", status_code=503)


def get_db_bind() -> Engine | Connection:
    """What request sessions bind to. Tests override this with a connection
    held inside an outer transaction so each test rolls back."""
    try:
        return get_engine()
    except DatabaseNotConfigured as exc:
        logger.error("database is not configured: %s", exc)
        raise _unavailable() from exc


DbBind = Annotated[Engine | Connection, Depends(get_db_bind)]


def get_user_session(user: CurrentUser, bind: DbBind) -> Iterator[Session]:
    with user_session(user.claims, bind=bind) as session:
        yield session


# scope="function": the transaction commits before the response is sent, so a
# failed commit becomes an error response instead of a lost write.
UserSession = Annotated[Session, Depends(get_user_session, scope="function")]


def alembic_revision(bind: DbBind) -> str | None:
    """The database's current Alembic revision; 503 when the database is unreachable."""
    try:
        if isinstance(bind, Engine):
            with bind.connect() as connection:
                return current_alembic_revision(connection)
        return current_alembic_revision(bind)
    except SQLAlchemyError as exc:
        logger.warning("health check could not read the alembic revision: %s", exc)
        raise _unavailable() from exc
