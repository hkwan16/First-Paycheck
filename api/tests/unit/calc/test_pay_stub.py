"""The confirm arithmetic gate (spec 005 rule 21 and its hand-worked examples)."""

from __future__ import annotations

from decimal import Decimal

import pytest
from pydantic import ValidationError

from calc.pay_stub import (
    Balance,
    PayStubAmounts,
    StubRate,
    annual_salary_cents,
    balance,
    retirement_contribution_pct,
    stub_rate,
    total_cents,
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
