"""Which calculator fields a plan shows (spec 016 rule 3, example 5)."""

from __future__ import annotations

from typing import Any

import pytest

from app.plan import PlanFigure, figures
from calc.emergency_fund import EmergencyFundInput, emergency_fund
from calc.w4 import W4Input, w4
from db.enums import CalculatorKind


def w4_figures(**entries: Any) -> list[PlanFigure]:
    inputs = W4Input.model_validate({"filing_status": "single", "tax_year": 2026, **entries})
    return figures(
        CalculatorKind.W4,
        inputs.model_dump(mode="json"),
        w4(inputs).model_dump(mode="json"),
    )


def keys(found: list[PlanFigure]) -> list[str]:
    return [figure.key for figure in found]


BASE_W4_KEYS = [
    "result.withholding_per_paycheck_cents",
    "result.projected_tax_after_credits_cents",
    "result.projected_refund_cents",
]


@pytest.mark.parametrize(
    ("entries", "extra"),
    [
        # Spec 014: a second job without Step 2 owes, so withhold more.
        (
            {
                "salary_cents": 5_000_000,
                "pay_periods_per_year": 26,
                "other_jobs_wages_cents": 2_000_000,
                "other_jobs_withholding_cents": 39_000,
            },
            ["result.suggested_extra_withholding_cents"],
        ),
        # Extra withholding that over-withholds is lowered.
        (
            {
                "salary_cents": 6_500_000,
                "pay_periods_per_year": 26,
                "extra_withholding_cents": 10_000,
            },
            ["result.suggested_extra_withholding_cents"],
        ),
        # Example 9: Step 2 with unequal jobs adds Step 4(b) deductions.
        (
            {
                "salary_cents": 9_000_000,
                "pay_periods_per_year": 26,
                "filing_status": "married_filing_jointly",
                "multiple_jobs": True,
                "other_jobs_wages_cents": 3_000_000,
                "other_jobs_withholding_cents": 142_012,
            },
            ["result.suggested_deductions_cents"],
        ),
        # Within $100 of zero: nothing to suggest.
        (
            {
                "salary_cents": 8_000_000,
                "pay_periods_per_year": 24,
                "other_income_cents": 200_000,
                "deductions_cents": 500_000,
            },
            [],
        ),
    ],
)
def test_w4_suggestion_figure_matches_the_suggestion(
    entries: dict[str, Any], extra: list[str]
) -> None:
    assert keys(w4_figures(**entries)) == BASE_W4_KEYS + extra


def test_w4_tax_label_names_the_year() -> None:
    found = w4_figures(salary_cents=6_500_000, pay_periods_per_year=24)
    assert found[1].label == "Projected federal tax for 2026"


def test_unreachable_fund_has_a_null_months_figure() -> None:
    inputs = EmergencyFundInput.model_validate(
        {
            "monthly_essentials_cents": 500_000,
            "target_months": 6,
            "current_balance_cents": 0,
            "monthly_contribution_cents": 1_000,
            "pay_periods_per_year": 26,
        }
    )
    found = figures(
        CalculatorKind.EMERGENCY_FUND,
        inputs.model_dump(mode="json"),
        emergency_fund(inputs).model_dump(mode="json"),
    )
    months = next(figure for figure in found if figure.key == "result.months_to_target")
    assert (months.kind, months.value) == ("count", None)
