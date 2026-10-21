"""Spec 011 hand-worked examples: one test per row, named as in the spec."""

from __future__ import annotations

from decimal import Decimal
from typing import Any

import pytest
from pydantic import ValidationError

from calc.emergency_fund import (
    HORIZON_MONTHS,
    EmergencyFundInput,
    EmergencyFundResult,
    emergency_fund,
    funded_pct,
)


def run(
    essentials: int, months: int, balance: int, contribution: int, periods: int
) -> EmergencyFundResult:
    return emergency_fund(
        EmergencyFundInput.model_validate(
            {
                "monthly_essentials_cents": essentials,
                "target_months": months,
                "current_balance_cents": balance,
                "monthly_contribution_cents": contribution,
                "pay_periods_per_year": periods,
            }
        )
    )


def expect(
    result: EmergencyFundResult,
    *,
    target: int,
    three: int,
    six: int,
    shortfall: int,
    funded: bool,
    pct: str,
    months: int | None,
    reachable: bool,
    per_pp: int,
) -> None:
    assert result.model_dump() == {
        "target_cents": target,
        "three_month_target_cents": three,
        "six_month_target_cents": six,
        "shortfall_cents": shortfall,
        "funded": funded,
        "funded_pct": Decimal(pct),
        "months_to_target": months,
        "reachable": reachable,
        "per_paycheck_contribution_cents": per_pp,
        "horizon_months": HORIZON_MONTHS,
    }


def test_zero_balance() -> None:
    expect(
        run(250_000, 3, 0, 50_000, 26),
        target=750_000,
        three=750_000,
        six=1_500_000,
        shortfall=750_000,
        funded=False,
        pct="0.00",
        months=15,
        reachable=True,
        per_pp=23_077,
    )


def test_partly_funded_semimonthly() -> None:
    expect(
        run(320_000, 6, 450_000, 40_000, 24),
        target=1_920_000,
        three=960_000,
        six=1_920_000,
        shortfall=1_470_000,
        funded=False,
        pct="23.44",
        months=37,
        reachable=True,
        per_pp=20_000,
    )


def test_already_funded() -> None:
    expect(
        run(200_000, 3, 700_000, 30_000, 26),
        target=600_000,
        three=600_000,
        six=1_200_000,
        shortfall=0,
        funded=True,
        pct="100.00",
        months=0,
        reachable=True,
        per_pp=13_846,
    )


def test_exactly_at_target() -> None:
    expect(
        run(200_000, 3, 600_000, 0, 12),
        target=600_000,
        three=600_000,
        six=1_200_000,
        shortfall=0,
        funded=True,
        pct="100.00",
        months=0,
        reachable=True,
        per_pp=0,
    )


def test_never_within_ten_years() -> None:
    expect(
        run(300_000, 6, 10_000, 10_000, 26),
        target=1_800_000,
        three=900_000,
        six=1_800_000,
        shortfall=1_790_000,
        funded=False,
        pct="0.56",
        months=None,
        reachable=False,
        per_pp=4_615,
    )


def test_zero_contribution_not_funded() -> None:
    expect(
        run(150_000, 3, 100_000, 0, 52),
        target=450_000,
        three=450_000,
        six=900_000,
        shortfall=350_000,
        funded=False,
        pct="22.22",
        months=None,
        reachable=False,
        per_pp=0,
    )


def test_exactly_ten_years() -> None:
    expect(
        run(100_000, 6, 0, 5_000, 12),
        target=600_000,
        three=300_000,
        six=600_000,
        shortfall=600_000,
        funded=False,
        pct="0.00",
        months=120,
        reachable=True,
        per_pp=5_000,
    )


def test_half_cent_per_paycheck_rounds_up() -> None:
    expect(
        run(180_000, 4, 360_000, 25_001, 24),
        target=720_000,
        three=540_000,
        six=1_080_000,
        shortfall=360_000,
        funded=False,
        pct="50.00",
        months=15,
        reachable=True,
        per_pp=12_501,
    )


# ---------------------------------------------------------------- edge cases


def test_contribution_above_the_shortfall_takes_one_month() -> None:
    assert run(100_000, 3, 250_000, 80_000, 26).months_to_target == 1


def test_funded_pct_is_capped_at_100() -> None:
    assert funded_pct(10_000_000, 600_000) == Decimal("100.00")
    assert funded_pct(1, 3) == Decimal("33.33")


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("target_months", 0),
        ("target_months", 13),
        ("monthly_essentials_cents", 0),
        ("current_balance_cents", -1),
        ("monthly_contribution_cents", -1),
        ("monthly_contribution_cents", 100.0),
        ("pay_periods_per_year", 13),
    ],
)
def test_out_of_range_inputs_are_refused(field: str, value: Any) -> None:
    data: dict[str, Any] = {
        "monthly_essentials_cents": 100_000,
        "target_months": 3,
        "current_balance_cents": 0,
        "monthly_contribution_cents": 10_000,
        "pay_periods_per_year": 26,
        field: value,
    }
    with pytest.raises(ValidationError):
        EmergencyFundInput.model_validate(data)
