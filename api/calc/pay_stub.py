"""Pay stub arithmetic: the confirm gate (spec 005 rule 21, spec amendment 17),
the yearly salary a stub implies (spec 005 rule 24a), the 401(k) rate it
shows (spec 005 rule 24b), and what the rate and the federal withholding it
shows say against a decision (spec 008 rules 7a and 7b).

Gross minus every deduction must equal net, to the cent. The server checks it
on ``POST /docs/{id}/confirm`` (a 422 with this diff), the client checks it as
the user edits, and the ``pay_stub_balances`` constraint is the backstop.
"""

from __future__ import annotations

from collections.abc import Iterable
from decimal import Decimal
from enum import StrEnum
from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field

from calc.money import rate_pct
from calc.pay_dates import PERIODS, PayFrequency

Cents = Annotated[int, Field(strict=True)]

__all__ = [
    "Balance",
    "PayStubAmounts",
    "StubRate",
    "StubWithholding",
    "annual_salary_cents",
    "balance",
    "retirement_contribution_pct",
    "stub_rate",
    "stub_withholding",
    "total_cents",
    "withholding_on_schedule",
]


class PayStubAmounts(BaseModel):
    model_config = ConfigDict(frozen=True)

    gross_cents: Cents
    federal_withholding_cents: Cents
    social_security_cents: Cents
    medicare_cents: Cents
    state_tax_cents: Cents
    retirement_contribution_cents: Cents
    medical_premium_cents: Cents
    other_deductions_cents: Cents
    net_cents: Cents


class Balance(BaseModel):
    model_config = ConfigDict(frozen=True)

    gross_cents: Cents
    deductions_cents: Cents
    net_cents: Cents
    # What net would be if every other amount is right.
    expected_net_cents: Cents
    # gross - deductions - net; zero when the stub balances.
    difference_cents: Cents

    @property
    def balances(self) -> bool:
        return self.difference_cents == 0


def total_cents(amounts: Iterable[int]) -> int:
    return sum(amounts, 0)


def annual_salary_cents(gross_cents: int, pay_frequency: PayFrequency | None) -> int | None:
    """Gross pay times the pay periods a year (spec 005 rule 24a).

    An integer product, so nothing is rounded: 270,833 twice a month is
    6,499,992, not 6,500,000. None without a pay frequency.
    """
    if pay_frequency is None:
        return None
    return gross_cents * PERIODS[pay_frequency]


def retirement_contribution_pct(retirement_cents: int, gross_cents: int) -> Decimal | None:
    """The 401(k) rate a stub shows: the retirement deduction as a percentage
    of this paycheck's gross, exact, then two places half up (spec 005 rule 24b).

    10,962 of 365,385 is 3.00; nothing withheld is 0.00. None when the gross
    is not positive, so there is nothing to take a share of.
    """
    if gross_cents <= 0:
        return None
    return rate_pct(retirement_cents, gross_cents)


class StubRate(StrEnum):
    """What the newest confirmed pay stub says about a chosen 401(k) rate
    (spec 008 rule 7a)."""

    NONE = "none"  # no confirmed stub: what goes in now is not known
    CHOSEN = "chosen"  # the stub shows the chosen rate: it is in effect
    OTHER = "other"  # the stub shows another rate: the chosen one is not in effect yet


def stub_rate(chosen: Decimal, pay_stub_pct: Decimal | None) -> StubRate:
    """Compare the rates by value, so 3.00 on the stub is a chosen 3."""
    if pay_stub_pct is None:
        return StubRate.NONE
    return StubRate.CHOSEN if pay_stub_pct == chosen else StubRate.OTHER


def withholding_on_schedule(
    federal_withholding_cents: int, pay_frequency: PayFrequency | None, pay_periods_per_year: int
) -> int | None:
    """What a stub withholds each paycheck, when its paycheck is one of
    ``pay_periods_per_year`` (spec 008 rule 7b, spec 014 rule 10a): None for a
    stub on another pay schedule, whose paycheck is a different length. A stub
    with no pay frequency is taken to be on the schedule; a stored 0 is a
    confirmed amount."""
    if pay_frequency is not None and PERIODS[pay_frequency] != pay_periods_per_year:
        return None
    return federal_withholding_cents


class StubWithholding(StrEnum):
    """What the newest confirmed pay stub says about the federal withholding a
    W-4 decision's entries give (spec 008 rule 7b)."""

    NONE = "none"  # no stub on the pay schedule: what is withheld now is not known
    ENTRIES = "entries"  # the stub withholds what the entries give: they are in effect
    OTHER = "other"  # the stub withholds another amount: the entries are not in effect yet


def stub_withholding(entries_cents: int, pay_stub_withholding_cents: int | None) -> StubWithholding:
    """Compare whole cents, so a stub payroll rounded to the dollar is another amount."""
    if pay_stub_withholding_cents is None:
        return StubWithholding.NONE
    if pay_stub_withholding_cents == entries_cents:
        return StubWithholding.ENTRIES
    return StubWithholding.OTHER


def balance(amounts: PayStubAmounts) -> Balance:
    deductions = total_cents(
        (
            amounts.federal_withholding_cents,
            amounts.social_security_cents,
            amounts.medicare_cents,
            amounts.state_tax_cents,
            amounts.retirement_contribution_cents,
            amounts.medical_premium_cents,
            amounts.other_deductions_cents,
        )
    )
    expected = amounts.gross_cents - deductions
    return Balance(
        gross_cents=amounts.gross_cents,
        deductions_cents=deductions,
        net_cents=amounts.net_cents,
        expected_net_cents=expected,
        difference_cents=expected - amounts.net_cents,
    )
