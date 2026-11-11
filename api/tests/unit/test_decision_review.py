"""Which saved decisions need review, and the words for it (spec 007 rules 19a-19e)."""

from __future__ import annotations

import dataclasses
import datetime as dt
import uuid
from decimal import Decimal
from typing import Any

import pytest

from app.decision_review import ReviewContext, ReviewReason, review
from app.salary_review import SalaryReview
from calc.k401 import MatchTier
from db.enums import CalculatorKind, PayFrequency

TIERS = [
    {"employee_pct_upto": "3.00", "employer_pct": "100.00"},
    {"employee_pct_upto": "5.00", "employer_pct": "50.00"},
]
# Issue 222's account as it saved its decisions: stub-01's salary on 26 paychecks.
SAVED = ReviewContext(
    salary_cents=9_500_010,
    pay_periods_per_year=26,
    tax_year=2026,
    filing_status="single",
    birth_year=2002,
    match_tiers=(
        MatchTier(employee_pct_upto=Decimal("3"), employer_pct=Decimal("100")),
        MatchTier(employee_pct_upto=Decimal("5"), employer_pct=Decimal("50")),
    ),
    k401_contribution_pct=Decimal("5.00"),
    health_premium_per_paycheck_cents=400,
    salary_review=None,
)
K401: dict[str, Any] = {
    "salary_cents": 9_500_010,
    "pay_periods_per_year": 26,
    "match_tiers": TIERS,
    "contribution_pct": "5.00",
    "tax_year": 2026,
    "filing_status": "single",
    "age": 24,
}
HEALTH: dict[str, Any] = {
    "plans": [
        {
            "name": "Value HMO",
            "kind": "hmo",
            "premium_per_period_cents": 400,
            "deductible_cents": 150_000,
            "coinsurance_pct": "20.00",
            "oop_max_cents": 400_000,
            "employer_hsa_cents": 0,
        }
    ],
    "pay_periods_per_year": 26,
    "salary_cents": 9_500_010,
    "filing_status": "single",
    "tax_year": 2026,
    "employee_hsa_cents": 0,
    "expected_usage": "medium",
    "selected_plan_index": 0,
}
W4: dict[str, Any] = {
    "salary_cents": 9_500_010,
    "pay_periods_per_year": 26,
    "filing_status": "single",
    "tax_year": 2026,
    "k401_contribution_pct": "5.00",
    "age": 24,
    "health_premium_per_paycheck_cents": 400,
    "current_withholding_per_paycheck_cents": 27_244,
}
FUND: dict[str, Any] = {
    "monthly_essentials_cents": 182_300,
    "target_months": 3,
    "current_balance_cents": 214_000,
    "monthly_contribution_cents": 30_000,
    "pay_periods_per_year": 26,
}
EVERY = [
    (CalculatorKind.EMERGENCY_FUND, FUND),
    (CalculatorKind.K401_MATCH, K401),
    (CalculatorKind.HEALTH_PLANS, HEALTH),
    (CalculatorKind.W4, W4),
]
READS_SALARY = EVERY[1:]

SCHEDULE = ReviewReason(
    kind="changed",
    input="pay_periods_per_year",
    text="Your pay schedule changed from 26 to 24 paychecks a year.",
)
SALARY = ReviewReason(
    kind="changed",
    input="salary_cents",
    text="Your yearly salary changed from $95,000.10 to $64,999.92.",
)
UNCONFIRMED = ReviewReason(
    kind="salary_unconfirmed",
    input="salary_cents",
    text=(
        "Your newest pay stub comes to $64,999.92 a year, not the $95,000.10 in your plan"
        " details. Choose which salary to use."
    ),
)
# Spec 005 rule 24c, row 1: the Acme stub against the saved $95,000.10.
QUESTION = SalaryReview(
    pay_stub_id=uuid.uuid4(),
    pay_stub_date=dt.date(2026, 10, 15),
    frequency=PayFrequency.SEMIMONTHLY,
    periods_per_year=24,
    gross_cents=270_833,
    annual_salary_cents=6_499_992,
    salary_cents=9_500_010,
)


def now(**changes: Any) -> ReviewContext:
    return dataclasses.replace(SAVED, **changes)


@pytest.mark.parametrize(("calculator", "inputs"), EVERY)
def test_nothing_changed(calculator: CalculatorKind, inputs: dict[str, Any]) -> None:
    assert review(calculator, inputs, SAVED) == []


@pytest.mark.parametrize(("calculator", "inputs"), EVERY)
def test_issue_222_the_pay_schedule(calculator: CalculatorKind, inputs: dict[str, Any]) -> None:
    assert review(calculator, inputs, now(pay_periods_per_year=24)) == [SCHEDULE]


@pytest.mark.parametrize(("calculator", "inputs"), READS_SALARY)
def test_issue_221_the_open_salary_question_comes_last(
    calculator: CalculatorKind, inputs: dict[str, Any]
) -> None:
    context = now(pay_periods_per_year=24, salary_review=QUESTION)
    assert review(calculator, inputs, context) == [SCHEDULE, UNCONFIRMED]


@pytest.mark.parametrize(("calculator", "inputs"), READS_SALARY)
def test_the_stubs_salary_used(calculator: CalculatorKind, inputs: dict[str, Any]) -> None:
    context = now(pay_periods_per_year=24, salary_cents=6_499_992)
    assert review(calculator, inputs, context) == [SCHEDULE, SALARY]


def test_the_emergency_fund_reads_no_salary() -> None:
    context = now(salary_cents=6_499_992, salary_review=QUESTION)
    assert review(CalculatorKind.EMERGENCY_FUND, FUND, context) == []


def test_a_new_tax_year() -> None:
    year = ReviewReason(
        kind="changed", input="tax_year", text="The tax year changed from 2026 to 2027."
    )
    age = ReviewReason(
        kind="changed",
        input="age",
        text="Your age at the end of the tax year changed from 24 to 25.",
    )
    context = now(tax_year=2027)
    assert review(CalculatorKind.K401_MATCH, K401, context) == [year, age]
    assert review(CalculatorKind.HEALTH_PLANS, HEALTH, context) == [year]
    assert review(CalculatorKind.W4, W4, context) == [year, age]


def test_plan_details() -> None:
    filing = ReviewReason(
        kind="changed",
        input="filing_status",
        text="Your filing status changed from single to married filing jointly.",
    )
    match = ReviewReason(
        kind="changed",
        input="match_tiers",
        text=(
            "Your employer match changed from 100% of the first 3%, then 50% up to 5%"
            " to 100% of the first 4%."
        ),
    )
    context = now(
        filing_status="married_filing_jointly",
        match_tiers=(MatchTier(employee_pct_upto=Decimal("4"), employer_pct=Decimal("100")),),
    )
    assert review(CalculatorKind.K401_MATCH, K401, context) == [filing, match]
    assert review(CalculatorKind.HEALTH_PLANS, HEALTH, context) == [filing]
    # The W-4's filing status is an entry on its own step.
    assert review(CalculatorKind.W4, W4, context) == []


def test_the_w4_follows_the_other_saved_decisions() -> None:
    context = now(k401_contribution_pct=Decimal("6.00"), health_premium_per_paycheck_cents=6_250)
    assert review(CalculatorKind.W4, W4, context) == [
        ReviewReason(
            kind="changed",
            input="k401_contribution_pct",
            text="Your 401(k) decision changed from 5% to 6%.",
        ),
        ReviewReason(
            kind="changed",
            input="health_premium_per_paycheck_cents",
            text="Your health plan's premium changed from $4.00 to $62.50 a paycheck.",
        ),
    ]


def test_the_w4_without_a_birth_year() -> None:
    added = ReviewReason(kind="changed", input="age", text="Your birth year was added.")
    removed = ReviewReason(kind="changed", input="age", text="Your birth year was removed.")
    assert review(CalculatorKind.W4, {**W4, "age": None}, SAVED) == [added]
    assert review(CalculatorKind.W4, W4, now(birth_year=None)) == [removed]
    # A birth year after the tax year is no age at all, as the card sends it.
    assert review(CalculatorKind.W4, {**W4, "age": None}, now(birth_year=2027)) == []


def test_values_compare_by_value() -> None:
    """Older rows stored percentages as sent (``"5"``) and leave defaults out."""
    older = {**W4, "k401_contribution_pct": "5"}
    del older["age"]
    assert review(CalculatorKind.W4, older, now(birth_year=None)) == []
    assert (
        review(
            CalculatorKind.K401_MATCH,
            {
                **K401,
                "match_tiers": [
                    {"employee_pct_upto": "3", "employer_pct": "100"},
                    {"employee_pct_upto": "5", "employer_pct": "50"},
                ],
            },
            SAVED,
        )
        == []
    )


def test_unknown_values_are_not_compared() -> None:
    """No salary, schedule, stub, plan details or birth year: the step cannot calculate."""
    unknown = ReviewContext(
        salary_cents=None,
        pay_periods_per_year=None,
        tax_year=None,
        filing_status=None,
        birth_year=None,
        match_tiers=None,
        k401_contribution_pct=Decimal("0"),
        health_premium_per_paycheck_cents=0,
        salary_review=None,
    )
    for calculator, inputs in EVERY[:3]:
        assert review(calculator, inputs, unknown) == []
    # The 401(k) needs a birth year for its age; without one it is not compared.
    assert review(CalculatorKind.K401_MATCH, K401, now(birth_year=None)) == []
