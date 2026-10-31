"""The confirm arithmetic gate (spec 005 rule 21 and its hand-worked examples), and
what a stub says against a decision (spec 008 rules 7a and 7b)."""

from __future__ import annotations

from decimal import Decimal

import pytest
from pydantic import ValidationError

from calc.pay_dates import PERIODS, PayFrequency
from calc.pay_stub import (
    Balance,
    PayStubAmounts,
    StubRate,
    StubWithholding,
    annual_salary_cents,
    balance,
    retirement_contribution_pct,
    stub_rate,
    stub_withholding,
    total_cents,
    withholding_on_schedule,
)

MOCKUP = {
    "gross_cents": 270_833,
    "federal_withholding_cents": 29_776,
    "social_security_cents": 16_792,
    "medicare_cents": 3_927,
    "state_tax_cents": 9_814,
    "retirement_contribution_cents": 0,
    "medical_premium_cents": 6_250,
    "other_deductions_cents": 4_670,
    "net_cents": 199_604,
}


def test_mockup_stub_balances() -> None:
    result = balance(PayStubAmounts(**MOCKUP))
    assert result == Balance(
        gross_cents=270_833,
        deductions_cents=71_229,
        net_cents=199_604,
        expected_net_cents=199_604,
        difference_cents=0,
    )
    assert result.balances


def test_two_cents_off() -> None:
    result = balance(PayStubAmounts(**{**MOCKUP, "net_cents": 199_606}))
    assert result.difference_cents == -2
    assert result.expected_net_cents == 199_604
    assert not result.balances


def test_no_deductions() -> None:
    zero = dict.fromkeys(MOCKUP, 0) | {"gross_cents": 100_000, "net_cents": 100_000}
    assert balance(PayStubAmounts(**zero)).difference_cents == 0


def test_amounts_are_strict_integers() -> None:
    with pytest.raises(ValidationError):
        PayStubAmounts(**{**MOCKUP, "gross_cents": 2708.33})  # type: ignore[arg-type]  # the point of the test
    with pytest.raises(ValidationError):
        PayStubAmounts.model_validate({**MOCKUP, "net_cents": "199604"})


def test_total_cents_sums_integers() -> None:
    assert total_cents([3_250, 1_420]) == 4_670
    assert total_cents([]) == 0


def test_annual_salary_semimonthly_mockup_stub() -> None:
    # 270,833 x 24, exact: not rounded to the $65,000 the stub was made from.
    assert annual_salary_cents(270_833, "semimonthly") == 6_499_992


def test_annual_salary_every_frequency() -> None:
    assert annual_salary_cents(250_000, "weekly") == 13_000_000
    assert annual_salary_cents(250_000, "biweekly") == 6_500_000
    assert annual_salary_cents(250_000, "semimonthly") == 6_000_000
    assert annual_salary_cents(250_000, "monthly") == 3_000_000


def test_annual_salary_without_frequency() -> None:
    assert annual_salary_cents(270_833, None) is None


# Spec 005 rule 24b: the 401(k) rate a stub shows, two places half up.


def test_contribution_rate_stub_01() -> None:
    # 10,962 x 100 / 365,385 = 3.000123..., issue 132's stub.
    rate = retirement_contribution_pct(10_962, 365_385)
    assert rate == Decimal("3.00")
    assert str(rate) == "3.00"


def test_contribution_rate_rounds_half_up() -> None:
    # 1,000,000 / 320,000 = 3.125 exactly: half up, not to even.
    assert str(retirement_contribution_pct(10_000, 320_000)) == "3.13"


def test_contribution_rate_uneven() -> None:
    # 1,000,000 / 270,833 = 3.692312...: a flat $100.00 election.
    assert str(retirement_contribution_pct(10_000, 270_833)) == "3.69"


def test_contribution_rate_no_retirement_line() -> None:
    assert str(retirement_contribution_pct(0, 270_833)) == "0.00"


def test_contribution_rate_zero_gross() -> None:
    assert retirement_contribution_pct(0, 0) is None
    assert retirement_contribution_pct(10_962, 0) is None
    assert retirement_contribution_pct(10_962, -1) is None


# Spec 008 rule 7a: the stub's case, compared by value.
@pytest.mark.parametrize(
    ("chosen", "pay_stub_pct", "expected"),
    [
        ("5", None, StubRate.NONE),
        ("5", "5.00", StubRate.CHOSEN),
        ("0", "0.00", StubRate.CHOSEN),
        ("4", "3.99", StubRate.OTHER),
        ("5", "3.00", StubRate.OTHER),
    ],
)
def test_stub_rate(chosen: str, pay_stub_pct: str | None, expected: StubRate) -> None:
    stub = None if pay_stub_pct is None else Decimal(pay_stub_pct)
    assert stub_rate(Decimal(chosen), stub) is expected


# Spec 008 rule 7b: what the stub withholds, on the decision's pay schedule.
@pytest.mark.parametrize(
    ("withheld", "frequency", "periods", "expected"),
    [
        (27_244, "biweekly", 26, 27_244),
        (27_244, None, 26, 27_244),
        (29_776, "semimonthly", 26, None),
        (0, "biweekly", 26, 0),
    ],
)
def test_withholding_on_schedule(
    withheld: int, frequency: PayFrequency | None, periods: int, expected: int | None
) -> None:
    assert withholding_on_schedule(withheld, frequency, periods) == expected


def test_withholding_on_schedule_for_every_frequency() -> None:
    for frequency, periods in PERIODS.items():
        assert withholding_on_schedule(100, frequency, periods) == 100
        others = {count for count in PERIODS.values() if count != periods}
        assert all(withholding_on_schedule(100, frequency, count) is None for count in others)


# Spec 008 rule 7b: the stub's case, compared in whole cents.
@pytest.mark.parametrize(
    ("entries", "pay_stub", "expected"),
    [
        (42_316, None, StubWithholding.NONE),
        (42_316, 42_316, StubWithholding.ENTRIES),
        (0, 0, StubWithholding.ENTRIES),
        (14_692, 14_700, StubWithholding.OTHER),
        (42_316, 27_244, StubWithholding.OTHER),
        (21_615, 0, StubWithholding.OTHER),
    ],
)
def test_stub_withholding(entries: int, pay_stub: int | None, expected: StubWithholding) -> None:
    assert stub_withholding(entries, pay_stub) is expected
