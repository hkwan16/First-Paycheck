"""Spec 007 rule 21a: every account kind is either read by the spending summary
or skipped as a ledger, never both and never neither."""

from __future__ import annotations

from app.routers.spending import LEDGER_ACCOUNT_KINDS, SPENDING_ACCOUNT_KINDS
from db.enums import AccountKind


def test_every_kind_is_in_exactly_one_set() -> None:
    assert set(SPENDING_ACCOUNT_KINDS).isdisjoint(LEDGER_ACCOUNT_KINDS)
    assert set(SPENDING_ACCOUNT_KINDS) | set(LEDGER_ACCOUNT_KINDS) == set(AccountKind)


def test_the_sets_are_the_specs() -> None:
    assert SPENDING_ACCOUNT_KINDS == (AccountKind.CHECKING, AccountKind.SAVINGS, AccountKind.CREDIT)
    assert LEDGER_ACCOUNT_KINDS == (
        AccountKind.LOAN,
        AccountKind.INVESTMENT,
        AccountKind.RETIREMENT,
    )
