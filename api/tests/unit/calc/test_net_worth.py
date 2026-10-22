"""calc/net_worth.py: net worth by month and newest holdings (spec 015 rules 20-21)."""

from __future__ import annotations

import datetime as dt
import uuid
from decimal import Decimal

from hypothesis import given
from hypothesis import strategies as st

from calc.net_worth import (
    KINDS,
    HoldingsAccount,
    NetWorthAccount,
    Position,
    Snapshot,
    holdings,
    months_ending,
    net_worth,
    side_of,
)
from db.enums import AccountKind

CHECKING, SAVINGS, CREDIT, RETIREMENT, BROKERAGE, LOAN = (uuid.UUID(int=n) for n in range(1, 7))
TODAY = dt.date(2026, 11, 16)

ACCOUNTS = [
    NetWorthAccount(account_id=CHECKING, kind="checking"),
    NetWorthAccount(account_id=SAVINGS, kind="savings"),
    NetWorthAccount(account_id=CREDIT, kind="credit"),
    NetWorthAccount(account_id=RETIREMENT, kind="retirement"),
]


def snap(account: uuid.UUID, day: str, cents: int) -> Snapshot:
    return Snapshot(account_id=account, as_of=dt.date.fromisoformat(day), balance_cents=cents)


SNAPSHOTS = [
    snap(CHECKING, "2026-09-20", 250_000),
    snap(CHECKING, "2026-10-20", 280_000),
    snap(CHECKING, "2026-11-15", 312_044),
    snap(SAVINGS, "2026-09-20", 200_000),
    snap(SAVINGS, "2026-10-20", 230_000),
    snap(SAVINGS, "2026-11-15", 274_000),
    snap(CREDIT, "2026-10-20", 45_000),
    snap(CREDIT, "2026-11-15", 60_000),
    snap(RETIREMENT, "2026-11-15", 21_710),
]


def test_months_ending_counts_back_from_the_current_month() -> None:
    assert months_ending(TODAY, 3) == [
        dt.date(2026, 9, 1),
        dt.date(2026, 10, 1),
        dt.date(2026, 11, 1),
    ]
    assert months_ending(dt.date(2026, 2, 3), 3)[0] == dt.date(2025, 12, 1)


def test_net_worth_by_month() -> None:
    # Spec 015 route row 5.
    result = net_worth(ACCOUNTS, SNAPSHOTS, today=TODAY, months=3)

    assert [(p.month.isoformat(), p.net_worth_cents) for p in result.series] == [
        ("2026-09-01", 450_000),
        ("2026-10-01", 465_000),
        ("2026-11-01", 547_754),
    ]
    assert [p.as_of.isoformat() for p in result.series] == [
        "2026-09-30",
        "2026-10-31",
        "2026-11-16",
    ]
    assert result.series[1].liabilities_cents == 45_000
    assert (result.assets_cents, result.liabilities_cents, result.net_worth_cents) == (
        607_754,
        60_000,
        547_754,
    )
    assert result.change_cents == 97_754
    assert result.as_of == dt.date(2026, 11, 15)
    assert [(k.kind, k.side, k.total_cents) for k in result.by_kind] == [
        ("checking", "asset", 312_044),
        ("savings", "asset", 274_000),
        ("credit", "liability", 60_000),
        ("retirement", "asset", 21_710),
    ]
    assert {a.account_id: a.balance_cents for a in result.accounts}[CREDIT] == 60_000


def test_net_worth_counts_a_loan_as_owed() -> None:
    # Spec 015 route row 12: row 5 plus a student loan.
    accounts = [*ACCOUNTS, NetWorthAccount(account_id=LOAN, kind="loan")]
    snapshots = [
        *SNAPSHOTS,
        snap(LOAN, "2026-10-20", 1_210_000),
        snap(LOAN, "2026-11-15", 1_200_000),
    ]

    result = net_worth(accounts, snapshots, today=TODAY, months=3)

    assert [(p.month.isoformat(), p.net_worth_cents) for p in result.series] == [
        ("2026-09-01", 450_000),
        ("2026-10-01", -745_000),
        ("2026-11-01", -652_246),
    ]
    assert result.change_cents == -1_102_246
    assert (result.assets_cents, result.liabilities_cents, result.net_worth_cents) == (
        607_754,
        1_260_000,
        -652_246,
    )
    loan = next(a for a in result.accounts if a.account_id == LOAN)
    assert (loan.kind, loan.side, loan.balance_cents) == ("loan", "liability", 1_200_000)
    assert [(k.kind, k.side, k.total_cents) for k in result.by_kind] == [
        ("checking", "asset", 312_044),
        ("savings", "asset", 274_000),
        ("credit", "liability", 60_000),
        ("loan", "liability", 1_200_000),
        ("retirement", "asset", 21_710),
    ]


def test_every_kind_has_a_side() -> None:
    assert {kind: side_of(kind) for kind in KINDS} == {
        "checking": "asset",
        "savings": "asset",
        "credit": "liability",
        "loan": "liability",
        "investment": "asset",
        "retirement": "asset",
    }


def test_kinds_follow_the_account_kind_enum() -> None:
    # by_kind is in account_kind order (spec 015), and every stored kind needs a side.
    assert list(KINDS) == [kind.value for kind in AccountKind]


def test_months_before_any_snapshot_are_left_out() -> None:
    result = net_worth(ACCOUNTS, SNAPSHOTS, today=TODAY, months=5)
    assert result.series[0].month == dt.date(2026, 9, 1)
    assert len(result.series) == 3


def test_no_snapshots() -> None:
    result = net_worth(ACCOUNTS, [], today=TODAY, months=12)
    assert result.series == []
    assert result.as_of is None
    assert result.change_cents is None
    assert (result.assets_cents, result.liabilities_cents, result.net_worth_cents) == (0, 0, 0)
    assert result.by_kind == []
    assert result.accounts == []


def test_a_single_point_has_no_change() -> None:
    result = net_worth(ACCOUNTS, SNAPSHOTS, today=TODAY, months=1)
    assert len(result.series) == 1
    assert result.change_cents is None


def test_snapshots_of_unknown_accounts_are_ignored() -> None:
    stray = snap(uuid.UUID(int=99), "2026-11-01", 1_000_000)
    result = net_worth(ACCOUNTS, [*SNAPSHOTS, stray], today=TODAY, months=3)
    assert result.net_worth_cents == 547_754


def test_a_snapshot_after_today_is_not_counted_yet() -> None:
    later = snap(CHECKING, "2026-11-20", 999_999)
    result = net_worth(ACCOUNTS, [*SNAPSHOTS, later], today=TODAY, months=1)
    assert result.net_worth_cents == 547_754


@given(st.lists(st.integers(min_value=-(10**9), max_value=10**9), min_size=1, max_size=6))
def test_net_worth_is_assets_minus_liabilities(balances: list[int]) -> None:
    accounts = [
        NetWorthAccount(account_id=uuid.UUID(int=i + 1), kind=("credit" if i % 2 else "checking"))
        for i in range(len(balances))
    ]
    snapshots = [
        Snapshot(account_id=uuid.UUID(int=i + 1), as_of=TODAY, balance_cents=b)
        for i, b in enumerate(balances)
    ]
    result = net_worth(accounts, snapshots, today=TODAY, months=1)
    assert result.net_worth_cents == result.assets_cents - result.liabilities_cents
    assert result.series[-1].net_worth_cents == result.net_worth_cents


def position(
    security: str, value: int, basis: int | None, day: str = "2026-11-15", name: str | None = None
) -> Position:
    return Position(
        security_id=security,
        name=name or security,
        ticker=security.upper(),
        quantity=Decimal("1"),
        value_cents=value,
        cost_basis_cents=basis,
        as_of=dt.date.fromisoformat(day),
    )


def test_holdings_newest_per_account() -> None:
    # Spec 015 route row 6.
    result = holdings(
        [
            HoldingsAccount(
                account_id=RETIREMENT,
                positions=[
                    position("vsvnx", 21_710, 21_668),
                    position("vsvnx", 20_000, 21_000, day="2026-11-14"),
                ],
            ),
            HoldingsAccount(
                account_id=BROKERAGE,
                positions=[position("vxus", 30_000, None), position("vti", 98_000, 90_000)],
            ),
            HoldingsAccount(account_id=CHECKING, positions=[]),
        ]
    )

    retirement, brokerage = result.accounts
    assert (retirement.as_of, retirement.value_cents, retirement.cost_basis_cents) == (
        dt.date(2026, 11, 15),
        21_710,
        21_668,
    )
    assert retirement.gain_cents == 42
    assert len(retirement.holdings) == 1
    assert [h.security_id for h in brokerage.holdings] == ["vti", "vxus"]
    assert [h.gain_cents for h in brokerage.holdings] == [8_000, None]
    assert (brokerage.value_cents, brokerage.cost_basis_cents, brokerage.gain_cents) == (
        128_000,
        None,
        None,
    )
    assert (result.value_cents, result.cost_basis_cents, result.gain_cents) == (149_710, None, None)


def test_holdings_totals_with_every_basis_known() -> None:
    result = holdings([HoldingsAccount(account_id=RETIREMENT, positions=[position("a", 100, 80)])])
    assert (result.value_cents, result.cost_basis_cents, result.gain_cents) == (100, 80, 20)


def test_equal_values_order_by_name() -> None:
    result = holdings(
        [
            HoldingsAccount(
                account_id=RETIREMENT,
                positions=[position("b", 100, 1, name="Beta"), position("a", 100, 1, name="Alpha")],
            )
        ]
    )
    assert [h.name for h in result.accounts[0].holdings] == ["Alpha", "Beta"]


def test_no_holdings() -> None:
    result = holdings([])
    assert (result.accounts, result.value_cents, result.cost_basis_cents) == ([], 0, 0)
    assert result.gain_cents == 0
