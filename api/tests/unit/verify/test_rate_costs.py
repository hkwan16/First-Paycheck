"""What a 401(k) rate costs per paycheck, and the claim that it costs nothing
(spec 008 rules 7c and 14a, issue 223).

Issue 223's decision chose 6% where 5% earns the full match (salary
$95,000.10, 24 paychecks, a stub at 0%). Its verified explanation said going
from the full-match rate to 6% "would cost no extra per paycheck": the facts
offered the zero extra needed to reach the match, and no figure was wrong.
"""

from __future__ import annotations

from decimal import Decimal
from typing import Any

import pytest

from calc.k401 import K401MatchInput, k401_match
from llm.schemas import ExplanationDraft
from retrieval.citations import Citation
from retrieval.context import (
    ABOVE_FULL_MATCH_NOTE,
    CAPPED_NOTE,
    FULL_MATCH_EARNED_NOTE,
    LIMIT_BEFORE_FULL_MATCH_NOTE,
    STUB_DIFFERS_NOTE,
    STUB_SAME_NOTE,
    ExplainSetup,
    context_numbers,
    explain_setup,
)
from tests.unit.verify.test_fallback_and_context import EXAMPLES, SEEDED, decision
from verify.allowed import AllowedNumbers
from verify.numbers import extract_numbers
from verify.verify import verify_explanation
from verify.zero_cost import zero_cost_claims

TIERED = [
    {"employee_pct_upto": "3", "employer_pct": "100"},
    {"employee_pct_upto": "5", "employer_pct": "50"},
]

AGAINST_STUB = "at the rate you chose than at the rate your latest pay stub shows"
STUB_MORE = f"More taken per paycheck before tax {AGAINST_STUB}"
STUB_LESS_TAKE_HOME = (
    "Less take-home pay per paycheck after federal income tax at the rate you chose than at the"
    " rate your latest pay stub shows"
)
STUB_LESS = f"Less taken per paycheck before tax {AGAINST_STUB}"
STUB_MORE_TAKE_HOME = (
    "More take-home pay per paycheck after federal income tax at the rate you chose than at the"
    " rate your latest pay stub shows"
)
REACH = "More taken per paycheck before tax to raise the rate you chose to the full-match rate"
REACH_TAKE_HOME = (
    "Less take-home pay per paycheck after federal income tax to raise the rate you chose to the"
    " full-match rate"
)
ABOVE = (
    "More taken per paycheck before tax by the part of the rate you chose above the full-match rate"
)
ABOVE_TAKE_HOME = (
    "Less take-home pay per paycheck after federal income tax from the part of the rate you chose"
    " above the full-match rate"
)
COST_LABELS = (
    STUB_MORE,
    STUB_LESS_TAKE_HOME,
    STUB_LESS,
    STUB_MORE_TAKE_HOME,
    REACH,
    REACH_TAKE_HOME,
    ABOVE,
    ABOVE_TAKE_HOME,
)


def issue_223(chosen: str) -> tuple[dict[str, Any], dict[str, Any]]:
    data = K401MatchInput.model_validate(
        {
            "salary_cents": 9_500_010,
            "pay_periods_per_year": 24,
            "match_tiers": TIERED,
            "contribution_pct": chosen,
            "tax_year": 2026,
            "filing_status": "single",
            "age": 30,
        }
    )
    return data.model_dump(mode="json"), k401_match(data).model_dump(mode="json")


def setup_for(
    inputs: dict[str, Any],
    result: dict[str, Any],
    stub: Decimal | None,
    citations: list[Citation] = SEEDED,
) -> ExplainSetup:
    return explain_setup(
        "k401_match",
        inputs,
        result,
        citations,
        [],
        pay_stub_pct=stub,
        pay_stub_withholding_cents=None,
    )


def cost_facts(setup: ExplainSetup) -> list[tuple[str, str]]:
    return [(f.label, f.value) for f in setup.context.facts if f.label in COST_LABELS]


@pytest.mark.parametrize(
    ("chosen", "stub", "costs", "notes"),
    [
        (
            "6",
            Decimal("0.00"),
            [
                (STUB_MORE, "$237.50"),
                (STUB_LESS_TAKE_HOME, "$185.25"),
                (ABOVE, "$39.58"),
                (ABOVE_TAKE_HOME, "$30.88"),
            ],
            [STUB_DIFFERS_NOTE, FULL_MATCH_EARNED_NOTE, ABOVE_FULL_MATCH_NOTE],
        ),
        (
            "5",
            Decimal("0.00"),
            [(STUB_MORE, "$197.92"), (STUB_LESS_TAKE_HOME, "$154.38")],
            [STUB_DIFFERS_NOTE, FULL_MATCH_EARNED_NOTE],
        ),
        (
            "3",
            Decimal("0.00"),
            [
                (STUB_MORE, "$118.75"),
                (STUB_LESS_TAKE_HOME, "$92.63"),
                (REACH, "$79.17"),
                (REACH_TAKE_HOME, "$61.75"),
            ],
            [STUB_DIFFERS_NOTE],
        ),
        (
            "6",
            Decimal("6.00"),
            [(ABOVE, "$39.58"), (ABOVE_TAKE_HOME, "$30.88")],
            [STUB_SAME_NOTE, FULL_MATCH_EARNED_NOTE, ABOVE_FULL_MATCH_NOTE],
        ),
    ],
)
def test_issue_223_cost_facts(
    chosen: str, stub: Decimal, costs: list[tuple[str, str]], notes: list[str]
) -> None:
    setup = setup_for(*issue_223(chosen), stub)
    assert cost_facts(setup) == costs
    assert setup.context.notes == notes
    labels = [fact.label for fact in setup.context.facts]
    # explain/v4's fact, the zero extra needed to reach the match, is gone.
    assert "Extra per paycheck before tax at the full-match rate" not in labels
    assert "Federal marginal income tax rate the after-tax figures use" in labels


def test_the_stub_costs_come_right_after_the_stub_rate() -> None:
    setup = setup_for(*issue_223("6"), Decimal("0.00"))
    assert [(f.label, f.value) for f in setup.context.facts[:4]] == [
        ("Contribution rate you chose", "6%"),
        ("401(k) contribution rate your latest pay stub shows", "0%"),
        (STUB_MORE, "$237.50"),
        (STUB_LESS_TAKE_HOME, "$185.25"),
    ]


def test_a_lowered_rate_says_less_is_taken() -> None:
    """Spec 006 example 15e: example 2 at 2% against a stub at 4%."""
    inputs, result = decision("2")
    setup = setup_for(inputs, result, Decimal("4.00"))
    assert cost_facts(setup)[:2] == [(STUB_LESS, "$54.17"), (STUB_MORE_TAKE_HOME, "$47.67")]


def test_two_rates_at_the_limit_state_no_stub_cost() -> None:
    """Spec 006 examples 15f and 15g: 10% and a stub at 9% both reach the limit."""
    inputs, result = decision("4")
    setup = setup_for(inputs, result, Decimal("9.00"))
    assert cost_facts(setup) == [(ABOVE, "$365.38"), (ABOVE_TAKE_HOME, "$237.50")]
    assert CAPPED_NOTE in setup.context.notes


def test_the_limit_before_the_full_match_says_why_there_is_no_cost() -> None:
    """4.95% of $500,000 reaches the limit before the full-match 5% would (example 9's salary)."""
    inputs, _ = decision("9")
    data = {**inputs, "contribution_pct": "4.95"}
    computed = k401_match(K401MatchInput.model_validate(data)).model_dump(mode="json")
    assert computed["per_paycheck_cost_delta_cents"] == 0
    setup = setup_for(data, computed, None)
    assert cost_facts(setup) == []
    assert LIMIT_BEFORE_FULL_MATCH_NOTE in setup.context.notes


@pytest.mark.parametrize("stub", [None, Decimal("0.00"), Decimal("3.69"), "same"])
@pytest.mark.parametrize("example", sorted(EXAMPLES))
def test_no_cost_fact_is_zero(example: str, stub: Decimal | str | None) -> None:
    inputs, result = decision(example)
    rate = Decimal(inputs["contribution_pct"]) if stub == "same" else stub
    assert not isinstance(rate, str)
    setup = setup_for(inputs, result, rate)
    for label, value in cost_facts(setup):
        assert value != "$0.00", label
    for fact in setup.context.facts:
        assert not zero_cost_claims(f"{fact.label}: {fact.value}."), fact
    for note in setup.context.notes:
        assert extract_numbers(note) == [], note
        assert not zero_cost_claims(note), note


def test_context_numbers_allow_every_cost() -> None:
    inputs, result = issue_223("6")
    numbers = context_numbers("k401_match", inputs, result, pay_stub_pct=Decimal("0.00"))
    assert numbers == {
        "pay_stub_contribution_pct": "0.00",
        "pay_stub_change_per_paycheck_cents": 23_750,
        "pay_stub_change_per_paycheck_after_tax_cents": 18_525,
        "above_full_match_per_paycheck_cents": 3_958,
        "above_full_match_per_paycheck_after_tax_cents": 3_088,
    }
    assert context_numbers("k401_match", inputs, result, pay_stub_pct=None) == {
        "above_full_match_per_paycheck_cents": 3_958,
        "above_full_match_per_paycheck_after_tax_cents": 3_088,
    }
    allowed = AllowedNumbers.from_decision({}, {}, numbers)
    assert allowed.money_exact >= {Decimal("237.50"), Decimal("39.58")}


# ---------------------------------------------------------------- rule 14a

ZERO_COST_SENTENCES = [
    # The live sentences of issue 223, at 6% and at 5%.
    "Going from the full-match rate to 6% would cost no extra per paycheck, before or after"
    " federal income tax.",
    "Switching from the 5% you chose to the full-match rate costs no extra per paycheck.",
    "Moving to the full-match rate would not cost you more per paycheck.",
    "Moving to it costs you an extra $0.00 per paycheck before tax.",
    "That means no extra cost to you.",
    "Raising it costs you nothing.",
    "It doesn\N{RIGHT SINGLE QUOTATION MARK}t cost anything more.",
    "There is nothing more taken out of each paycheck.",
    "You would pay $0 more from each paycheck.",
]
TRUE_SENTENCES = [
    "At the 6% you chose, $237.50 more would come out of each paycheck than at the 0% your pay"
    " stub shows, or about $185.25 less take-home pay after federal income tax.",
    "The part above 5% earns no extra match but takes $39.58 more from each paycheck before tax.",
    "Nothing changes on your paycheck until you change your election with your employer.",
    "You miss none of the match, so you leave no money behind.",
    "Your contributions are pre-tax, so they come out before income tax is figured.",
    "You would miss $0.00 of match a year.",
]


@pytest.mark.parametrize("sentence", ZERO_COST_SENTENCES)
def test_a_zero_cost_claim_is_found(sentence: str) -> None:
    assert zero_cost_claims(f"Your employer matches your pay. {sentence} That is the choice.") == (
        sentence,
    )


@pytest.mark.parametrize("sentence", TRUE_SENTENCES)
def test_a_sentence_with_a_real_cost_is_no_claim(sentence: str) -> None:
    assert zero_cost_claims(sentence) == ()


def draft(text: str, *, what_ifs: tuple[str, ...] = (), concept: str = "c") -> ExplanationDraft:
    return ExplanationDraft(
        concept=concept,
        text=text,
        numbers=[],
        what_ifs=list(what_ifs),
        citation_keys=["k401.employer_match"],
    )


@pytest.mark.parametrize(
    ("chosen", "text", "passed"),
    [
        ("6", ZERO_COST_SENTENCES[0], False),
        ("5", ZERO_COST_SENTENCES[1], False),
        ("6", ZERO_COST_SENTENCES[2], False),
        ("6", ZERO_COST_SENTENCES[3], False),
        ("6", ZERO_COST_SENTENCES[4], False),
        ("6", TRUE_SENTENCES[0], True),
        ("6", TRUE_SENTENCES[1], True),
        ("6", TRUE_SENTENCES[2], True),
    ],
)
def test_the_verifier_rejects_a_zero_cost(chosen: str, text: str, passed: bool) -> None:
    setup = setup_for(*issue_223(chosen), Decimal("0.00"))
    check = verify_explanation(draft(text), setup.allowed_numbers, setup.citation_keys)
    assert check.numbers_unmatched == ()
    assert check.passed is passed
    assert check.zero_cost_claims == (() if passed else (text,))
    if not passed:
        assert text in check.feedback()
        assert "costs nothing" in check.feedback()
        assert check.as_json()["zero_cost_claims"] == [text]


def test_a_zero_cost_in_the_concept_or_a_what_if_fails() -> None:
    setup = setup_for(*issue_223("6"), Decimal("0.00"))
    claim = ZERO_COST_SENTENCES[1]
    for candidate in (draft("Fine.", what_ifs=(claim,)), draft("Fine.", concept=claim)):
        check = verify_explanation(candidate, setup.allowed_numbers, setup.citation_keys)
        assert check.zero_cost_claims == (claim,)
        assert not check.passed


def test_other_calculators_may_say_a_cost_is_zero() -> None:
    allowed = AllowedNumbers.from_decision({}, {})
    assert allowed.zero_cost is True
    check = verify_explanation(
        draft("Bronze HSA costs nothing per paycheck in premiums."),
        allowed,
        {"k401.employer_match"},
    )
    assert check.zero_cost_claims == ()
    assert check.passed


def test_the_fallback_states_the_costs_and_verifies() -> None:
    setup = setup_for(*issue_223("6"), Decimal("0.00"))
    text = setup.fallback.text
    assert text.startswith(
        "At the 6% you chose, you put in $5,700.01 a year and your employer adds $3,800.00."
        " Your latest pay stub shows 0% going to your 401(k), so the rate you chose takes"
        " effect once you change your election with your employer."
        " Once it does, each paycheck has $237.50 more taken before tax, or about $185.25 less"
        " take-home pay after federal income tax."
        " That rate earns the full match of $3,800.00 a year."
        " The part of your rate above 5% earns no match and takes $39.58 from each paycheck"
        " before tax, or about $30.88 after federal income tax."
    )
    check = verify_explanation(setup.fallback, setup.allowed_numbers, setup.citation_keys)
    assert check.passed, check


def test_the_fallback_for_a_lowered_rate() -> None:
    inputs, result = decision("2")
    setup = setup_for(inputs, result, Decimal("4.00"))
    assert (
        "Once it does, each paycheck has $54.17 less taken before tax, or about $47.67 more"
        " take-home pay after federal income tax." in setup.fallback.text
    )
