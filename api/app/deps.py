"""FastAPI dependencies shared by routers."""

from __future__ import annotations

import datetime as dt
import logging
import threading
import weakref
from collections.abc import Callable, Iterator
from contextlib import AbstractContextManager
from functools import lru_cache
from typing import Annotated

from fastapi import Depends, Request
from sqlalchemy import Connection, Engine
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.auth import CurrentUser
from app.config import Settings, get_settings
from app.db import (
    DatabaseNotConfigured,
    current_alembic_revision,
    get_engine,
    service_session,
    user_session,
)
from app.errors import AppError
from jobs import scheduler
from llm.gateway import Gateway, LLMNotConfigured, get_gateway
from sync.crypto import TokenCipher, TokenCipherNotConfigured, cipher_from_settings
from sync.plaid.client import PlaidClient, PlaidLinking, PlaidNotConfigured
from sync.plaid.webhook import WebhookKeyCache

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


UserSessionFactory = Callable[[], AbstractContextManager[Session]]


def get_user_session_factory(user: CurrentUser, bind: DbBind) -> UserSessionFactory:
    """Opens a fresh, committed-on-exit user session on each call.

    For routes that must not hold a transaction across a slow call (the model
    in ``POST /explain``, spec 008 rule 21): read in one session, call with
    none open, write in another.
    """
    claims = dict(user.claims)
    return lambda: user_session(claims, bind=bind)


UserSessions = Annotated[UserSessionFactory, Depends(get_user_session_factory)]


@lru_cache(maxsize=1)
def _process_gateway() -> Gateway:
    # One client per process: the SDK keeps a connection pool.
    return get_gateway(get_settings())


GatewayFactory = Callable[[], Gateway]


def get_llm_gateway(settings: SettingsDep, bind: DbBind) -> GatewayFactory:
    """Builds the model gateway when called; 503 ``llm_unavailable`` when it is
    not configured.

    Lazy, so a route answers what needs no model (a 404, a stored result) even
    when the model is not configured. Production binds the process engine and
    shares one gateway; tests bind their transaction's connection, so their
    gateway writes its ledger there.
    """

    def build() -> Gateway:
        try:
            if isinstance(bind, Engine):
                return _process_gateway()
            return get_gateway(settings, bind=bind)
        except LLMNotConfigured as exc:
            logger.error("the LLM gateway is not configured: %s", exc)
            raise AppError(
                "Explanations are not available right now",
                code="llm_unavailable",
                status_code=503,
            ) from exc

    return build


LlmGateway = Annotated[GatewayFactory, Depends(get_llm_gateway)]


def get_now() -> dt.datetime:
    """The request's clock (UTC); tests override it to freeze time."""
    return dt.datetime.now(dt.UTC)


Now = Annotated[dt.datetime, Depends(get_now)]


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


def get_queue_bind() -> Engine | Connection | None:
    """What the worker check reads on: None is the privileged engine
    (``jobs/queue.py``); tests override it with their transaction's connection."""
    return None


def worker_state(
    bind: Annotated[Engine | Connection | None, Depends(get_queue_bind)],
) -> scheduler.WorkerStatus:
    """``ok`` or ``stale`` (spec 002 rule 38); never an error, so /health stays 200."""
    try:
        return scheduler.worker_status(bind=bind)
    except (SQLAlchemyError, DatabaseNotConfigured) as exc:
        logger.warning("health check could not read the worker's activity: %s", exc)
        return "stale"


def get_service_session(bind: DbBind) -> Iterator[Session]:
    """A session as ``app_api`` with no user: only granted functions work."""
    with service_session(bind=bind) as session:
        yield session


ServiceSession = Annotated[Session, Depends(get_service_session, scope="function")]


# ---------------------------------------------------------------- Plaid


def _plaid_unavailable(message: str) -> AppError:
    return AppError(message, code="plaid_unavailable", status_code=503)


@lru_cache(maxsize=1)
def _plaid_client() -> PlaidClient:
    return PlaidClient.from_settings(get_settings())


def get_plaid_client() -> PlaidLinking:
    """The process-wide Plaid client; 503 when Plaid is not configured."""
    try:
        return _plaid_client()
    except PlaidNotConfigured as exc:
        logger.error("plaid is not configured: %s", exc)
        raise _plaid_unavailable("Bank linking is not configured") from exc


PlaidDep = Annotated[PlaidLinking, Depends(get_plaid_client)]


def get_token_cipher(settings: SettingsDep) -> TokenCipher:
    try:
        return cipher_from_settings(settings)
    except TokenCipherNotConfigured as exc:
        logger.error("token encryption is not configured: %s", exc)
        raise _plaid_unavailable("Bank linking is not configured") from exc


CipherDep = Annotated[TokenCipher, Depends(get_token_cipher)]

# One verification-key cache per Plaid client, so keys survive across requests.
_key_caches: weakref.WeakKeyDictionary[PlaidLinking, WebhookKeyCache] = weakref.WeakKeyDictionary()
_key_caches_lock = threading.Lock()


def get_webhook_keys(plaid: PlaidDep) -> WebhookKeyCache:
    with _key_caches_lock:
        cache = _key_caches.get(plaid)
        if cache is None:
            cache = WebhookKeyCache(plaid.webhook_verification_key_get)
            _key_caches[plaid] = cache
        return cache


WebhookKeys = Annotated[WebhookKeyCache, Depends(get_webhook_keys)]


def sandbox_linking_allowed(settings: SettingsDep) -> bool:
    """``POST /sync/items`` accepts ``sandbox_institution_id`` outside production."""
    return settings.app_env != "production"


SandboxAllowed = Annotated[bool, Depends(sandbox_linking_allowed)]


async def get_raw_body(request: Request) -> bytes:
    """The exact request bytes (the webhook signature covers them)."""
    return await request.body()


RawBody = Annotated[bytes, Depends(get_raw_body)]
