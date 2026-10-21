"""Linking institutions through Plaid, unlinking, manual syncs and the webhook (spec 002)."""

from __future__ import annotations

import json
import logging
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Header, Response, status
from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy import select, text
from sqlalchemy.dialects.postgresql import insert

from app.auth import CurrentUser
from app.deps import (
    CipherDep,
    PlaidDep,
    RawBody,
    SandboxAllowed,
    ServiceSession,
    SettingsDep,
    UserSession,
    WebhookKeys,
)
from app.errors import AppError, NotFound, error_responses
from app.types import UtcDateTime
from db.enums import JobKind, SyncProvider, SyncStatus
from db.models import SyncItem
from jobs import queue
from sync.crypto import TokenDecryptError
from sync.plaid.client import PlaidError
from sync.plaid.webhook import WebhookVerificationError, verify_plaid_webhook

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/sync", tags=["sync"])

MAX_WEBHOOK_BYTES = 1_000_000
# Verified webhooks that mean "there is new data to pull" (rule 25).
SYNC_WEBHOOKS = frozenset(
    {
        ("TRANSACTIONS", "SYNC_UPDATES_AVAILABLE"),
        ("TRANSACTIONS", "DEFAULT_UPDATE"),
        ("TRANSACTIONS", "INITIAL_UPDATE"),
        ("TRANSACTIONS", "HISTORICAL_UPDATE"),
        ("HOLDINGS", "DEFAULT_UPDATE"),
        ("INVESTMENTS_TRANSACTIONS", "DEFAULT_UPDATE"),
    }
)
# Plaid errors worth retrying later rather than reporting as a rejection.
_TRANSIENT_ERROR_TYPES = frozenset(
    {"API_ERROR", "RATE_LIMIT_EXCEEDED", "INSTITUTION_ERROR", "NETWORK_ERROR"}
)


class LinkToken(BaseModel):
    link_token: str
    expiration: str


class LinkItemRequest(BaseModel):
    """Exactly one of ``public_token`` (from Plaid Link) or ``sandbox_institution_id``."""

    model_config = ConfigDict(extra="forbid")

    public_token: str | None = Field(default=None, min_length=1, max_length=512)
    sandbox_institution_id: str | None = Field(
        default=None, min_length=1, max_length=64, examples=["ins_109508"]
    )
    institution_name: str | None = Field(default=None, min_length=1, max_length=200)

    @model_validator(mode="after")
    def _exactly_one_source(self) -> LinkItemRequest:
        if (self.public_token is None) == (self.sandbox_institution_id is None):
            raise ValueError("give exactly one of public_token or sandbox_institution_id")
        return self


class SyncItemOut(BaseModel):
    id: uuid.UUID
    provider: SyncProvider
    institution_name: str | None
    status: SyncStatus
    last_synced_at: UtcDateTime | None
    created_at: UtcDateTime


class LinkedItem(BaseModel):
    item: SyncItemOut
    job_id: uuid.UUID


class QueuedJob(BaseModel):
    job_id: uuid.UUID


class WebhookAck(BaseModel):
    status: str = "ok"


def _item_out(item: SyncItem) -> SyncItemOut:
    return SyncItemOut(
        id=item.id,
        provider=item.provider,
        institution_name=item.institution_name,
        status=item.status,
        last_synced_at=item.last_synced_at,
        created_at=item.created_at,
    )


@contextmanager
def _plaid_errors() -> Iterator[None]:
    """Plaid failures as API errors: an outage is 503, a rejection 502."""
    try:
        yield
    except PlaidError as exc:
        logger.warning("plaid call failed: %s", exc)
        if exc.error_type in _TRANSIENT_ERROR_TYPES or (exc.status or 0) >= 500:
            raise AppError(
                "Plaid is unavailable; try again shortly",
                code="plaid_unavailable",
                status_code=503,
            ) from None
        raise AppError(
            f"Plaid rejected the request ({exc.code})", code="plaid_error", status_code=502
        ) from None


def _own_item(session: UserSession, item_id: uuid.UUID) -> SyncItem:
    item = session.get(SyncItem, item_id)
    if item is None:
        raise NotFound("Linked institution not found")
    return item


@router.post("/link-token", responses=error_responses(401, 502, 503))
def create_link_token(user: CurrentUser, plaid: PlaidDep, settings: SettingsDep) -> LinkToken:
    """A Plaid Link token for the signed-in user."""
    with _plaid_errors():
        token = plaid.link_token_create(user_id=str(user.id), webhook=settings.plaid_webhook_url)
    return LinkToken(**token)


@router.post(
    "/items",
    status_code=status.HTTP_201_CREATED,
    responses=error_responses(401, 409, 422, 502, 503),
)
def link_item(
    body: LinkItemRequest,
    user: CurrentUser,
    session: UserSession,
    plaid: PlaidDep,
    cipher: CipherDep,
    settings: SettingsDep,
    sandbox_allowed: SandboxAllowed,
) -> LinkedItem:
    """Exchange a Link public token (or, outside production, create one for a
    sandbox institution), store the encrypted access token and queue the
    initial sync."""
    sandbox_id = body.sandbox_institution_id
    if sandbox_id is not None and not sandbox_allowed:
        raise AppError(
            "sandbox_institution_id is not accepted in production",
            code="validation_error",
            status_code=422,
        )
    institution_name = body.institution_name
    with _plaid_errors():
        if sandbox_id is not None:
            public_token = plaid.sandbox_public_token_create(
                sandbox_id, webhook=settings.plaid_webhook_url
            )
        elif body.public_token is not None:
            public_token = body.public_token
        else:  # LinkItemRequest's validator makes this unreachable.
            raise AppError("public_token is required", code="validation_error", status_code=422)
        access_token, provider_item_id = plaid.item_public_token_exchange(public_token)
        if institution_name is None and sandbox_id is not None:
            institution_name = plaid.institution_name(sandbox_id)

    inserted = session.execute(
        insert(SyncItem)
        .values(
            user_id=user.id,
            provider=SyncProvider.PLAID,
            provider_item_id=provider_item_id,
            institution_name=institution_name,
            access_token_enc=cipher.encrypt(access_token),
        )
        .on_conflict_do_nothing(
            index_elements=[SyncItem.provider, SyncItem.provider_item_id],
            index_where=SyncItem.provider_item_id.is_not(None),
        )
        .returning(SyncItem.id)
    ).scalar()
    if inserted is None:
        raise AppError(
            "This institution is already linked", code="item_already_linked", status_code=409
        )
    item = session.execute(select(SyncItem).where(SyncItem.id == inserted)).scalar_one()
    job_id = queue.enqueue(
        session,
        user_id=user.id,
        kind=JobKind.SYNC_INITIAL,
        payload={"sync_item_id": str(item.id)},
        idempotency_key=f"sync.initial:{item.id}",
    )
    return LinkedItem(item=_item_out(item), job_id=job_id)


@router.delete(
    "/items/{item_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
    responses=error_responses(401, 404, 503),
)
def delete_item(
    item_id: uuid.UUID,
    user: CurrentUser,
    session: UserSession,
    plaid: PlaidDep,
    cipher: CipherDep,
) -> None:
    """Unlink an institution: remove it at Plaid (best effort) and delete it with
    its accounts, transactions, balances and holdings."""
    item = _own_item(session, item_id)
    if item.access_token_enc is not None:
        try:
            plaid.item_remove(cipher.decrypt(item.access_token_enc))
        except (PlaidError, TokenDecryptError) as exc:
            logger.warning("could not remove item %s at Plaid: %s", item.id, exc)
    session.delete(item)
    session.flush()
    # Charges seen only in this item's transactions go on the next run (spec 009 rule 16).
    queue.enqueue_unless_queued(session, user_id=user.id, kind=JobKind.RECURRING_DETECT)


@router.post(
    "/items/{item_id}/sync",
    status_code=status.HTTP_202_ACCEPTED,
    responses=error_responses(401, 404),
)
def sync_item(item_id: uuid.UUID, user: CurrentUser, session: UserSession) -> QueuedJob:
    """Queue an incremental sync, or return the one already waiting."""
    item = _own_item(session, item_id)
    job_id = queue.enqueue_unless_queued(
        session,
        user_id=user.id,
        kind=JobKind.SYNC_INCREMENTAL,
        payload={"sync_item_id": str(item.id)},
    )
    return QueuedJob(job_id=job_id)


def _invalid_webhook(message: str) -> AppError:
    return AppError(message, code="invalid_webhook", status_code=401)


def verified_plaid_webhook(
    body: RawBody,
    keys: WebhookKeys,
    plaid_verification: Annotated[str | None, Header()] = None,
) -> dict[str, Any]:
    """The webhook's JSON body, once its signature checks out (rules 21-24).

    A dependency of the route declared before the database session, so an
    unverified request is refused before any connection is used.
    """
    if len(body) > MAX_WEBHOOK_BYTES:
        raise _invalid_webhook("Webhook body is too large")
    try:
        verify_plaid_webhook(body, plaid_verification, keys)
    except WebhookVerificationError as exc:
        logger.warning("rejected a Plaid webhook: %s", exc)
        raise _invalid_webhook("Webhook signature is invalid") from None
    try:
        payload = json.loads(body)
    except ValueError:
        payload = None
    if not isinstance(payload, dict):
        raise _invalid_webhook("Webhook body is not a JSON object")
    return payload


@router.post("/webhook", include_in_schema=False)
def plaid_webhook(
    payload: Annotated[dict[str, Any], Depends(verified_plaid_webhook)],
    session: ServiceSession,
) -> WebhookAck:
    """Plaid's webhook: queue a sync for update webhooks. Always 200 once
    verified, whether or not the item exists."""
    kind = (payload.get("webhook_type"), payload.get("webhook_code"))
    item_id = payload.get("item_id")
    if kind in SYNC_WEBHOOKS and isinstance(item_id, str) and item_id:
        session.execute(text("SELECT public.enqueue_sync_for_plaid_item(:item)"), {"item": item_id})
    else:
        logger.info("ignored Plaid webhook %s/%s", *kind)
    return WebhookAck()
