"""Spec 007 part B's months the spending, cash-flow and check-in tests share."""

from __future__ import annotations

import datetime as dt
import uuid
from typing import Any

from sqlalchemy import Connection

from db.enums import AccountKind, CategorySource
from tests.conftest import FixtureUser
from tests.support.factories import (
    make_account,
    make_document,
    make_item,
    make_pay_stub,
    make_transaction,
)


def spend(
    connection: Connection,
    user: FixtureUser,
    account: uuid.UUID,
    amount_cents: int,
    category: str | None,
    day: dt.date = dt.date(2026, 9, 10),
    **fields: Any,
) -> None:
    make_transaction(
        connection,
        user.id,
        account,
        amount_cents=amount_cents,
        posted_at=day,
        category=category,
        category_source=CategorySource.USER if category else None,
        **fields,
    )


def september(connection: Connection, user: FixtureUser, account: uuid.UUID) -> None:
    """The spec's month: every row of spec 007's spending example."""
    spend(connection, user, account, -199_604, "income", dt.date(2026, 9, 15))
    spend(connection, user, account, -199_604, "income", dt.date(2026, 9, 30))
    spend(connection, user, account, 150_000, "housing", dt.date(2026, 9, 1))
    spend(connection, user, account, 32_000, "groceries")
    spend(connection, user, account, -2_000, "groceries")
    spend(connection, user, account, 8_500, "dining")
    spend(connection, user, account, 40_000, "savings_investment")
    spend(connection, user, account, 25_000, "transfer")
    spend(connection, user, account, 3_900, "fees")
    spend(connection, user, account, 1_200, None)
    spend(connection, user, account, 9_999, "dining", pending=True)
    spend(connection, user, account, 5_000, "dining", dt.date(2026, 8, 31))
    for pay_date in (dt.date(2026, 9, 15), dt.date(2026, 9, 30), dt.date(2026, 10, 15)):
        document = make_document(connection, user.id, with_blob=False)
        make_pay_stub(connection, user.id, document, pay_date=pay_date)


def loan_ledger_month(connection: Connection, user: FixtureUser) -> None:
    """Spec 007's loan ledger month (rule 21a): checking, a credit card, an auto
    loan whose ledger books the payment it received and its interest, and a
    brokerage account with a dividend, all in September 2026."""
    item = make_item(connection, user.id)
    checking = make_account(connection, user.id, item)
    card = make_account(connection, user.id, item, kind=AccountKind.CREDIT, name="Credit card")
    loan = make_account(connection, user.id, item, kind=AccountKind.LOAN, name="Auto loan")
    brokerage = make_account(
        connection, user.id, item, kind=AccountKind.INVESTMENT, name="Brokerage"
    )
    spend(connection, user, checking, -250_000, "income", dt.date(2026, 9, 15))
    spend(connection, user, checking, 120_000, "housing", dt.date(2026, 9, 1))
    spend(connection, user, checking, 40_000, "debt_payment", dt.date(2026, 9, 5))
    spend(connection, user, checking, 20_000, "transfer", dt.date(2026, 9, 20))
    spend(connection, user, card, 20_000, "groceries", dt.date(2026, 9, 8))
    spend(connection, user, card, -20_000, "transfer", dt.date(2026, 9, 20))
    spend(
        connection,
        user,
        loan,
        -40_000,
        "income",
        dt.date(2026, 9, 5),
        merchant_raw="Monthly payment",
    )
    spend(
        connection, user, loan, 3_500, "fees", dt.date(2026, 9, 6), merchant_raw="Interest charged"
    )
    spend(
        connection, user, brokerage, -1_500, "income", dt.date(2026, 9, 25), merchant_raw="Dividend"
    )
