"""calc/cashflow.py: stage-1 withholding lines (spec 010 part A, hand-worked examples)."""

from __future__ import annotations

from decimal import Decimal
from typing import Any

import pytest
from hypothesis import given
from hypothesis import strategies as st

from calc.cashflow import (
    LINES,
    PLAN_DIRECTIONS,
    PlanDirection,
    PlanTargets,
    RoleTotals,
    SpendingActuals,
    against_plan,
    plan_status,
    withholding,
)
from calc.pay_stub import PayStubAmounts

MOCKUP: dict[str, int] = {
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
WITH_401K: dict[str, int] = {
    **MOCKUP,
    "federal_withholding_cents": 28_476,
    "retirement_contribution_cents": 10_833,
    "net_cents": 190_071,
}


def stub(**fields: Any) -> PayStubAmounts:
    return PayStubAmounts(**fields)


def amounts(lines: Any) -> dict[str, int]:
    return {line.key: line.amount_cents for line in lines}


def test_line_order_labels_and_roles() -> None:
    assert [(line.key, line.label, line.role) for line in LINES] == [
        ("federal_withholding", "Federal tax", "tax"),
        ("social_security", "Social Security", "tax"),
        ("medicare", "Medicare", "tax"),
        ("state_tax", "State tax", "tax"),
        ("retirement_contribution", "401(k)", "retirement"),
        ("medical_premium", "Health premiums", "health"),
        ("other_deductions", "Other deductions", "other"),
    ]


def test_one_stub_lines() -> None:
    flow = withholding([stub(**WITH_401K)])
    [one] = flow.stubs
    assert amounts(one.lines) == {
        "federal_withholding": 28_476,
        "social_security": 16_792,
        "medicare": 3_927,
        "state_tax": 9_814,
        "retirement_contribution": 10_833,
        "medical_premium": 6_250,
        "other_deductions": 4_670,
    }
    assert one.roles == RoleTotals(
        tax_cents=59_009, retirement_cents=10_833, health_cents=6_250, other_cents=4_670
    )
    assert (one.gross_cents, one.deductions_cents, one.net_cents) == (270_833, 80_762, 190_071)
    assert flow.total == one
    assert flow.paycheck_count == 1


def test_two_mockup_stubs_sum() -> None:
    flow = withholding([stub(**MOCKUP), stub(**MOCKUP)])
    total = flow.total
    assert amounts(total.lines) == {
        "federal_withholding": 59_552,
        "social_security": 33_584,
        "medicare": 7_854,
        "state_tax": 19_628,
        "retirement_contribution": 0,
        "medical_premium": 12_500,
        "other_deductions": 9_340,
    }
    assert total.roles.tax_cents == 120_618
    assert (total.gross_cents, total.deductions_cents, total.net_cents) == (
        541_666,
        142_458,
        399_208,
    )
    assert [one.net_cents for one in flow.stubs] == [199_604, 199_604]
    assert flow.paycheck_count == 2


def test_no_stubs_is_all_zero() -> None:
    flow = withholding([])
    assert flow.stubs == []
    assert flow.paycheck_count == 0
    assert [line.amount_cents for line in flow.total.lines] == [0] * 7
    assert (flow.total.gross_cents, flow.total.deductions_cents, flow.total.net_cents) == (0, 0, 0)
    assert flow.total.roles == RoleTotals(
        tax_cents=0, retirement_cents=0, health_cents=0, other_cents=0
    )


def test_unbalanced_stub_raises() -> None:
    with pytest.raises(ValueError, match="does not balance"):
        withholding([stub(**{**WITH_401K, "net_cents": 190_072})])


money = st.integers(min_value=0, max_value=10_000_000)


@given(st.lists(st.lists(money, min_size=7, max_size=7), max_size=6))
def test_totals_are_sums_and_every_stub_balances(deductions: list[list[int]]) -> None:
    stubs = []
    for parts in deductions:
        gross = sum(parts) + 100_000
        keys = [f"{line.key}_cents" for line in LINES]
        stubs.append(
            stub(gross_cents=gross, net_cents=100_000, **dict(zip(keys, parts, strict=True)))
        )
    flow = withholding(stubs)
    assert flow.total.gross_cents == sum(one.gross_cents for one in flow.stubs)
    assert flow.total.net_cents == sum(one.net_cents for one in flow.stubs)
    roles = flow.total.roles
    assert (
        roles.tax_cents + roles.retirement_cents + roles.health_cents + roles.other_cents
        == flow.total.deductions_cents
    )
    assert flow.total.gross_cents - flow.total.deductions_cents == flow.total.net_cents


# ---------------------------------------------------------------- against the plan (spec 015)

SEPTEMBER_SPENDING = SpendingActuals(
    income_cents=399_208,
    essentials_cents=180_000,
    flexible_cents=8_500,
    other_cents=3_900,
    savings_cents=40_000,
    left_over_cents=166_808,
)


def plan_lines(targets: PlanTargets) -> dict[str, tuple[int, int | None, int | None]]:
    september = withholding(
        [PayStubAmounts.model_validate(MOCKUP), PayStubAmounts.model_validate(MOCKUP)]
    )
    lines = against_plan(september.total, september.paycheck_count, SEPTEMBER_SPENDING, targets)
    return {line.key: (line.actual_cents, line.plan_cents, line.difference_cents) for line in lines}


ROW_2_TARGETS = PlanTargets(
    contribution_pct=Decimal("4"), premium_per_period_cents=6_250, monthly_savings_cents=50_000
)


def test_cash_flow_against_the_plan() -> None:
    # Spec 015 route row 2: the essentials have no plan (issue 269).
    lines = plan_lines(ROW_2_TARGETS)
    assert lines == {
        "income": (399_208, None, None),
        "essentials": (180_000, None, None),
        "flexible": (8_500, None, None),
        "other": (3_900, None, None),
        "savings": (40_000, 50_000, -10_000),
        "retirement": (0, 21_667, -21_667),
        "health": (12_500, 12_500, 0),
        "left_over": (166_808, None, None),
    }


def test_without_decisions_every_plan_is_null() -> None:
    lines = plan_lines(PlanTargets())
    assert all(plan is None and difference is None for _, plan, difference in lines.values())
    assert all(
        line.status is None
        for line in against_plan(withholding([]).total, 0, SEPTEMBER_SPENDING, PlanTargets())
    )
    assert list(lines) == [
        "income",
        "essentials",
        "flexible",
        "other",
        "savings",
        "retirement",
        "health",
        "left_over",
    ]


def september_lines(targets: PlanTargets) -> dict[str, Any]:
    september = withholding(
        [PayStubAmounts.model_validate(MOCKUP), PayStubAmounts.model_validate(MOCKUP)]
    )
    return {
        line.key: line
        for line in against_plan(
            september.total, september.paycheck_count, SEPTEMBER_SPENDING, targets
        )
    }


def test_plan_line_status_in_route_row_2() -> None:
    # Spec 015 rule 19a: the route row 2 lines with their statuses.
    lines = september_lines(ROW_2_TARGETS)
    assert {key: line.status for key, line in lines.items()} == {
        "income": None,
        "essentials": None,
        "flexible": None,
        "other": None,
        "savings": "behind",
        "retirement": "behind",
        "health": "on_plan",
        "left_over": None,
    }


def test_saving_more_than_planned_is_ahead_of_plan() -> None:
    """Spec 015 route row 2b, issue 269: more saved than planned is ahead, not
    "over", which read the same as overspending."""
    lines = september_lines(ROW_2_TARGETS.model_copy(update={"monthly_savings_cents": 30_000}))
    savings = lines["savings"]
    assert (savings.actual_cents, savings.plan_cents, savings.difference_cents) == (
        40_000,
        30_000,
        10_000,
    )
    assert savings.status == "ahead"
    essentials = lines["essentials"]
    assert (essentials.plan_cents, essentials.difference_cents, essentials.status) == (
        None,
        None,
        None,
    )


def test_deposits_are_income_deposited() -> None:
    """Issue 235: the line is the deposits Spending calls Income deposited, not
    take-home pay, which is the pay stub's net."""
    lines = against_plan(
        withholding([]).total, 0, SEPTEMBER_SPENDING, PlanTargets(contribution_pct=Decimal("4"))
    )
    assert (lines[0].key, lines[0].label) == ("income", "Income deposited")


def test_a_period_without_a_pay_stub_has_no_pay_stub_plan_yet() -> None:
    """Spec 015 rule 19: with no stub the 401(k) and health plans are not known;
    they read "plan $0.00, On plan" before."""
    targets = PlanTargets(
        contribution_pct=Decimal("4"), premium_per_period_cents=6_250, monthly_savings_cents=50_000
    )
    lines = {
        line.key: line
        for line in against_plan(withholding([]).total, 0, SEPTEMBER_SPENDING, targets)
    }
    for key in ("retirement", "health"):
        assert (lines[key].actual_cents, lines[key].plan_cents) == (0, None)
        assert (lines[key].difference_cents, lines[key].status) == (None, None)
        assert lines[key].needs_pay_stub is True
    assert [key for key, line in lines.items() if line.needs_pay_stub] == ["retirement", "health"]
    assert (lines["savings"].plan_cents, lines["savings"].status) == (50_000, "behind")


def test_without_a_decision_a_missing_stub_waits_for_nothing() -> None:
    lines = against_plan(withholding([]).total, 0, SEPTEMBER_SPENDING, PlanTargets())
    assert not any(line.needs_pay_stub for line in lines)


def test_a_period_with_a_stub_needs_none() -> None:
    september = withholding([PayStubAmounts.model_validate(MOCKUP)])
    lines = against_plan(
        september.total,
        september.paycheck_count,
        SEPTEMBER_SPENDING,
        PlanTargets(contribution_pct=Decimal("4"), premium_per_period_cents=6_250),
    )
    assert not any(line.needs_pay_stub for line in lines)


@pytest.mark.parametrize(
    ("direction", "plan", "actual", "expected"),
    [
        ("match", 250_000, 180_000, "under"),
        ("more_is_better", 50_000, 40_000, "behind"),
        ("more_is_better", 21_667, 0, "behind"),
        ("match", 12_500, 12_500, "on_plan"),
        ("match", 250_000, 262_500, "on_plan"),
        ("match", 250_000, 262_501, "over"),
        ("match", 250_000, 237_500, "on_plan"),
        ("match", 250_000, 237_499, "under"),
        ("more_is_better", 10_000, 12_500, "on_plan"),
        ("more_is_better", 10_000, 7_499, "behind"),
        ("match", 0, 2_501, "over"),
        ("match", 250_010, 262_511, "on_plan"),
        ("match", 250_010, 262_512, "over"),
        ("more_is_better", 10_000, 13_983, "ahead"),
        ("more_is_better", 21_667, 24_168, "ahead"),
        ("more_is_better", 50_000, 62_501, "ahead"),
    ],
    ids=[f"row-{n}" for n in (*range(1, 14), 15, 16, 17)],
)
def test_plan_status_examples(
    direction: PlanDirection, plan: int, actual: int, expected: str
) -> None:
    # Spec 015 plan line status table: 5% of the plan or $25, whichever is larger,
    # then what the side means for the line (row 14, no plan, is the route rows).
    assert plan_status(actual, plan, direction) == expected


def test_each_line_with_a_plan_has_a_direction() -> None:
    # Spec 015 rule 19a: saving and contributing more is better; premiums should match.
    assert PLAN_DIRECTIONS == {
        "savings": "more_is_better",
        "retirement": "more_is_better",
        "health": "match",
    }


@given(
    direction=st.sampled_from(["more_is_better", "match"]),
    plan=st.integers(min_value=0, max_value=10**9),
    actual=st.integers(min_value=0, max_value=10**9),
)
def test_plan_status_is_symmetric_around_the_plan(
    direction: PlanDirection, plan: int, actual: int
) -> None:
    status = plan_status(actual, plan, direction)
    mirrored = plan_status(2 * plan - actual, plan, direction)
    flip = {
        "over": "under",
        "under": "over",
        "ahead": "behind",
        "behind": "ahead",
        "on_plan": "on_plan",
    }
    assert mirrored == flip[status]
    if actual == plan:
        assert status == "on_plan"
    if direction == "more_is_better":
        assert status not in ("over", "under")
    else:
        assert status not in ("ahead", "behind")
