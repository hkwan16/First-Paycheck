"""Entry limits (spec 007 rules 2a and 2b; specs 006, 011, 012 and 014; issues 228, 238).

What a person may enter is bounded more tightly than what a calculator can
compute with: every input within the limits gives a result (before, a
monthly essentials of $1 billion overflowed the result and answered 500),
each refusal is a sentence on its field that names the range, and a stored
version is read without the limits (``calc.types.STORED``).
"""

from __future__ import annotations

from decimal import Decimal
from typing import Any

import pytest
from hypothesis import assume, given, settings
from hypothesis import strategies as st
from pydantic import BaseModel, ValidationError

from calc.emergency_fund import EmergencyFundInput, emergency_fund
from calc.health_plans import HealthPlansInput, health_plans
from calc.k401 import K401MatchInput, k401_match
from calc.types import MAX_PERIOD_CENTS, MAX_YEARLY_CENTS, STORED, dollars
from calc.w4 import MAX_STEP3_CREDITS_CENTS, W4Input, w4
from tests.unit.calc.test_health_plans_examples import A, B, payload

EXAMPLES = settings(max_examples=150)

FUND: dict[str, Any] = {
    "monthly_essentials_cents": 182_325,
    "target_months": 3,
    "current_balance_cents": 214_000,
    "monthly_contribution_cents": 30_000,
    "pay_periods_per_year": 24,
}
W4: dict[str, Any] = {
    "salary_cents": 6_500_000,
    "pay_periods_per_year": 24,
    "filing_status": "single",
    "tax_year": 2026,
}
K401: dict[str, Any] = {
    "salary_cents": 6_500_000,
    "pay_periods_per_year": 24,
    "match_tiers": [{"employee_pct_upto": "4", "employer_pct": "100"}],
    "contribution_pct": "4",
    "tax_year": 2026,
    "filing_status": "single",
    "age": 30,
}


def refusal(model: type[BaseModel], body: dict[str, Any]) -> list[tuple[tuple[Any, ...], str]]:
    """Each problem as (where, the sentence the API sends: a validator's own)."""
    with pytest.raises(ValidationError) as caught:
        model.model_validate(body)
    return [
        (error["loc"], str((error.get("ctx") or {}).get("error", error["msg"])))
        for error in caught.value.errors()
    ]


def test_dollars_writes_cents_as_a_person_reads_them() -> None:
    assert dollars(0) == "$0.00"
    assert dollars(5) == "$0.05"
    assert dollars(440_000) == "$4,400.00"
    assert dollars(MAX_YEARLY_CENTS) == "$10,000,000.00"
    assert dollars(MAX_PERIOD_CENTS) == "$1,000,000.00"


# ---------------------------------------------------------------- the emergency fund (spec 011)


@pytest.mark.parametrize(
    ("field", "sentence"),
    [
        ("monthly_essentials_cents", "Enter essential spending up to $1,000,000.00 a month."),
        ("monthly_contribution_cents", "Enter a transfer up to $1,000,000.00 a month."),
    ],
)
def test_fund_monthly_amounts_are_refused_above_the_limit(field: str, sentence: str) -> None:
    assert refusal(EmergencyFundInput, {**FUND, field: MAX_PERIOD_CENTS + 1}) == [
        ((field,), sentence)
    ]
    # At the limit it computes.
    emergency_fund(EmergencyFundInput.model_validate({**FUND, field: MAX_PERIOD_CENTS}))


@EXAMPLES
@given(
    st.integers(1, MAX_PERIOD_CENTS),
    st.integers(1, 12),
    st.integers(0, 100_000_000_000),
    st.integers(0, MAX_PERIOD_CENTS),
)
def test_every_fund_within_the_limits_computes(
    essentials: int, months: int, balance: int, contribution: int
) -> None:
    emergency_fund(
        EmergencyFundInput.model_validate(
            {
                **FUND,
                "monthly_essentials_cents": essentials,
                "target_months": months,
                "current_balance_cents": balance,
                "monthly_contribution_cents": contribution,
            }
        )
    )


def test_a_stored_fund_reads_above_the_limits() -> None:
    """Spec 007 rule 2b: a version saved under an older limit still reads."""
    stored = {**FUND, "monthly_essentials_cents": 2 * MAX_PERIOD_CENTS}
    data = EmergencyFundInput.model_validate(stored, context=STORED)
    assert data.monthly_essentials_cents == 2 * MAX_PERIOD_CENTS


# ---------------------------------------------------------------- the W-4 (spec 014 rule 16a)


@pytest.mark.parametrize(
    ("field", "maximum", "sentence"),
    [
        ("salary_cents", MAX_YEARLY_CENTS, "Enter a salary up to $10,000,000.00 a year."),
        (
            "dependents_credit_cents",
            MAX_STEP3_CREDITS_CENTS,
            "Enter Step 3 credits up to $100,000.00 for the year.",
        ),
        (
            "other_income_cents",
            MAX_YEARLY_CENTS,
            "Enter Step 4(a) other income up to $10,000,000.00 a year.",
        ),
        (
            "deductions_cents",
            MAX_YEARLY_CENTS,
            "Enter Step 4(b) deductions up to $10,000,000.00 a year.",
        ),
        (
            "extra_withholding_cents",
            MAX_PERIOD_CENTS,
            "Enter Step 4(c) extra withholding up to $1,000,000.00 a paycheck.",
        ),
        (
            "expected_deductions_cents",
            MAX_YEARLY_CENTS,
            "Enter the deductions you expect to claim up to $10,000,000.00 a year.",
        ),
        (
            "other_jobs_wages_cents",
            MAX_YEARLY_CENTS,
            "Enter other jobs' wages up to $10,000,000.00 a year.",
        ),
        (
            "other_jobs_withholding_cents",
            MAX_YEARLY_CENTS,
            "Enter other jobs' withholding up to $10,000,000.00 a year.",
        ),
        (
            "health_premium_per_paycheck_cents",
            MAX_PERIOD_CENTS,
            "Enter a health premium up to $1,000,000.00 a paycheck.",
        ),
        (
            "current_withholding_per_paycheck_cents",
            MAX_PERIOD_CENTS,
            "Enter federal withholding up to $1,000,000.00 a paycheck.",
        ),
    ],
)
def test_w4_amounts_are_refused_above_their_limits(field: str, maximum: int, sentence: str) -> None:
    assert refusal(W4Input, {**W4, field: maximum + 1}) == [((field,), sentence)]


def test_step_3_of_999_999_dollars_is_refused() -> None:
    """Issue 238: a Step 3 of $999,999 was calculated as no tax at all."""
    assert refusal(W4Input, {**W4, "dependents_credit_cents": 99_999_900}) == [
        (("dependents_credit_cents",), "Enter Step 3 credits up to $100,000.00 for the year.")
    ]
    w4(W4Input.model_validate({**W4, "dependents_credit_cents": MAX_STEP3_CREDITS_CENTS}))


YEARLY = st.sampled_from([0, 1, MAX_YEARLY_CENTS // 2, MAX_YEARLY_CENTS])
PERIOD = st.sampled_from([0, 1, MAX_PERIOD_CENTS // 2, MAX_PERIOD_CENTS])


@EXAMPLES
@given(
    salary=st.sampled_from([1, 6_500_000, MAX_YEARLY_CENTS]),
    periods=st.sampled_from([12, 24, 26, 52]),
    pct=st.sampled_from(["0", "4", "100"]),
    premium=PERIOD,
    credits=st.sampled_from([0, MAX_STEP3_CREDITS_CENTS]),
    other_income=YEARLY,
    deductions=YEARLY,
    extra=PERIOD,
    expected=st.none() | YEARLY,
    other_wages=YEARLY,
    other_withholding=YEARLY,
    current=st.none() | PERIOD,
    multiple_jobs=st.booleans(),
    status=st.sampled_from(["single", "married_filing_jointly", "head_of_household"]),
)
def test_every_w4_within_the_limits_computes(
    salary: int,
    periods: int,
    pct: str,
    premium: int,
    credits: int,
    other_income: int,
    deductions: int,
    extra: int,
    expected: int | None,
    other_wages: int,
    other_withholding: int,
    current: int | None,
    multiple_jobs: bool,
    status: str,
) -> None:
    assume(Decimal(salary) * Decimal(pct) / 100 + premium * periods <= salary)
    w4(
        W4Input.model_validate(
            {
                **W4,
                "salary_cents": salary,
                "pay_periods_per_year": periods,
                "filing_status": status,
                "k401_contribution_pct": pct,
                "health_premium_per_paycheck_cents": premium,
                "multiple_jobs": multiple_jobs,
                "dependents_credit_cents": credits,
                "other_income_cents": other_income,
                "deductions_cents": deductions,
                "extra_withholding_cents": extra,
                "expected_deductions_cents": expected,
                "other_jobs_wages_cents": other_wages,
                "other_jobs_withholding_cents": other_withholding,
                "current_withholding_per_paycheck_cents": current,
            }
        )
    )


def test_a_stored_w4_reads_above_the_limits() -> None:
    stored = {**W4, "dependents_credit_cents": 99_999_900}
    assert W4Input.model_validate(stored, context=STORED).dependents_credit_cents == 99_999_900


# ---------------------------------------------------------------- the 401(k) (spec 006 rule 13a)


def test_k401_salary_is_refused_above_the_limit() -> None:
    assert refusal(K401MatchInput, {**K401, "salary_cents": MAX_YEARLY_CENTS + 1}) == [
        (("salary_cents",), "Enter a salary up to $10,000,000.00 a year.")
    ]
    k401_match(K401MatchInput.model_validate({**K401, "salary_cents": MAX_YEARLY_CENTS}))
    stored = {**K401, "salary_cents": MAX_YEARLY_CENTS + 1}
    assert (
        K401MatchInput.model_validate(stored, context=STORED).salary_cents == stored["salary_cents"]
    )


# ---------------------------------------------------------------- health plans (spec 012)

# Issue 228's plan: an out-of-pocket maximum of $100 under a $2,050 deductible.
LOW_MAXIMUM = {**B, "deductible_cents": 205_000, "oop_max_cents": 10_000}


def test_a_maximum_under_the_deductible_is_refused_on_its_field_naming_the_plan() -> None:
    """Issue 228: the refusal named no plan and no field, so the table could not say where."""
    assert refusal(HealthPlansInput, payload([A, LOW_MAXIMUM], 6_500_000, 0)) == [
        (
            ("plans", 1, "oop_max_cents"),
            "Gold PPO: enter an out-of-pocket maximum of at least the deductible, $2,050.00.",
        )
    ]


def test_the_two_plan_rules_hold_for_a_stored_decision_too() -> None:
    """Rule 12 is the calculator's own invariant, not an entry limit."""
    with pytest.raises(ValidationError):
        HealthPlansInput.model_validate(payload([LOW_MAXIMUM], 6_500_000, 0), context=STORED)
    with pytest.raises(ValidationError):
        HealthPlansInput.model_validate(
            payload([{**B, "employer_hsa_cents": 100}], 6_500_000, 0), context=STORED
        )


def test_employer_hsa_money_on_a_plan_that_is_not_hdhp_is_refused_on_its_field() -> None:
    assert refusal(
        HealthPlansInput, payload([A, {**B, "employer_hsa_cents": 100}], 6_500_000, 0)
    ) == [
        (
            ("plans", 1, "employer_hsa_cents"),
            "Gold PPO: only a high-deductible plan can have an employer HSA contribution.",
        )
    ]


def test_employer_hsa_money_above_the_years_limit_is_refused_naming_the_plan() -> None:
    """Issue 228: $99,999 of employer HSA money was compared as if the person received it."""
    over = {**A, "employer_hsa_cents": 9_999_900}
    assert refusal(HealthPlansInput, payload([B, over], 6_500_000, 0)) == [
        (
            ("plans", 1, "employer_hsa_cents"),
            "Bronze HSA: enter an employer HSA contribution up to $4,400.00,"
            " the 2026 HSA limit for one person.",
        )
    ]
    # At the limit it computes, and a stored decision above it still reads (rule 2b).
    health_plans(
        HealthPlansInput.model_validate(
            payload([B, {**A, "employer_hsa_cents": 440_000}], 6_500_000, 0)
        )
    )
    stored = HealthPlansInput.model_validate(payload([B, over], 6_500_000, 0), context=STORED)
    assert stored.plans[1].employer_hsa_cents == 9_999_900


@pytest.mark.parametrize(
    ("field", "maximum", "sentence"),
    [
        (
            "premium_per_period_cents",
            MAX_PERIOD_CENTS,
            "Gold PPO: enter a premium up to $1,000,000.00 a paycheck.",
        ),
        (
            "deductible_cents",
            MAX_YEARLY_CENTS,
            "Gold PPO: enter a deductible up to $10,000,000.00 a year.",
        ),
        (
            "oop_max_cents",
            MAX_YEARLY_CENTS,
            "Gold PPO: enter an out-of-pocket maximum up to $10,000,000.00 a year.",
        ),
    ],
)
def test_plan_amounts_are_refused_above_their_limits_naming_the_plan(
    field: str, maximum: int, sentence: str
) -> None:
    # The maximum at its own limit, so only the field's limit is broken.
    plan = {**B, "oop_max_cents": MAX_YEARLY_CENTS, field: maximum + 1}
    assert (("plans", 0, field), sentence) in refusal(
        HealthPlansInput, payload([plan], 6_500_000, 0)
    )


@pytest.mark.parametrize(
    ("field", "maximum", "sentence"),
    [
        ("salary_cents", MAX_YEARLY_CENTS, "Enter a salary up to $10,000,000.00 a year."),
        (
            "employee_hsa_cents",
            MAX_YEARLY_CENTS,
            "Enter your own HSA contribution up to $10,000,000.00 a year.",
        ),
    ],
)
def test_health_amounts_are_refused_above_their_limits(
    field: str, maximum: int, sentence: str
) -> None:
    body = {**payload([A, B], 6_500_000, 0), field: maximum + 1}
    assert refusal(HealthPlansInput, body) == [((field,), sentence)]


@EXAMPLES
@given(
    premium=PERIOD,
    deductible=YEARLY,
    spread=YEARLY,
    coinsurance=st.sampled_from(["0", "20", "100"]),
    employer=st.sampled_from([0, 440_000]),
    salary=st.sampled_from([1, 6_500_000, MAX_YEARLY_CENTS]),
    own=YEARLY,
    periods=st.sampled_from([12, 24, 26, 52]),
)
def test_every_comparison_within_the_limits_computes(
    premium: int,
    deductible: int,
    spread: int,
    coinsurance: str,
    employer: int,
    salary: int,
    own: int,
    periods: int,
) -> None:
    maximum = min(MAX_YEARLY_CENTS, deductible + spread)
    plan = {
        "name": "Edge HDHP",
        "kind": "hdhp",
        "premium_per_period_cents": premium,
        "deductible_cents": deductible,
        "coinsurance_pct": coinsurance,
        "oop_max_cents": maximum,
        "employer_hsa_cents": employer,
    }
    health_plans(
        HealthPlansInput.model_validate(
            {
                **payload([plan, B], salary, own),
                "pay_periods_per_year": periods,
            }
        )
    )
