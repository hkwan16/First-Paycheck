"""The user's linked accounts with their latest balances (spec 002 rules 30-31)."""

from __future__ import annotations

import datetime as dt
import uuid

from fastapi import APIRouter
from pydantic import BaseModel, ConfigDict
from sqlalchemy import Select, select, true, update

from app.deps import UserSession
from app.errors import NotFound, error_responses
from app.types import UtcDateTime
from db.enums import AccountKind, AccountRole
from db.models import Account, BalanceSnapshot, SyncItem

router = APIRouter(prefix="/accounts", tags=["accounts"])


class AccountOut(BaseModel):
    id: uuid.UUID
    sync_item_id: uuid.UUID
    institution_name: str | None
    name: str
    kind: AccountKind
    mask: str | None
    role: AccountRole | None
    is_active: bool
    # The latest balance snapshot; null before the first sync.
    balance_cents: int | None
    balance_as_of: UtcDateTime | None


class AccountPatch(BaseModel):
    """Omitted fields are unchanged; ``role: null`` clears the role."""

    model_config = ConfigDict(extra="forbid")

    role: AccountRole | None = None
    is_active: bool = True


def _accounts_query() -> Select[Account, str | None, int | None, dt.datetime | None]:
    latest = (
        select(BalanceSnapshot.balance_cents, BalanceSnapshot.as_of)
        .where(BalanceSnapshot.account_id == Account.id)
        .order_by(BalanceSnapshot.as_of.desc())
        .limit(1)
        .lateral("latest")
    )
    return (
        select(Account, SyncItem.institution_name, latest.c.balance_cents, latest.c.as_of)
        .join(SyncItem, SyncItem.id == Account.sync_item_id)
        .outerjoin(latest, true())
        .order_by(SyncItem.institution_name.nulls_last(), Account.name, Account.id)
    )


def _out(
    account: Account,
    institution_name: str | None,
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
