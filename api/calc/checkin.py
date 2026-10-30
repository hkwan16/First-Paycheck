"""The money arithmetic behind check-in findings (spec 015 rules 1-6).

The finders in ``checkin/findings.py`` compare the cents they are handed and
do date arithmetic themselves; every amount they report is computed here, in
integer cents with ``Decimal`` rates and one ``round_half_up`` per output.
"""

from __future__ import annotations

from decimal import Decimal

from pydantic import BaseModel, ConfigDict

from calc.money import pct_of, round_half_up

__all__ = ["GoalPace", "change_cents", "expected_deferral_cents", "goal_pace"]


def expected_deferral_cents(gross_cents: int, pct: Decimal) -> int:
    """``pct`` percent of one paycheck's gross, rounded half up to the cent (rule 1)."""
    return round_half_up(pct_of(gross_cents, pct))


def change_cents(new_cents: int, old_cents: int) -> int:
    """How far an amount moved: new minus old, negative when it fell."""
    return new_cents - old_cents


class GoalPace(BaseModel):
    model_config = ConfigDict(frozen=True)

    # What the balance should be after ``months_elapsed`` contributions.
    expected_cents: int
    # Expected minus actual: positive when behind, zero or negative when on pace.
    shortfall_cents: int


def goal_pace(
    start_balance_cents: int,
    monthly_contribution_cents: int,
    months_elapsed: int,
    balance_cents: int,
) -> GoalPace:
    """Rule 3: ``expected = start + contribution * months``, ``shortfall = expected - balance``."""
    if months_elapsed < 0:
        raise ValueError(f"months must not be negative, not {months_elapsed}")
    expected = start_balance_cents + monthly_contribution_cents * months_elapsed
    return GoalPace(expected_cents=expected, shortfall_cents=expected - balance_cents)
