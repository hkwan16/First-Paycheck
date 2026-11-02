"""Which accounts count as the user's cash (spec 007 rule 21a).

The spending summary, recurring detection (spec 009 rule 1a) and the
Spending screen's transaction list (spec 003 rule 17) read the accounts money
is spent from and saved in. A loan, investment or retirement account's rows
are that account's own bookkeeping (a loan books the payment that left
checking as money in, and accrued interest as money out), so they are
skipped. Every ``AccountKind`` is in exactly one of the two sets, in
``AccountKind`` order.
"""

from __future__ import annotations

from sqlalchemy import ColumnElement

from db.enums import AccountKind
from db.models import Account, Transaction

__all__ = [
    "LEDGER_ACCOUNT_KINDS",
    "SPENDING_ACCOUNT_KINDS",
    "active_account_of",
    "transaction_account",
]

SPENDING_ACCOUNT_KINDS: tuple[AccountKind, ...] = (
    AccountKind.CHECKING,
    AccountKind.SAVINGS,
    AccountKind.CREDIT,
)
LEDGER_ACCOUNT_KINDS: tuple[AccountKind, ...] = (
    AccountKind.LOAN,
    AccountKind.INVESTMENT,
    AccountKind.RETIREMENT,
)


def transaction_account() -> ColumnElement[bool]:
    """The join of a transaction to its own account (same user)."""
    return (Account.id == Transaction.account_id) & (Account.user_id == Transaction.user_id)


def active_account_of(kinds: tuple[AccountKind, ...]) -> ColumnElement[bool]:
    """The joined account is active and of one of ``kinds``."""
    return Account.is_active.is_(True) & Account.kind.in_(kinds)
