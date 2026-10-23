"""Plaid's ``user_transactions_dynamic`` sandbox user, labeled by the seed rules
alone (spec 003, "The dynamic sandbox user").

Reproduces the October 22 production run: the recorded item goes through
``PlaidProvider``, ``run_sync`` and the categorize job with no model, the way a
new user's first sync is labeled. Before spec 003 rules 3a-3c and 5a, the
weekly paycheck "Sweetgreen inc payroll ppd id" (money in) was ``dining`` by the
seed rule ``sweetgreen`` and 256 of the 316 rows were uncategorized.
"""

from __future__ import annotations

from collections import Counter

from sqlalchemy import Connection, text

from tests.conftest import FixtureUser
from tests.support.sandbox_history import DYNAMIC, link_sandbox

PAYCHECK = "sweetgreen inc payroll ppd id"


def rows(connection: Connection, user: FixtureUser) -> list[tuple[str, int, str | None]]:
    return [
        (row.merchant_norm, row.amount_cents, row.category)
        for row in connection.execute(
            text(
                "SELECT merchant_norm, amount_cents, category FROM transactions WHERE user_id = :u"
            ),
            {"u": user.id},
        )
    ]


def test_dynamic_sandbox_user_with_rules_only(
    seeded_rules: Connection, user_a: FixtureUser
) -> None:
    link_sandbox(seeded_rules, user_a, history=DYNAMIC)
    found = rows(seeded_rules, user_a)
    assert len(found) == 316

    paychecks = [(amount, category) for merchant, amount, category in found if merchant == PAYCHECK]
    assert paychecks == [(-81_000, "income")] * 5

    labeled = Counter((merchant, category) for merchant, _, category in found)
    assert labeled[("interest payment", "income")] == 2

    uncategorized = Counter(merchant for merchant, _, category in found if category is None)
    assert sum(uncategorized.values()) == 256
    # The loans' own ledgers: bank language, not merchants.
    assert uncategorized.most_common(2) == [("monthly payment", 132), ("interest charged", 68)]
