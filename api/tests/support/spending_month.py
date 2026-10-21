"""Spec 007 part B's September: the month the spending and cash-flow tests share."""

from __future__ import annotations

import datetime as dt
import uuid
from typing import Any

from sqlalchemy import Connection

from db.enums import CategorySource
from tests.conftest import FixtureUser
from tests.support.factories import make_document, make_pay_stub, make_transaction


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
