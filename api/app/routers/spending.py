"""The spending summary: a month's transactions by bucket (spec 007 part B).

One SQL ``GROUP BY category`` under RLS over the cash accounts (rule 21a);
the roll-up is the pure ``calc.spending.summarize``. Rows on loan, investment
and retirement accounts are counted and summed by a second query and reported
apart. Read-only.
"""

from __future__ import annotations

import datetime as dt
from decimal import Decimal
from typing import Annotated

from fastapi import APIRouter, Query
from pydantic import BaseModel
from sqlalchemy import ColumnElement, case, func, select
from sqlalchemy.orm import Session

from app.deps import Now, UserSession
from app.errors import AppError, error_responses
from calc.spending import Bucket, CategorySum, CategoryTotal, summarize
from db.enums import AccountKind
from db.models import Account, PayStub, Transaction
from sync.categories import CATEGORIES, CATEGORY_BUCKETS

router = APIRouter(prefix="/spending", tags=["spending"])

MAX_SPAN_DAYS = 366
_CATEGORY_ORDER = {category: index for index, category in enumerate(CATEGORIES)}

# Spec 007 rule 21a, in ``AccountKind`` order. The summary reads the accounts
# money is spent from and saved in; a loan, investment or retirement account's
# rows are that account's own bookkeeping (a loan books the payment that left
# checking as money in, and accrued interest as money out), so they are
# skipped and reported as ``ledger_rows_skipped``. Every kind is in one set.
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


class LedgerRowsSkipped(BaseModel):
    """Posted rows in the period on active loan, investment and retirement accounts."""

    count: int
    # Their sum, net, positive is money out (like ``uncategorized_cents``).
    net_cents: int


class SpendingSummary(BaseModel):
    start: dt.date
    end: dt.date
    income_cents: int
    essentials_cents: int
    flexible_cents: int
    savings_cents: int
    other_cents: int
    transfers_ignored_cents: int
    # Income-labeled money out (spec 007 rule 22a): not income, left out of every total.
    income_outflows_ignored_cents: int
    uncategorized_cents: int
    left_over_cents: int
    # One decimal place; null with no income, or when the share's size would
    # exceed 1,000.0 (income under a tenth of the bucket, spec 007 rule 25).
    essentials_pct: Decimal | None
    flexible_pct: Decimal | None
    savings_rate_pct: Decimal | None
    # Rows the totals read: checking, savings and credit accounts only.
    transaction_count: int
    uncategorized_count: int
    paycheck_count: int
    # Loan, investment and retirement ledgers, in no total (spec 007 rule 21a).
    ledger_rows_skipped: LedgerRowsSkipped
    categories: list[CategoryTotal]
    category_buckets: dict[str, Bucket]
    # The account kinds whose rows the totals read (rule 21a).
    account_kinds_counted: list[AccountKind]


def last_complete_month(today: dt.date) -> tuple[dt.date, dt.date]:
    """The calendar month before ``today``'s, first to last day."""
    end = today.replace(day=1) - dt.timedelta(days=1)
    return end.replace(day=1), end


def period(start: dt.date | None, end: dt.date | None, today: dt.date) -> tuple[dt.date, dt.date]:
    """The inclusive period from ``start`` and ``end``, both or neither (also for /cashflow)."""
    if start is None and end is None:
        return last_complete_month(today)
    if start is None or end is None:
        raise AppError(
            "Give both start and end, or neither", code="validation_error", status_code=422
        )
    if start > end:
        raise AppError("start must not be after end", code="validation_error", status_code=422)
    if (end - start).days + 1 > MAX_SPAN_DAYS:
        raise AppError(
            f"The period can be at most {MAX_SPAN_DAYS} days",
            code="validation_error",
            status_code=422,
        )
    return start, end


def _account_join() -> ColumnElement[bool]:
    return (Account.id == Transaction.account_id) & (Account.user_id == Transaction.user_id)


def _posted_in(start: dt.date, end: dt.date, kinds: tuple[AccountKind, ...]) -> ColumnElement[bool]:
    """Posted rows in the period on the user's active accounts of ``kinds``."""
    return (
        Transaction.pending.is_(False)
        & Account.is_active.is_(True)
        & Account.kind.in_(kinds)
        & Transaction.posted_at.between(start, end)
    )


def _category_sums(session: Session, start: dt.date, end: dt.date) -> list[CategorySum]:
    money_out = Transaction.amount_cents > 0
    money_in = Transaction.amount_cents < 0
    rows = session.execute(
        select(
            Transaction.category,
            func.coalesce(func.sum(Transaction.amount_cents).filter(money_out), 0),
            func.coalesce(func.sum(-Transaction.amount_cents).filter(money_in), 0),
            func.count(),
            func.count().filter(money_out),
        )
        .join(Account, _account_join())
        .where(_posted_in(start, end, SPENDING_ACCOUNT_KINDS))
        .group_by(Transaction.category)
        .order_by(case(_CATEGORY_ORDER, value=Transaction.category, else_=len(_CATEGORY_ORDER)))
    )
    return [
        CategorySum(
            category=category,
            out_cents=int(out_cents),
            in_cents=int(in_cents),
            count=int(count),
            out_count=int(out_count),
        )
        for category, out_cents, in_cents, count, out_count in rows
    ]


def _ledger_rows(session: Session, start: dt.date, end: dt.date) -> LedgerRowsSkipped:
    count, net_cents = session.execute(
        select(func.count(), func.coalesce(func.sum(Transaction.amount_cents), 0))
        .join(Account, _account_join())
        .where(_posted_in(start, end, LEDGER_ACCOUNT_KINDS))
    ).one()
    return LedgerRowsSkipped(count=int(count), net_cents=int(net_cents))


@router.get("/summary", responses=error_responses(401, 422))
def spending_summary(
    session: UserSession,
    now: Now,
    start: Annotated[dt.date | None, Query(description="First day, inclusive")] = None,
    end: Annotated[dt.date | None, Query(description="Last day, inclusive")] = None,
) -> SpendingSummary:
    """Income, spending by bucket and what is left over; the last full UTC month by default."""
    first, last = period(start, end, now.date())
    return summary_for(session, first, last)


def summary_for(session: Session, first: dt.date, last: dt.date) -> SpendingSummary:
    """The summary of an already validated period (``GET /cashflow`` shares it)."""
    totals = summarize(_category_sums(session, first, last), CATEGORY_BUCKETS)
    paychecks = session.scalar(
        select(func.count()).select_from(PayStub).where(PayStub.pay_date.between(first, last))
    )
    return SpendingSummary(
        start=first,
        end=last,
        paycheck_count=int(paychecks or 0),
        ledger_rows_skipped=_ledger_rows(session, first, last),
        category_buckets=dict(CATEGORY_BUCKETS),
        account_kinds_counted=list(SPENDING_ACCOUNT_KINDS),
        **totals.model_dump(exclude={"categories"}),
        categories=totals.categories,
    )
