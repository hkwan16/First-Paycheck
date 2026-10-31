"""Spec 014 hand-worked examples and edge cases: one test per row, named as in the spec.

All examples use tax year 2026 and the defaults (no 401(k), no premium, no
Step 2, 3 or 4 entries, no other jobs) unless stated.
"""

from __future__ import annotations

from decimal import Decimal
from typing import Any

import pytest
from pydantic import ValidationError

from calc.w4 import AtWithholding, W4Input, W4Result, at_withholding, w4

BASE_KEYS = [
    "w4.percentage_method",
    "w4.form_adjustments",
    "w4.standard_deduction",
    "w4.federal_brackets",
]
MULTIPLE_JOBS = "w4.multiple_jobs"
DEPENDENTS = "w4.dependents_credit"
PRETAX = "w4.pretax_deferral"


def run(salary_cents: int, periods: int, filing_status: str = "single", **entries: Any) -> W4Result:
    return w4(
        W4Input.model_validate(
            {
                "salary_cents": salary_cents,
                "pay_periods_per_year": periods,
                "filing_status": filing_status,
                "tax_year": 2026,
                **entries,
            }
        )
    )


def expect(
    result: W4Result,
    *,
    taxable_pp: int,
    aaw: int,
    rate: str,
    withheld_pp: int,
    withheld_yr: int,
    taxable_income: int,
    tax: int,
    tax_after: int,
    refund: int,
    suggestion: str = "none",
    suggested_4c: int = 0,
    suggested_4b: int = 0,
    suggested_refund: int | None = None,
    k401: int = 0,
    capped: bool = False,
    schedule: str = "standard",
    keys: list[str] = BASE_KEYS,
) -> None:
    expected: dict[str, Any] = {
        "taxable_wages_per_paycheck_cents": taxable_pp,
        "adjusted_annual_wage_cents": aaw,
        "withholding_rate_pct": Decimal(rate),
        "withholding_per_paycheck_cents": withheld_pp,
        "annual_withholding_cents": withheld_yr,
        "projected_taxable_income_cents": taxable_income,
        "projected_tax_cents": tax,
        "projected_tax_after_credits_cents": tax_after,
        "projected_refund_cents": refund,
        "suggestion": suggestion,
        "suggested_extra_withholding_cents": suggested_4c,
        "suggested_deductions_cents": suggested_4b,
        "suggested_refund_cents": refund if suggested_refund is None else suggested_refund,
        "k401_annual_cents": k401,
        "k401_capped": capped,
        "withholding_schedule": schedule,
        "citation_keys": keys,
    }
    actual = result.model_dump()
    assert {key: actual[key] for key in expected} == expected


def test_pub15t_worksheet_1a_biweekly_single() -> None:
    result = run(5_187_000, 26)
    expect(
        result,
        taxable_pp=199_500,
        aaw=4_327_000,
        rate="12",
        withheld_pp=15_555,
        withheld_yr=404_430,
        taxable_income=3_577_000,
        tax=404_440,
        tax_after=404_440,
        refund=-10,
    )
    # Pub 15-T's whole-dollar rounding gives the biweekly wage bracket table's $156.
    assert round(Decimal(result.withholding_per_paycheck_cents) / 100) == 156


def test_26_pay_periods() -> None:
    expect(
        run(6_500_000, 26),
        taxable_pp=250_000,
        aaw=5_640_000,
        rate="12",
        withheld_pp=21_615,
        withheld_yr=561_990,
        taxable_income=4_890_000,
        tax=562_000,
        tax_after=562_000,
        refund=-10,
    )


def test_24_pay_periods() -> None:
    expect(
        run(6_500_000, 24),
        taxable_pp=270_833,
        aaw=5_640_000,
        rate="12",
        withheld_pp=23_417,
        withheld_yr=562_008,
        taxable_income=4_890_000,
        tax=562_000,
        tax_after=562_000,
        refund=8,
    )


def test_401k_and_premium_reduce_wages() -> None:
    result = run(6_500_000, 26, k401_contribution_pct="5", health_premium_per_paycheck_cents=6_250)
    expect(
        result,
        taxable_pp=231_250,
        aaw=5_152_500,
        rate="12",
        withheld_pp=19_365,
        withheld_yr=503_490,
        taxable_income=4_402_500,
        tax=503_500,
        tax_after=503_500,
        refund=-10,
        k401=325_000,
        keys=[*BASE_KEYS, PRETAX],
    )
    assert result.health_premium_annual_cents == 162_500


def test_step2_two_equal_jobs() -> None:
    expect(
        run(
            6_000_000,
            26,
            "married_filing_jointly",
            multiple_jobs=True,
            other_jobs_wages_cents=6_000_000,
            other_jobs_withholding_cents=502_008,
        ),
        taxable_pp=230_769,
        aaw=6_000_000,
        rate="12",
        withheld_pp=19_308,
        withheld_yr=502_008,
        taxable_income=8_780_000,
        tax=1_004_000,
        tax_after=1_004_000,
        refund=16,
        schedule="step2_checkbox",
        keys=[*BASE_KEYS, MULTIPLE_JOBS],
    )


def test_second_job_without_step2_owes() -> None:
    expect(
        run(5_000_000, 26, other_jobs_wages_cents=2_000_000, other_jobs_withholding_cents=39_000),
        taxable_pp=192_308,
        aaw=4_140_000,
        rate="12",
        withheld_pp=14_692,
        withheld_yr=381_992,
        taxable_income=5_390_000,
        tax=657_000,
        tax_after=657_000,
        refund=-236_008,
        suggestion="increase_extra_withholding",
        suggested_4c=9_100,
        suggested_refund=592,
        keys=[*BASE_KEYS, MULTIPLE_JOBS],
    )


def test_dependents_credit_exceeds_tax() -> None:
    expect(
        run(4_000_000, 26, "head_of_household", dependents_credit_cents=440_000),
        taxable_pp=153_846,
        aaw=3_140_000,
        rate="10",
        withheld_pp=0,
        withheld_yr=0,
        taxable_income=1_585_000,
        tax=158_500,
        tax_after=0,
        refund=0,
        keys=[*BASE_KEYS, DEPENDENTS],
    )


def test_other_income_and_deductions() -> None:
    expect(
        run(8_000_000, 24, other_income_cents=200_000, deductions_cents=500_000),
        taxable_pp=333_333,
        aaw=6_840_000,
        rate="22",
        withheld_pp=33_792,
        withheld_yr=811_008,
        taxable_income=6_090_000,
        tax=811_000,
        tax_after=811_000,
        refund=8,
        suggested_4b=500_000,
    )


def test_extra_withholding_lowered() -> None:
    expect(
        run(6_500_000, 26, extra_withholding_cents=10_000),
        taxable_pp=250_000,
        aaw=5_640_000,
        rate="12",
        withheld_pp=31_615,
        withheld_yr=821_990,
        taxable_income=4_890_000,
        tax=562_000,
        tax_after=562_000,
        refund=259_990,
        suggestion="decrease_extra_withholding",
        suggested_4c=0,
        suggested_refund=-10,
    )


def test_step2_unequal_jobs_adds_deductions() -> None:
    expect(
        run(
            9_000_000,
            26,
            "married_filing_jointly",
            multiple_jobs=True,
            other_jobs_wages_cents=3_000_000,
            other_jobs_withholding_cents=142_012,
        ),
        taxable_pp=346_154,
        aaw=9_000_000,
        rate="22",
        withheld_pp=42_192,
        withheld_yr=1_096_992,
        taxable_income=8_780_000,
        tax=1_004_000,
        tax_after=1_004_000,
        refund=235_004,
        suggestion="increase_deductions",
        suggested_4b=1_068_300,
        suggested_refund=-10,
        schedule="step2_checkbox",
        keys=[*BASE_KEYS, MULTIPLE_JOBS],
    )


def test_401k_capped_at_402g() -> None:
    expect(
        run(25_000_000, 26, k401_contribution_pct="15", age=30),
        taxable_pp=867_308,
        aaw=21_690_000,
        rate="32",
        withheld_pp=167_169,
        withheld_yr=4_346_394,
        taxable_income=20_940_000,
        tax=4_346_400,
        tax_after=4_346_400,
        refund=-6,
        k401=2_450_000,
        capped=True,
        keys=[*BASE_KEYS, PRETAX],
    )


# ------------------------------------------- rule 10a: at the stub's withholding

COMPARISON = {"current_annual_withholding_cents", "current_refund_cents"}


def comparison(result: W4Result) -> tuple[int | None, int | None]:
    return result.current_annual_withholding_cents, result.current_refund_cents


def test_stub_withholds_less_than_the_entries() -> None:
    """The e2e account (issue 153): stub-01's $272.44 a paycheck leaves $3,918.70 due."""
    result = run(
        9_500_010,
        26,
        k401_contribution_pct="5",
        age=24,
        health_premium_per_paycheck_cents=400,
        current_withholding_per_paycheck_cents=27_244,
    )
    expect(
        result,
        taxable_pp=346_716,
        aaw=8_154_610,
        rate="22",
        withheld_pp=42_316,
        withheld_yr=1_100_216,
        taxable_income=7_404_610,
        tax=1_100_214,
        tax_after=1_100_214,
        refund=2,
        k401=475_001,
        keys=[*BASE_KEYS, PRETAX],
    )
    assert comparison(result) == (708_344, -391_870)


def test_stub_withholds_more_than_the_entries() -> None:
    result = run(
        6_500_000,
        24,
        k401_contribution_pct="4",
        age=30,
        health_premium_per_paycheck_cents=6_250,
        current_withholding_per_paycheck_cents=29_776,
    )
    expect(
        result,
        taxable_pp=253_750,
        aaw=5_230_000,
        rate="12",
        withheld_pp=21_367,
        withheld_yr=512_808,
        taxable_income=4_480_000,
        tax=512_800,
        tax_after=512_800,
        refund=8,
        k401=260_000,
        keys=[*BASE_KEYS, PRETAX],
    )
    assert comparison(result) == (714_624, 201_824)


def test_stub_comparison_counts_other_jobs() -> None:
    result = run(
        5_000_000,
        26,
        other_jobs_wages_cents=2_000_000,
        other_jobs_withholding_cents=39_000,
        current_withholding_per_paycheck_cents=14_700,
    )
    expect(
        result,
        taxable_pp=192_308,
        aaw=4_140_000,
        rate="12",
        withheld_pp=14_692,
        withheld_yr=381_992,
        taxable_income=5_390_000,
        tax=657_000,
        tax_after=657_000,
        refund=-236_008,
        suggestion="increase_extra_withholding",
        suggested_4c=9_100,
        suggested_refund=592,
        keys=[*BASE_KEYS, MULTIPLE_JOBS],
    )
    assert comparison(result) == (382_200, -235_800)


def test_stub_withholds_nothing() -> None:
    result = run(6_500_000, 26, current_withholding_per_paycheck_cents=0)
    expect(
        result,
        taxable_pp=250_000,
        aaw=5_640_000,
        rate="12",
        withheld_pp=21_615,
        withheld_yr=561_990,
        taxable_income=4_890_000,
        tax=562_000,
        tax_after=562_000,
        refund=-10,
    )
    assert comparison(result) == (0, -562_000)


def test_no_stub_no_comparison() -> None:
    result = run(6_500_000, 26, current_withholding_per_paycheck_cents=None)
    assert comparison(result) == (None, None)
    assert result == run(6_500_000, 26)
    with_stub = run(6_500_000, 26, current_withholding_per_paycheck_cents=0)
    assert result.model_dump(exclude=COMPARISON) == with_stub.model_dump(exclude=COMPARISON)


# Spec 008 rule 7b: the explanation reads rule 10a's figures from a saved decision's
# own result, which may predate rule 10a, so it never reruns the calculator.
@pytest.mark.parametrize(
    ("salary", "periods", "entries", "stub", "expected"),
    [
        (
            9_500_010,
            26,
            {"k401_contribution_pct": "5", "age": 24, "health_premium_per_paycheck_cents": 400},
            27_244,
            (708_344, -391_870),
        ),
        (
            6_500_000,
            24,
            {"k401_contribution_pct": "4", "age": 30, "health_premium_per_paycheck_cents": 6_250},
            29_776,
            (714_624, 201_824),
        ),
        (
            5_000_000,
            26,
            {"other_jobs_wages_cents": 2_000_000, "other_jobs_withholding_cents": 39_000},
            14_700,
            (382_200, -235_800),
        ),
        (6_500_000, 26, {}, 0, (0, -562_000)),
    ],
)
def test_at_withholding_is_rule_10a_from_a_saved_result(
    salary: int, periods: int, entries: dict[str, Any], stub: int, expected: tuple[int, int]
) -> None:
    saved = run(salary, periods, **entries)
    assert comparison(saved) == (None, None)
    data = W4Input.model_validate(
        {
            "salary_cents": salary,
            "pay_periods_per_year": periods,
            "filing_status": "single",
            "tax_year": 2026,
            **entries,
        }
    )
    annual, refund = expected
    assert at_withholding(data, saved, stub) == AtWithholding(
        annual_withholding_cents=annual, refund_cents=refund
    )
    compared = run(salary, periods, **entries, current_withholding_per_paycheck_cents=stub)
    assert comparison(compared) == (annual, refund)


def test_result_without_the_comparison_still_reads() -> None:
    """A result stored before rule 10a has neither field; it reads as null (rule 17a)."""
    stored = run(6_500_000, 26).model_dump(mode="json")
    for key in COMPARISON:
        stored.pop(key, None)
    assert comparison(W4Result.model_validate(stored)) == (None, None)


# ------------------------------------------------------------------ edge cases


def test_adjusted_wage_on_a_row_boundary() -> None:
    """AAW equal to a row's column B takes the next row."""
    result = run(6_650_000, 26)
    assert result.adjusted_annual_wage_cents == 5_790_000
    assert result.withholding_rate_pct == Decimal(22)
    assert result.withholding_per_paycheck_cents == 22_308


def test_catch_up_raises_the_deferral_limit() -> None:
    result = run(25_000_000, 26, k401_contribution_pct="13", age=52)
    assert (result.k401_annual_cents, result.k401_capped) == (3_250_000, False)
    assert result.adjusted_annual_wage_cents == 20_890_000
    assert result.withholding_rate_pct == Decimal(24)
    assert result.withholding_per_paycheck_cents == 157_438


def test_no_age_means_no_catch_up() -> None:
    result = run(25_000_000, 26, k401_contribution_pct="13")
    assert (result.k401_annual_cents, result.k401_capped) == (2_450_000, True)


def test_step2_without_other_job_suggests_deductions() -> None:
    result = run(6_500_000, 26, multiple_jobs=True)
    assert result.withholding_per_paycheck_cents == 38_335
    assert result.projected_refund_cents == 434_710
    assert result.suggestion == "increase_deductions"
    assert result.suggested_deductions_cents == 1_938_700
    assert result.suggested_refund_cents == -10
    assert result.citation_keys == [*BASE_KEYS, MULTIPLE_JOBS]


def test_saved_deductions_adjustment_projects_the_same_tax() -> None:
    """Example 9's suggestion saved with the expected deductions kept at 0."""
    result = run(
        9_000_000,
        26,
        "married_filing_jointly",
        multiple_jobs=True,
        other_jobs_wages_cents=3_000_000,
        other_jobs_withholding_cents=142_012,
        deductions_cents=1_068_300,
        expected_deductions_cents=0,
    )
    assert result.projected_tax_cents == 1_004_000
    assert result.projected_refund_cents == -10
    assert result.suggestion == "none"
    assert result.suggested_deductions_cents == 1_068_300


def test_refund_from_other_jobs_has_no_suggestion() -> None:
    result = run(
        1_000_000, 26, other_jobs_wages_cents=2_000_000, other_jobs_withholding_cents=500_000
    )
    assert result.withholding_per_paycheck_cents == 0
    assert result.projected_tax_cents == 142_000
    assert result.projected_refund_cents == 358_000
    assert result.suggestion == "none"
    assert result.suggested_refund_cents == 358_000
    assert (result.suggested_extra_withholding_cents, result.suggested_deductions_cents) == (0, 0)


def test_premiums_and_deferral_above_salary_are_invalid() -> None:
    with pytest.raises(ValidationError, match="exceed the salary"):
        run(1_000_000, 26, health_premium_per_paycheck_cents=40_000)
    with pytest.raises(ValidationError, match="exceed the salary"):
        run(1_000_000, 26, k401_contribution_pct="90", health_premium_per_paycheck_cents=5_000)


def test_tax_year_without_constants_is_invalid() -> None:
    with pytest.raises(ValidationError, match="2027"):
        W4Input.model_validate(
            {
                "salary_cents": 5_000_000,
                "pay_periods_per_year": 26,
                "filing_status": "single",
                "tax_year": 2027,
            }
        )


@pytest.mark.parametrize(
    "change",
    [
        {"pay_periods_per_year": 27},
        {"salary_cents": 0},
        {"salary_cents": 5_000_000.5},
        {"k401_contribution_pct": "101"},
        {"extra_withholding_cents": -1},
        {"age": 131},
        {"filing_status": "married_filing_separately"},
        {"surprise": 1},
        {"current_withholding_per_paycheck_cents": -1},
        {"current_withholding_per_paycheck_cents": 272.44},
    ],
)
def test_invalid_inputs(change: dict[str, Any]) -> None:
    body = {
        "salary_cents": 5_000_000,
        "pay_periods_per_year": 26,
        "filing_status": "single",
        "tax_year": 2026,
        **change,
    }
    with pytest.raises(ValidationError):
        W4Input.model_validate(body)
