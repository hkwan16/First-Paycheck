"""Net worth by month and the newest investment holdings (spec 015 rules 20-21).

The routes read the user's active accounts, balance snapshots and holdings
under RLS; every sum comes from the pure ``calc/net_worth.py``.
"""

from __future__ import annotations

import datetime as dt
import uuid
from typing import Annotated

from fastapi import APIRouter, Query
from pydantic import BaseModel
from sqlalchemy import func, select, tuple_
from sqlalchemy.dialects.postgresql import distinct_on
from sqlalchemy.orm import Session

from app.deps import Now, UserSession
from app.errors import error_responses
from calc.net_worth import (
    AccountHoldings,
    HoldingsAccount,
    KindTotal,
    NetWorthAccount,
    NetWorthPoint,
    Position,
    Side,
    Snapshot,
    holdings,
    months_ending,
    net_worth,
)
from checkin.facts import utc_date
from db.enums import AccountKind, AccountRole
from db.models import Account, BalanceSnapshot, Holding, SyncItem

router = APIRouter(tags=["net worth"])

MAX_MONTHS = 60


class AccountBalanceOut(BaseModel):
    account_id: uuid.UUID
    name: str
    mask: str | None
    kind: AccountKind
    role: AccountRole | None
    institution_name: str | None
    side: Side
    # Money held, or for a credit account the amount owed.
    balance_cents: int
    balance_as_of: dt.date


class NetWorthOut(BaseModel):
    # The date of the newest snapshot counted; null with none.
    as_of: dt.date | None
    assets_cents: int
    liabilities_cents: int
    net_worth_cents: int
    # The last month's net worth minus the first's; null with fewer than two months.
    change_cents: int | None
    accounts: list[AccountBalanceOut]
    by_kind: list[KindTotal]
    # One point per month with data, oldest first.
    series: list[NetWorthPoint]


class AccountHoldingsOut(AccountHoldings):
    name: str
    mask: str | None
    kind: AccountKind


class HoldingsOut(BaseModel):
    accounts: list[AccountHoldingsOut]
    value_cents: int
    # Null when any holding lacks a cost basis.
    cost_basis_cents: int | None
    gain_cents: int | None


def _snapshots(session: Session, account_ids: list[uuid.UUID], since: dt.date) -> list[Snapshot]:
    """Snapshots from ``since`` on, plus each account's newest one before it."""
    start = dt.datetime.combine(since, dt.time(), tzinfo=dt.UTC)
    in_window = session.execute(
        select(
            BalanceSnapshot.account_id, BalanceSnapshot.as_of, BalanceSnapshot.balance_cents
        ).where(BalanceSnapshot.account_id.in_(account_ids), BalanceSnapshot.as_of >= start)
    ).all()
    before = session.execute(
        select(BalanceSnapshot.account_id, BalanceSnapshot.as_of, BalanceSnapshot.balance_cents)
        .ext(distinct_on(BalanceSnapshot.account_id))
        .where(BalanceSnapshot.account_id.in_(account_ids), BalanceSnapshot.as_of < start)
        .order_by(BalanceSnapshot.account_id, BalanceSnapshot.as_of.desc())
    ).all()
    return [
        Snapshot(account_id=account_id, as_of=utc_date(as_of), balance_cents=cents)
        for account_id, as_of, cents in [*before, *in_window]
    ]


@router.get("/net-worth", responses=error_responses(401, 422))
def get_net_worth(
    session: UserSession,
    now: Now,
    months: Annotated[
        int, Query(ge=1, le=MAX_MONTHS, description="Months in the series, ending this month")
    ] = 12,
) -> NetWorthOut:
    """Assets minus liabilities now and at the end of each month, from balance snapshots."""
    today = now.date()
    rows = session.execute(
        select(Account, SyncItem.institution_name)
        .join(
            SyncItem,
            (SyncItem.id == Account.sync_item_id) & (SyncItem.user_id == Account.user_id),
        )
        .where(Account.is_active.is_(True))
        .order_by(Account.name, Account.id)
    ).all()
    accounts = {account.id: (account, institution) for account, institution in rows}
    result = net_worth(
        [NetWorthAccount(account_id=a.id, kind=a.kind.value) for a, _ in accounts.values()],
        _snapshots(session, list(accounts), months_ending(today, months)[0]),
        today=today,
        months=months,
    )
    return NetWorthOut(
        as_of=result.as_of,
        assets_cents=result.assets_cents,
        liabilities_cents=result.liabilities_cents,
        net_worth_cents=result.net_worth_cents,
        change_cents=result.change_cents,
        accounts=[
            AccountBalanceOut(
                account_id=balance.account_id,
                name=accounts[balance.account_id][0].name,
                mask=accounts[balance.account_id][0].mask,
                kind=accounts[balance.account_id][0].kind,
                role=accounts[balance.account_id][0].role,
                institution_name=accounts[balance.account_id][1],
                side=balance.side,
                balance_cents=balance.balance_cents,
                balance_as_of=balance.balance_as_of,
            )
            for balance in result.accounts
        ],
        by_kind=result.by_kind,
        series=result.series,
    )


@router.get("/holdings", responses=error_responses(401))
def get_holdings(session: UserSession) -> HoldingsOut:
    """The newest holdings of each investment and retirement account, with gains."""
    accounts = list(
        session.scalars(
            select(Account)
            .where(
                Account.is_active.is_(True),
                Account.kind.in_((AccountKind.INVESTMENT, AccountKind.RETIREMENT)),
            )
            .order_by(Account.name, Account.id)
        )
    )
    newest = (
        select(Holding.account_id, func.max(Holding.as_of))
        .where(Holding.account_id.in_([a.id for a in accounts]))
        .group_by(Holding.account_id)
    )
    positions: dict[uuid.UUID, list[Position]] = {account.id: [] for account in accounts}
    for row in session.scalars(
        select(Holding).where(tuple_(Holding.account_id, Holding.as_of).in_(newest))
    ):
        positions[row.account_id].append(
            Position(
                security_id=row.security_id,
                name=row.name,
                ticker=row.ticker,
                quantity=row.quantity,
                value_cents=row.value_cents,
                cost_basis_cents=row.cost_basis_cents,
                as_of=row.as_of,
            )
        )
    result = holdings(
        [HoldingsAccount(account_id=a.id, positions=positions[a.id]) for a in accounts]
    )
    by_id = {account.id: account for account in accounts}
    return HoldingsOut(
        accounts=[
            AccountHoldingsOut(
                **summary.model_dump(),
                name=by_id[summary.account_id].name,
                mask=by_id[summary.account_id].mask,
                kind=by_id[summary.account_id].kind,
            )
            for summary in result.accounts
        ],
        value_cents=result.value_cents,
        cost_basis_cents=result.cost_basis_cents,
        gain_cents=result.gain_cents,
    )
