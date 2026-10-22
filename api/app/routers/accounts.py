"""The user's accounts with their latest balances (spec 002 rules 30-31) and CSV
imports (spec 010 part B)."""

from __future__ import annotations

import dataclasses
import datetime as dt
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Annotated

from fastapi import APIRouter, File, Form, UploadFile
from pydantic import BaseModel, ConfigDict
from sqlalchemy import Select, select, true, update
from sqlalchemy.orm import Session

from app import ratelimit
from app.auth import CurrentUser
from app.deps import Now, UserSession
from app.errors import AppError, NotFound, error_responses
from app.types import UtcDateTime
from db.enums import AccountKind, AccountRole, JobKind, SyncProvider
from db.models import Account, BalanceSnapshot, SyncItem
from jobs import queue
from sync.csv_provider import (
    PROVIDER_ACCOUNT_ID,
    AmountSign,
    CsvInvalid,
    CsvProvider,
    parse_csv,
)
from sync.pipeline import SyncItemSecrets, run_sync

router = APIRouter(prefix="/accounts", tags=["accounts"])

MAX_IMPORT_BYTES = 10 * 1024 * 1024
# Room for the multipart boundaries and the form fields around the file.
MULTIPART_OVERHEAD_BYTES = 64 * 1024


class AccountOut(BaseModel):
    id: uuid.UUID
    sync_item_id: uuid.UUID
    institution_name: str | None
    name: str
    kind: AccountKind
    mask: str | None
    role: AccountRole | None
    is_active: bool
    # The account's sync item's provider: only a Plaid item syncs on demand.
    provider: SyncProvider
    # The latest balance snapshot; null before the first sync.
    balance_cents: int | None
    balance_as_of: UtcDateTime | None


class AccountPatch(BaseModel):
    """Omitted fields are unchanged; ``role: null`` clears the role."""

    model_config = ConfigDict(extra="forbid")

    role: AccountRole | None = None
    is_active: bool = True


def _accounts_query() -> Select[Account, str | None, SyncProvider, int | None, dt.datetime | None]:
    latest = (
        select(BalanceSnapshot.balance_cents, BalanceSnapshot.as_of)
        .where(BalanceSnapshot.account_id == Account.id)
        .order_by(BalanceSnapshot.as_of.desc())
        .limit(1)
        .lateral("latest")
    )
    return (
        select(
            Account,
            SyncItem.institution_name,
            SyncItem.provider,
            latest.c.balance_cents,
            latest.c.as_of,
        )
        .join(SyncItem, SyncItem.id == Account.sync_item_id)
        .outerjoin(latest, true())
        .order_by(SyncItem.institution_name.nulls_last(), Account.name, Account.id)
    )


def _out(
    account: Account,
    institution_name: str | None,
    provider: SyncProvider,
    balance_cents: int | None,
    balance_as_of: dt.datetime | None,
) -> AccountOut:
    return AccountOut(
        id=account.id,
        sync_item_id=account.sync_item_id,
        institution_name=institution_name,
        name=account.name,
        kind=account.kind,
        mask=account.mask,
        role=account.role,
        is_active=account.is_active,
        provider=provider,
        balance_cents=balance_cents,
        balance_as_of=balance_as_of,
    )


@router.get("", responses=error_responses(401))
def list_accounts(session: UserSession) -> list[AccountOut]:
    """Every linked account, by institution then name, with its latest balance."""
    return [_out(*row) for row in session.execute(_accounts_query())]


@router.patch("/{account_id}", responses=error_responses(401, 404, 422))
def update_account(account_id: uuid.UUID, body: AccountPatch, session: UserSession) -> AccountOut:
    """Set an account's role or active flag. Making an account the emergency
    fund takes the role from the user's previous one."""
    account = session.get(Account, account_id)
    if account is None:
        raise NotFound("Account not found")
    if "role" in body.model_fields_set:
        if body.role is AccountRole.EMERGENCY_FUND:
            session.execute(
                update(Account)
                .where(
                    Account.user_id == account.user_id,
                    Account.role == AccountRole.EMERGENCY_FUND,
                    Account.id != account.id,
                )
                .values(role=None)
                .execution_options(synchronize_session=False)
            )
        account.role = body.role
    if "is_active" in body.model_fields_set:
        account.is_active = body.is_active
    session.flush()
    row = session.execute(_accounts_query().where(Account.id == account.id)).one()
    return _out(*row)


class CsvImport(BaseModel):
    account: AccountOut
    # Data rows written, new or updated.
    imported: int
    # The queued follow-up jobs, for the client to poll.
    categorize_job_id: uuid.UUID
    recurring_job_id: uuid.UUID


def _invalid(message: str) -> AppError:
    return AppError(message, code="validation_error", status_code=422)


@contextmanager
def _same_session(session: Session) -> Iterator[Session]:
    """The request's session, for ``run_sync``: the CSV provider makes no network
    call, so the whole import is one transaction (rule 19)."""
    yield session


def _target(
    session: Session,
    user_id: uuid.UUID,
    account_id: uuid.UUID | None,
    kind: AccountKind | None,
    name: str | None,
    institution_name: str | None,
) -> tuple[uuid.UUID, str, AccountKind]:
    """The CSV item to import into, with the account's name and kind (rule 17)."""
    if account_id is not None:
        if kind is not None or name is not None or institution_name is not None:
            raise _invalid("kind, name and institution_name are only for a new account")
        account = session.get(Account, account_id)
        if account is None:
            raise NotFound("Account not found")
        item = session.get(SyncItem, account.sync_item_id)
        if item is None or item.provider is not SyncProvider.CSV:
            raise AppError(
                "Only an account created by a CSV import can take another import",
                code="not_csv_account",
                status_code=422,
            )
        return item.id, account.name, account.kind
    if kind is None:
        raise _invalid("Give kind for a new account, or account_id to add to one")
    display = " ".join((name or "").split())
    if name is not None and not display:
        raise _invalid("name must not be blank")
    item = SyncItem(
        user_id=user_id,
        provider=SyncProvider.CSV,
        institution_name=" ".join((institution_name or "").split()) or None,
    )
    session.add(item)
    session.flush()
    default = f"{kind.value.replace('_', ' ').capitalize()} (CSV)"
    return item.id, display or default, kind


@router.post("/import", responses=error_responses(401, 404, 409, 413, 422, 429))
def import_csv(
    file: Annotated[UploadFile, File(description="A CSV export of at most 10 MB")],
    user: CurrentUser,
    session: UserSession,
    now: Now,
    account_id: Annotated[
        uuid.UUID | None, Form(description="An earlier CSV import's account to add to")
    ] = None,
    kind: Annotated[AccountKind | None, Form(description="For a new account")] = None,
    name: Annotated[str | None, Form(max_length=100, description="For a new account")] = None,
    institution_name: Annotated[
        str | None, Form(max_length=200, description="For a new account")
    ] = None,
    sign: Annotated[
        AmountSign, Form(description="How the amount column is signed")
    ] = AmountSign.NEGATIVE_IS_OUT,
) -> CsvImport:
    """Import a bank's CSV export through the sync pipeline, then queue
    categorization and recurring detection."""
    ratelimit.consume(session, user.id, ratelimit.CSV_IMPORTS, now=now)
    data = file.file.read(MAX_IMPORT_BYTES + 1)
    if len(data) > MAX_IMPORT_BYTES:
        raise AppError("The file is larger than 10 MB", code="file_too_large", status_code=413)
    try:
        parsed = parse_csv(data, sign)
    except CsvInvalid as exc:
        raise AppError(
            str(exc),
            code="csv_invalid",
            status_code=422,
            details={
                "errors": [dataclasses.asdict(problem) for problem in exc.problems],
                "total": exc.total,
            },
        ) from None
    item_id, account_name, account_kind = _target(
        session, user.id, account_id, kind, name, institution_name
    )

    def provider_for(_: SyncItemSecrets) -> CsvProvider:
        return CsvProvider(parsed, name=account_name, kind=account_kind)

    result = run_sync(
        user_id=user.id,
        item_id=item_id,
        sessions=lambda: _same_session(session),
        provider_for=provider_for,
        now=now,
    )
    if result.outcome != "synced":
        raise AppError(
            "Another import into this account finished first; try again",
            code="import_conflict",
            status_code=409,
        )
    # The pipeline queued both; these return its jobs (rule 20).
    categorize_job = queue.enqueue_unless_queued(
        session, user_id=user.id, kind=JobKind.CATEGORIZE_RUN
    )
    recurring_job = queue.enqueue_unless_queued(
        session, user_id=user.id, kind=JobKind.RECURRING_DETECT
    )
    row = session.execute(
        _accounts_query().where(
            Account.sync_item_id == item_id, Account.provider_account_id == PROVIDER_ACCOUNT_ID
        )
    ).one()
    return CsvImport(
        account=_out(*row),
        imported=result.added,
        categorize_job_id=categorize_job,
        recurring_job_id=recurring_job,
    )
