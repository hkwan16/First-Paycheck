"""The confirm arithmetic gate (spec 005 rule 21 and its hand-worked examples)."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from calc.pay_stub import Balance, PayStubAmounts, balance, total_cents

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
