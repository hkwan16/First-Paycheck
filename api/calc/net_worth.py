"""Net worth by month and the newest holdings per account (spec 015 rules 20-21).

Pure: the routes read accounts, balance snapshots and holdings under RLS and
hand them in; every sum is made here so the client never adds money.
Balances follow spec 001 rule 22: depository and investment balances are money
held, a credit or loan balance is the amount owed.
"""

from __future__ import annotations

import datetime as dt
import uuid
from collections import defaultdict
from collections.abc import Iterable, Sequence
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, ConfigDict

__all__ = [
    "KINDS",
    "LIABILITY_KINDS",
    "AccountBalance",
    "AccountHoldings",
    "Holdings",
    "HoldingsAccount",
    "KindTotal",
    "NetWorth",
    "NetWorthAccount",
    "NetWorthPoint",
    "Position",
    "PositionValue",
    "Side",
    "Snapshot",
    "holdings",
    "months_ending",
    "net_worth",
    "side_of",
]

Kind = Literal["checking", "savings", "credit", "loan", "investment", "retirement"]
Side = Literal["asset", "liability"]
# account_kind in its enum order: the order of ``by_kind``.
KINDS: tuple[Kind, ...] = ("checking", "savings", "credit", "loan", "investment", "retirement")
# Kinds whose balance is the amount owed (spec 001 rule 22).
LIABILITY_KINDS: frozenset[Kind] = frozenset({"credit", "loan"})


def side_of(kind: Kind) -> Side:
    return "liability" if kind in LIABILITY_KINDS else "asset"


class NetWorthAccount(BaseModel):
    model_config = ConfigDict(frozen=True)

    account_id: uuid.UUID
    kind: Kind


class Snapshot(BaseModel):
    model_config = ConfigDict(frozen=True)

    account_id: uuid.UUID
    # The snapshot's UTC date.
    as_of: dt.date
    balance_cents: int


class NetWorthPoint(BaseModel):
    model_config = ConfigDict(frozen=True)

    month: dt.date
    # The month's last day, or today for the current month.
    as_of: dt.date
    assets_cents: int
    liabilities_cents: int
    net_worth_cents: int


class KindTotal(BaseModel):
    model_config = ConfigDict(frozen=True)

    kind: Kind
    side: Side
    total_cents: int


class AccountBalance(BaseModel):
    model_config = ConfigDict(frozen=True)

    account_id: uuid.UUID
    kind: Kind
    side: Side
    balance_cents: int
    balance_as_of: dt.date


class NetWorth(BaseModel):
    model_config = ConfigDict(frozen=True)

    as_of: dt.date | None
    assets_cents: int
    liabilities_cents: int
    net_worth_cents: int
    # The last point's net worth minus the first's; null with fewer than two points.
    change_cents: int | None
    accounts: list[AccountBalance]
    by_kind: list[KindTotal]
    series: list[NetWorthPoint]


def _month_index(day: dt.date) -> int:
    return day.year * 12 + day.month - 1


def _first_of(index: int) -> dt.date:
    return dt.date(index // 12, index % 12 + 1, 1)


def months_ending(today: dt.date, months: int) -> list[dt.date]:
    """The first days of ``months`` calendar months ending with ``today``'s, oldest first."""
    if months < 1:
        raise ValueError(f"months must be at least 1, not {months}")
    last = _month_index(today)
    return [_first_of(index) for index in range(last - months + 1, last + 1)]


def _month_end(month: dt.date) -> dt.date:
    return _first_of(_month_index(month) + 1) - dt.timedelta(days=1)


def _balances_at(
    accounts: Sequence[NetWorthAccount],
    history: dict[uuid.UUID, list[Snapshot]],
    cutoff: dt.date,
) -> list[AccountBalance]:
    """Each account's newest snapshot on or before ``cutoff``; none before its first."""
    found: list[AccountBalance] = []
    for account in accounts:
        known = [s for s in history.get(account.account_id, []) if s.as_of <= cutoff]
        if not known:
            continue
        newest = known[-1]
        found.append(
            AccountBalance(
                account_id=account.account_id,
                kind=account.kind,
                side=side_of(account.kind),
                balance_cents=newest.balance_cents,
                balance_as_of=newest.as_of,
            )
        )
    return found


def _totals(balances: Iterable[AccountBalance]) -> tuple[int, int]:
    assets = liabilities = 0
    for balance in balances:
        if balance.side == "asset":
            assets += balance.balance_cents
        else:
            liabilities += balance.balance_cents
    return assets, liabilities


def net_worth(
    accounts: Sequence[NetWorthAccount],
    snapshots: Iterable[Snapshot],
    *,
    today: dt.date,
    months: int,
) -> NetWorth:
    """Rule 20: assets minus liabilities, now and at the end of each of ``months`` months."""
    known = {account.account_id for account in accounts}
    history: dict[uuid.UUID, list[Snapshot]] = defaultdict(list)
    for snapshot in sorted(snapshots, key=lambda s: (s.as_of, s.balance_cents)):
        if snapshot.account_id in known:
            history[snapshot.account_id].append(snapshot)

    series: list[NetWorthPoint] = []
    for month in months_ending(today, months):
        cutoff = min(_month_end(month), today)
        balances = _balances_at(accounts, history, cutoff)
        if not balances:
            continue
        assets, liabilities = _totals(balances)
        series.append(
            NetWorthPoint(
                month=month,
                as_of=cutoff,
                assets_cents=assets,
                liabilities_cents=liabilities,
                net_worth_cents=assets - liabilities,
            )
        )

    current = _balances_at(accounts, history, today)
    assets, liabilities = _totals(current)
    by_kind: dict[Kind, int] = defaultdict(int)
    for balance in current:
        by_kind[balance.kind] += balance.balance_cents
    return NetWorth(
        as_of=max((b.balance_as_of for b in current), default=None),
        assets_cents=assets,
        liabilities_cents=liabilities,
        net_worth_cents=assets - liabilities,
        change_cents=(
            series[-1].net_worth_cents - series[0].net_worth_cents if len(series) >= 2 else None
        ),
        accounts=current,
        by_kind=[
            KindTotal(kind=kind, side=side_of(kind), total_cents=by_kind[kind])
            for kind in KINDS
            if kind in by_kind
        ],
        series=series,
    )


# ---------------------------------------------------------------- holdings


class Position(BaseModel):
    model_config = ConfigDict(frozen=True)

    security_id: str
    name: str
    ticker: str | None
    # Shares, not money.
    quantity: Decimal
    value_cents: int
    cost_basis_cents: int | None
    as_of: dt.date


class HoldingsAccount(BaseModel):
    model_config = ConfigDict(frozen=True)

    account_id: uuid.UUID
    positions: list[Position]


class PositionValue(BaseModel):
    model_config = ConfigDict(frozen=True)

    security_id: str
    name: str
    ticker: str | None
    quantity: Decimal
    value_cents: int
    cost_basis_cents: int | None
    # Value minus cost basis; null without a basis.
    gain_cents: int | None


class AccountHoldings(BaseModel):
    model_config = ConfigDict(frozen=True)

    account_id: uuid.UUID
    as_of: dt.date
    value_cents: int
    # Null when any holding in the account lacks a basis.
    cost_basis_cents: int | None
    gain_cents: int | None
    holdings: list[PositionValue]


class Holdings(BaseModel):
    model_config = ConfigDict(frozen=True)

    accounts: list[AccountHoldings]
    value_cents: int
    cost_basis_cents: int | None
    gain_cents: int | None


def _basis_total(bases: Sequence[int | None]) -> int | None:
    known = [basis for basis in bases if basis is not None]
    return sum(known) if len(known) == len(bases) else None


def _gain(value: int, basis: int | None) -> int | None:
    return None if basis is None else value - basis


def holdings(accounts: Sequence[HoldingsAccount]) -> Holdings:
    """Rule 21: each account's holdings on its newest date, with gains where the basis is known."""
    out: list[AccountHoldings] = []
    for account in accounts:
        if not account.positions:
            continue
        newest = max(position.as_of for position in account.positions)
        current = sorted(
            (p for p in account.positions if p.as_of == newest),
            key=lambda p: (-p.value_cents, p.name, p.security_id),
        )
        value = sum(p.value_cents for p in current)
        basis = _basis_total([p.cost_basis_cents for p in current])
        out.append(
            AccountHoldings(
                account_id=account.account_id,
                as_of=newest,
                value_cents=value,
                cost_basis_cents=basis,
                gain_cents=_gain(value, basis),
                holdings=[
                    PositionValue(
                        security_id=p.security_id,
                        name=p.name,
                        ticker=p.ticker,
                        quantity=p.quantity,
                        value_cents=p.value_cents,
                        cost_basis_cents=p.cost_basis_cents,
                        gain_cents=_gain(p.value_cents, p.cost_basis_cents),
                    )
                    for p in current
                ],
            )
        )
    value = sum(account.value_cents for account in out)
    basis = _basis_total([account.cost_basis_cents for account in out])
    return Holdings(
        accounts=out, value_cents=value, cost_basis_cents=basis, gain_cents=_gain(value, basis)
    )
