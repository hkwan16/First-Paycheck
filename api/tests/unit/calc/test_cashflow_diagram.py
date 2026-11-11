"""calc/cashflow.py: the cash-flow diagram's nodes and bands (spec 010 rule 5b,
hand-worked examples D1-D6, issue #236)."""

from __future__ import annotations

from collections import defaultdict
from typing import Any

import pytest
from hypothesis import given
from hypothesis import strategies as st

from calc.cashflow import CashFlowWithholding, FlowDiagram, diagram, withholding
from calc.pay_stub import PayStubAmounts
from calc.spending import CategoryTotal
from sync.categories import CATEGORY_BUCKETS

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


def stubs(count: int) -> CashFlowWithholding:
    return withholding([PayStubAmounts.model_validate(MOCKUP)] * count)


def categories(**totals: int) -> list[CategoryTotal]:
    return [
        CategoryTotal(category=name, bucket=CATEGORY_BUCKETS[name], total_cents=cents, count=1)
        for name, cents in totals.items()
    ]


def nodes(flow: FlowDiagram) -> dict[str, int]:
    return {node.id: node.cents for node in flow.nodes}


def links(flow: FlowDiagram) -> list[tuple[str, str, int]]:
    return [(link.source, link.target, link.cents) for link in flow.links]


def stage_two(flow: FlowDiagram) -> list[tuple[str, str, int]]:
    """The bands into column 2 (sources to buckets and what was left)."""
    column = {node.id: node.column for node in flow.nodes}
    return [band for band in links(flow) if column[band[1]] == 2]


def node(flow: FlowDiagram, node_id: str) -> Any:
    return next(n for n in flow.nodes if n.id == node_id)


def test_spending_beyond_take_home_and_deposits() -> None:
    """D1, issue #236: take-home 1,996.04, deposits 3,240.12, spending 5,234.98."""
    flow = diagram(
        stubs(1),
        income_cents=324_012,
        left_over_cents=-199_486,
        categories=categories(
            housing=250_000,
            groceries=60_000,
            dining=80_000,
            shopping=131_344,
            savings_investment=2_154,
        ),
    )
    assert nodes(flow) == {
        "gross": 270_833,
        "line:federal_withholding": 29_776,
        "line:social_security": 16_792,
        "line:medicare": 3_927,
        "line:state_tax": 9_814,
        "line:retirement_contribution": 0,
        "line:medical_premium": 6_250,
        "line:other_deductions": 4_670,
        "take_home": 199_604,
        "other_deposits": 124_408,
        "beyond_income": 199_486,
        "bucket:essentials": 310_000,
        "bucket:flexible": 211_344,
        "bucket:savings": 2_154,
        "bucket:other": 0,
        "category:housing": 250_000,
        "category:groceries": 60_000,
        "category:dining": 80_000,
        "category:shopping": 131_344,
        "category:savings_investment": 2_154,
    }
    assert [n.id for n in flow.nodes][:9] == [
        "gross",
        "line:federal_withholding",
        "line:social_security",
        "line:medicare",
        "line:state_tax",
        "line:retirement_contribution",
        "line:medical_premium",
        "line:other_deductions",
        "take_home",
    ]
    assert stage_two(flow) == [
        ("take_home", "bucket:essentials", 199_604),
        ("other_deposits", "bucket:essentials", 110_396),
        ("other_deposits", "bucket:flexible", 14_012),
        ("beyond_income", "bucket:flexible", 197_332),
        ("beyond_income", "bucket:savings", 2_154),
    ]
    assert ("gross", "take_home", 199_604) in links(flow)
    assert ("gross", "line:retirement_contribution", 0) not in links(flow)
    assert ("bucket:flexible", "category:shopping", 131_344) in links(flow)


def test_take_home_equal_to_deposits() -> None:
    """D2: spec 007's September with its two mockup stubs."""
    flow = diagram(
        stubs(2),
        income_cents=399_208,
        left_over_cents=166_808,
        categories=categories(
            housing=150_000, groceries=30_000, dining=8_500, savings_investment=40_000, fees=3_900
        ),
    )
    found = nodes(flow)
    assert found["take_home"] == 399_208
    assert found["left_over"] == 166_808
    assert not {"other_deposits", "not_deposited", "beyond_income", "refunds"} & set(found)
    assert stage_two(flow) == [
        ("take_home", "bucket:essentials", 180_000),
        ("take_home", "bucket:flexible", 8_500),
        ("take_home", "bucket:savings", 40_000),
        ("take_home", "bucket:other", 3_900),
        ("take_home", "left_over", 166_808),
    ]


def test_a_refund_is_money_in() -> None:
    """D3: the Plaid sandbox's October, no stub, the United Airlines refund."""
    flow = diagram(
        stubs(0),
        income_cents=422,
        left_over_cents=-168_541,
        categories=categories(
            dining=51_633,
            transport=540,
            shopping=58_940,
            entertainment=7_850,
            travel=-50_000,
            savings_investment=100_000,
        ),
    )
    found = nodes(flow)
    assert {
        key: found[key] for key in ("gross", "income_deposited", "refunds", "beyond_income")
    } == {
        "gross": 0,
        "income_deposited": 422,
        "refunds": 50_000,
        "beyond_income": 168_541,
    }
    assert not any(key.startswith("line:") for key in found)
    assert "category:travel" not in found
    assert node(flow, "refunds").categories == ["travel"]
    flexible = node(flow, "bucket:flexible")
    assert (flexible.cents, flexible.refunds_cents) == (118_423, 50_000)
    assert node(flow, "bucket:essentials").refunds_cents is None
    assert stage_two(flow) == [
        ("income_deposited", "bucket:essentials", 422),
        ("refunds", "bucket:essentials", 118),
        ("refunds", "bucket:flexible", 49_882),
        ("beyond_income", "bucket:flexible", 68_541),
        ("beyond_income", "bucket:savings", 100_000),
    ]
    assert not any(band[0] == "gross" for band in links(flow))


def test_take_home_not_deposited() -> None:
    """D4: one stub, less deposited than its take-home."""
    flow = diagram(
        stubs(1),
        income_cents=150_000,
        left_over_cents=50_000,
        categories=categories(housing=100_000),
    )
    found = nodes(flow)
    assert (found["take_home"], found["not_deposited"], found["left_over"]) == (
        199_604,
        49_604,
        50_000,
    )
    assert next(n.id for n in flow.nodes if n.column == 2) == "not_deposited"
    assert stage_two(flow) == [
        ("take_home", "not_deposited", 49_604),
        ("take_home", "bucket:essentials", 100_000),
        ("take_home", "left_over", 50_000),
    ]


def test_money_taken_out_of_savings() -> None:
    """D5: an investment sold (savings_investment money in) is a source."""
    flow = diagram(
        stubs(0),
        income_cents=300_000,
        left_over_cents=200_000,
        categories=categories(housing=150_000, savings_investment=-50_000),
    )
    found = nodes(flow)
    assert (found["income_deposited"], found["savings_withdrawn"], found["left_over"]) == (
        300_000,
        50_000,
        200_000,
    )
    assert "refunds" not in found
    assert node(flow, "savings_withdrawn").categories == ["savings_investment"]
    savings = node(flow, "bucket:savings")
    assert (savings.cents, savings.refunds_cents) == (0, 50_000)
    assert stage_two(flow) == [
        ("income_deposited", "bucket:essentials", 150_000),
        ("income_deposited", "left_over", 150_000),
        ("savings_withdrawn", "left_over", 50_000),
    ]


def test_an_empty_period() -> None:
    """D6: nothing in the period: the fixed nodes at zero, no band."""
    flow = diagram(stubs(0), income_cents=0, left_over_cents=0, categories=[])
    assert nodes(flow) == {
        "gross": 0,
        "income_deposited": 0,
        "bucket:essentials": 0,
        "bucket:flexible": 0,
        "bucket:savings": 0,
        "bucket:other": 0,
        "left_over": 0,
    }
    assert flow.links == []


def test_income_and_transfers_are_not_drawn() -> None:
    flow = diagram(
        stubs(0),
        income_cents=10_000,
        left_over_cents=10_000,
        categories=categories(income=10_000, transfer=5_000),
    )
    assert "category:income" not in nodes(flow)
    assert "category:transfer" not in nodes(flow)


def test_a_left_over_that_disagrees_with_the_categories_raises() -> None:
    with pytest.raises(ValueError, match="left over"):
        diagram(stubs(0), income_cents=1_000, left_over_cents=900, categories=categories(housing=0))


SPENDING = ["housing", "groceries", "dining", "shopping", "travel", "fees", "savings_investment"]


@given(
    stub_count=st.integers(min_value=0, max_value=3),
    income=st.integers(min_value=0, max_value=2_000_000),
    totals=st.lists(st.integers(min_value=-500_000, max_value=500_000), min_size=7, max_size=7),
)
def test_every_node_balances(stub_count: int, income: int, totals: list[int]) -> None:
    """Rule 5b: what flows into a node equals what flows out, and both equal
    its amount; no node or band is negative."""
    spent = sum(totals)
    flow = diagram(
        stubs(stub_count),
        income_cents=income,
        left_over_cents=income - spent,
        categories=categories(**dict(zip(SPENDING, totals, strict=True))),
    )
    into: dict[str, int] = defaultdict(int)
    out: dict[str, int] = defaultdict(int)
    for band in flow.links:
        assert band.cents > 0
        into[band.target] += band.cents
        out[band.source] += band.cents
    for one in flow.nodes:
        assert one.cents >= 0
        if one.id in into:
            assert into[one.id] == one.cents, one.id
        if one.id in out:
            assert out[one.id] == one.cents, one.id
        if one.cents > 0 and one.column in (1, 2) and not one.id.startswith("line:"):
            # Every source and use in stage 2 is joined to the other side.
            assert one.id in into or one.id in out, one.id
