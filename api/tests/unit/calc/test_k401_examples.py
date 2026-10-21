"""Spec 006 hand-worked examples: one test per row, named as in the spec.

All examples use tax year 2026, filing status single and age 30 unless stated.
"""

from __future__ import annotations

from decimal import Decimal
from typing import Any

import pytest
from pydantic import ValidationError

from calc.k401 import K401MatchInput, K401MatchResult, k401_match

BASE_KEYS = [
    "k401.employer_match",
    "k401.pretax_deferral",
    "k401.deferral_limit",
    "k401.federal_brackets",
]
TIERED = [("3", "100"), ("5", "50")]


def run(
    salary_cents: int,
    periods: int,
    tiers: list[tuple[str, str]],
    contribution: str,
    *,
    age: int = 30,
    filing_status: str = "single",
    tax_year: int = 2026,
) -> K401MatchResult:
    return k401_match(
        K401MatchInput.model_validate(
            {
                "salary_cents": salary_cents,
                "pay_periods_per_year": periods,
                "match_tiers": [
                    {"employee_pct_upto": upto, "employer_pct": pct} for upto, pct in tiers
                ],
                "contribution_pct": contribution,
                "tax_year": tax_year,
                "filing_status": filing_status,
                "age": age,
            }
        )
    )


def expect(
    result: K401MatchResult,
    *,
    full_pct: str,
    match_cur: int,
    match_full: int,
    missed: int,
    emp_cur: int,
    emp_full: int,
    per_pp: int,
    after_tax: int,
    rate: str,
    limit: int,
    capped: bool,
    keys: list[str] = BASE_KEYS,
    compensation_capped: bool = False,
) -> None:
    expected: dict[str, Any] = {
        "full_match_pct": Decimal(full_pct),
        "employer_match_cents_current": match_cur,
        "employer_match_cents_full": match_full,
        "missed_cents": missed,
        "employee_annual_cents_current": emp_cur,
        "employee_annual_cents_full": emp_full,
        "per_paycheck_cost_delta_cents": per_pp,
        "per_paycheck_after_tax_cost_cents": after_tax,
        "marginal_rate_used": Decimal(rate),
        "deferral_limit_cents": limit,
        "capped": capped,
        "compensation_capped": compensation_capped,
        "citation_keys": keys,
    }
    assert result.model_dump() == expected


def test_tiered_3_at_100_plus_2_at_50() -> None:
    expect(
        run(6_000_000, 26, TIERED, "3"),
        full_pct="5",
        match_cur=180_000,
        match_full=240_000,
        missed=60_000,
        emp_cur=180_000,
        emp_full=300_000,
        per_pp=4_615,
        after_tax=4_062,
        rate="12",
        limit=2_450_000,
        capped=False,
    )


def test_simple_100_to_4_semimonthly() -> None:
    expect(
        run(6_500_000, 24, [("4", "100")], "2"),
        full_pct="4",
        match_cur=130_000,
        match_full=260_000,
        missed=130_000,
        emp_cur=130_000,
        emp_full=260_000,
        per_pp=5_417,
        after_tax=4_767,
        rate="12",
        limit=2_450_000,
        capped=False,
    )


def test_50_to_6() -> None:
    expect(
        run(8_500_000, 26, [("6", "50")], "4"),
        full_pct="6",
        match_cur=170_000,
        match_full=255_000,
        missed=85_000,
        emp_cur=340_000,
        emp_full=510_000,
        per_pp=6_538,
        after_tax=5_100,
        rate="22",
        limit=2_450_000,
        capped=False,
    )


def test_402g_cap_2026() -> None:
    expect(
        run(30_000_000, 26, TIERED, "10"),
        full_pct="5",
        match_cur=1_200_000,
        match_full=1_200_000,
        missed=0,
        emp_cur=2_450_000,
        emp_full=1_500_000,
        per_pp=0,
        after_tax=0,
        rate="35",
        limit=2_450_000,
        capped=True,
    )


def test_26_periods() -> None:
    expect(
        run(5_200_000, 26, TIERED, "2"),
        full_pct="5",
        match_cur=104_000,
        match_full=208_000,
        missed=104_000,
        emp_cur=104_000,
        emp_full=260_000,
        per_pp=6_000,
        after_tax=5_280,
        rate="12",
        limit=2_450_000,
        capped=False,
    )


def test_24_periods() -> None:
    expect(
        run(5_200_000, 24, TIERED, "2"),
        full_pct="5",
        match_cur=104_000,
        match_full=208_000,
        missed=104_000,
        emp_cur=104_000,
        emp_full=260_000,
        per_pp=6_500,
        after_tax=5_720,
        rate="12",
        limit=2_450_000,
        capped=False,
    )


def test_contribution_above_full_match() -> None:
    expect(
        run(7_000_000, 26, [("4", "100")], "8"),
        full_pct="4",
        match_cur=280_000,
        match_full=280_000,
        missed=0,
        emp_cur=560_000,
        emp_full=280_000,
        per_pp=0,
        after_tax=0,
        rate="12",
        limit=2_450_000,
        capped=False,
    )


def test_catch_up_age_52_lifts_cap() -> None:
    expect(
        run(30_000_000, 26, TIERED, "10", age=52),
        full_pct="5",
        match_cur=1_200_000,
        match_full=1_200_000,
        missed=0,
        emp_cur=3_000_000,
        emp_full=1_500_000,
        per_pp=0,
        after_tax=0,
        rate="32",
        limit=3_250_000,
        capped=False,
        keys=[*BASE_KEYS, "k401.catch_up"],
    )


def test_catch_up_age_61() -> None:
    expect(
        run(30_000_000, 26, TIERED, "12", age=61),
        full_pct="5",
        match_cur=1_200_000,
        match_full=1_200_000,
        missed=0,
        emp_cur=3_575_000,
        emp_full=1_500_000,
        per_pp=0,
        after_tax=0,
        rate="32",
        limit=3_575_000,
        capped=True,
        keys=[*BASE_KEYS, "k401.catch_up"],
    )


def test_fractional_cents_round_half_up() -> None:
    expect(
        run(4_512_345, 26, TIERED, "4.5"),
        full_pct="5",
        match_cur=169_213,
        match_full=180_494,
        missed=11_281,
        emp_cur=203_056,
        emp_full=225_617,
        per_pp=868,
        after_tax=764,
        rate="12",
        limit=2_450_000,
        capped=False,
    )


def test_cap_below_full_match_pct() -> None:
    expect(
        run(50_000_000, 26, TIERED, "6"),
        full_pct="5",
        match_cur=1_440_000,
        match_full=1_440_000,
        missed=0,
        emp_cur=2_450_000,
        emp_full=2_450_000,
        per_pp=0,
        after_tax=0,
        rate="35",
        limit=2_450_000,
        capped=True,
        keys=[*BASE_KEYS, "k401.compensation_limit"],
        compensation_capped=True,
    )


def test_zero_contribution() -> None:
    expect(
        run(6_000_000, 26, TIERED, "0"),
        full_pct="5",
        match_cur=0,
        match_full=240_000,
        missed=240_000,
        emp_cur=0,
        emp_full=300_000,
        per_pp=11_538,
        after_tax=10_154,
        rate="12",
        limit=2_450_000,
        capped=False,
    )


# ---------------------------------------------------------------- edge cases


def test_no_match() -> None:
    expect(
        run(6_000_000, 26, [], "6"),
        full_pct="0",
        match_cur=0,
        match_full=0,
        missed=0,
        emp_cur=360_000,
        emp_full=0,
        per_pp=0,
        after_tax=0,
        rate="12",
        limit=2_450_000,
        capped=False,
    )


def test_bracket_boundary_takes_lower_rate() -> None:
    assert run(6_650_000, 26, TIERED, "0").marginal_rate_used == Decimal("12")
    assert run(6_650_001, 26, TIERED, "0").marginal_rate_used == Decimal("22")


def test_taxable_income_at_or_below_zero_uses_rate_zero() -> None:
    result = run(1_610_000, 26, TIERED, "0")
    assert result.marginal_rate_used == Decimal("0")
    assert result.per_paycheck_after_tax_cost_cents == result.per_paycheck_cost_delta_cents


def test_compensation_limit_boundary() -> None:
    at_limit = run(36_000_000, 26, TIERED, "5")
    assert at_limit.compensation_capped is False
    assert at_limit.employer_match_cents_current == 1_440_000
    assert "k401.compensation_limit" not in at_limit.citation_keys
    above = run(36_000_001, 26, TIERED, "5")
    assert above.compensation_capped is True
    assert above.employer_match_cents_current == 1_440_000
    assert above.citation_keys[-1] == "k401.compensation_limit"


@pytest.mark.parametrize(
    ("filing_status", "rate"),
    [("married_filing_jointly", "12"), ("head_of_household", "12")],
)
def test_filing_status_selects_table(filing_status: str, rate: str) -> None:
    # Example 3's taxable income under the other two tables: 8,500,000 - 340,000
    # minus 3,220,000 (MFJ) is 4,940,000 and minus 2,415,000 (HOH) is 5,745,000,
    # both in the 12% bracket of their table.
    result = run(8_500_000, 26, [("6", "50")], "4", filing_status=filing_status)
    assert result.marginal_rate_used == Decimal(rate)


def test_catch_up_starts_at_50_and_steps_down_at_64() -> None:
    assert run(30_000_000, 26, TIERED, "10", age=49).deferral_limit_cents == 2_450_000
    assert run(30_000_000, 26, TIERED, "10", age=50).deferral_limit_cents == 3_250_000
    assert run(30_000_000, 26, TIERED, "10", age=60).deferral_limit_cents == 3_575_000
    assert run(30_000_000, 26, TIERED, "10", age=63).deferral_limit_cents == 3_575_000
    assert run(30_000_000, 26, TIERED, "10", age=64).deferral_limit_cents == 3_250_000


def test_tax_year_without_constants_is_invalid() -> None:
    with pytest.raises(ValidationError, match="2027"):
        run(6_000_000, 26, TIERED, "3", tax_year=2027)


@pytest.mark.parametrize(
    "change",
    [
        {"salary_cents": 0},
        {"salary_cents": 6_000_000.0},
        {"pay_periods_per_year": 25},
        {"contribution_pct": "100.01"},
        {"contribution_pct": "4.555"},
        {"contribution_pct": "-1"},
        {"filing_status": "married_filing_separately"},
        {"age": -1},
        {"match_tiers": [{"employee_pct_upto": "5", "employer_pct": "50"}] * 2},
        {"match_tiers": [{"employee_pct_upto": "0", "employer_pct": "50"}]},
        {"match_tiers": [{"employee_pct_upto": "5", "employer_pct": "0"}]},
        {"unexpected": 1},
    ],
)
def test_invalid_inputs_are_rejected(change: dict[str, Any]) -> None:
    body: dict[str, Any] = {
        "salary_cents": 6_000_000,
        "pay_periods_per_year": 26,
        "match_tiers": [{"employee_pct_upto": "3", "employer_pct": "100"}],
        "contribution_pct": "3",
        "tax_year": 2026,
        "filing_status": "single",
        "age": 30,
        **change,
    }
    with pytest.raises(ValidationError):
        K401MatchInput.model_validate(body)
