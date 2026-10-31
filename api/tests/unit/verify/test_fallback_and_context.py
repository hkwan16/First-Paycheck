"""The explain context's facts and the fallback text, on spec 006's examples
(spec 008 rules 7, 7a and 17). Both must pass the verifier by construction,
with or without the rate a pay stub shows."""

from __future__ import annotations

import uuid
from decimal import Decimal
from typing import Any

import pytest

from calc.health_plans import HealthPlansInput, health_plans
from calc.k401 import K401MatchInput, k401_match
from llm.schemas import ExplanationDraft
from retrieval.benefits_search import BenefitsPassage
from retrieval.citations import Citation
from retrieval.context import (
    CAPPED_NOTE,
    COMPENSATION_NOTE,
    NEGATIVE_COST_NOTE,
    NO_STUB_NOTE,
    STUB_DIFFERS_NOTE,
    STUB_SAME_NOTE,
    context_digest,
    explain_context,
    explain_setup,
    name_numbers,
    pay_stub_numbers,
)
from tests.unit.calc import test_health_plans_examples as health_examples
from verify.allowed import AllowedNumbers
from verify.fallback import fallback_draft
from verify.format import dollars, net_cost, percent
from verify.numbers import extract_numbers
from verify.verify import verify_explanation

TIERED = [
    {"employee_pct_upto": "3", "employer_pct": "100"},
    {"employee_pct_upto": "5", "employer_pct": "50"},
]
# (salary, periods, tiers, contribution, age) for spec 006 examples 1-11, and
# issue 132's decision: example 11's salary with 5% chosen.
EXAMPLES: dict[str, tuple[int, int, list[dict[str, str]], str, int]] = {
    "11": (9_500_010, 26, TIERED, "3", 30),
    "issue-132": (9_500_010, 26, TIERED, "5", 30),
    "1": (6_000_000, 26, TIERED, "3", 30),
    "2": (6_500_000, 24, [{"employee_pct_upto": "4", "employer_pct": "100"}], "2", 30),
    "3": (8_500_000, 26, [{"employee_pct_upto": "6", "employer_pct": "50"}], "4", 30),
    "4": (30_000_000, 26, TIERED, "10", 30),
    "5a": (5_200_000, 26, TIERED, "2", 30),
    "6": (7_000_000, 26, [{"employee_pct_upto": "4", "employer_pct": "100"}], "8", 30),
    "7a": (30_000_000, 26, TIERED, "10", 52),
    "7b": (30_000_000, 26, TIERED, "12", 61),
    "8": (4_512_345, 26, TIERED, "4.5", 30),
    "9": (50_000_000, 26, TIERED, "6", 30),
    "10": (6_000_000, 26, TIERED, "0", 30),
    "no-match": (6_000_000, 26, [], "6", 30),
}


def decision(example: str) -> tuple[dict[str, Any], dict[str, Any]]:
    salary, periods, tiers, contribution, age = EXAMPLES[example]
    data = K401MatchInput.model_validate(
        {
            "salary_cents": salary,
            "pay_periods_per_year": periods,
            "match_tiers": tiers,
            "contribution_pct": contribution,
            "tax_year": 2026,
            "filing_status": "single",
            "age": age,
        }
    )
    return data.model_dump(mode="json"), k401_match(data).model_dump(mode="json")


def citation(key: str) -> Citation:
    return Citation(
        key=key,
        title=key.title(),
        url="https://www.irs.gov/x",
        passage="Quoted words with $24,500 and 401(k).",
        source="Notice",
        tax_year=2026,
    )


SEEDED = [
    citation(key)
    for key in (
        "k401.catch_up",
        "k401.compensation_limit",
        "k401.deferral_limit",
        "k401.employer_match",
        "k401.federal_brackets",
        "k401.pretax_deferral",
        "k401.vesting",
    )
]


def test_formatting() -> None:
    assert dollars(180_000) == "$1,800.00"
    assert dollars(4_615) == "$46.15"
    assert dollars(-1_200) == "-$12.00"
    assert dollars(0) == "$0.00"
    assert percent(Decimal("5.00")) == "5%"
    assert percent(Decimal("4.50")) == "4.5%"
    assert percent(Decimal("100.00")) == "100%"
    assert percent(Decimal("0.25")) == "0.25%"


def test_net_cost_reads_as_coming_out_ahead() -> None:
    """Spec 012 rule 17: a negative net cost is an amount ahead, never a minus sign."""
    assert net_cost(202_500) == "$2,025.00"
    assert net_cost(0) == "$0.00"
    assert net_cost(-40) == "$0.40 ahead"
    assert net_cost(-40_300) == "$403.00 ahead"
    assert net_cost(-59_650) == "$596.50 ahead"


def test_context_for_example_1() -> None:
    inputs, result = decision("1")
    passage = BenefitsPassage(
        document_id=uuid.uuid4(), chunk_index=0, text="Matching vests over 3 years.", rank=0.5
    )
    context = explain_context(
        "k401_match", inputs, result, SEEDED, [passage], pay_stub_pct=Decimal("3.00")
    )
    facts = {fact.label: fact.value for fact in context.facts}
    assert facts["Contribution rate you chose"] == "3%"
    assert facts["401(k) contribution rate your latest pay stub shows"] == "3%"
    assert facts["Contribution rate that earns the full match"] == "5%"
    assert facts["Employer match per year at the rate you chose"] == "$1,800.00"
    assert facts["Employer match per year at the full-match rate"] == "$2,400.00"
    assert facts["Match you miss per year at the rate you chose"] == "$600.00"
    assert facts["Extra per paycheck before tax at the full-match rate"] == "$46.15"
    assert facts["Extra per paycheck after federal income tax"] == "$40.62"
    assert facts["Federal marginal tax rate used"] == "12%"
    assert facts["Your yearly contribution at the rate you chose"] == "$1,800.00"
    assert facts["Yearly 401(k) contribution limit"] == "$24,500.00"
    assert facts["Paychecks per year"] == "26"
    assert facts["Tax year"] == "2026"
    assert facts["Employer match formula"] == "100% of what you contribute up to 3% of pay"
    assert facts["Employer match formula, next tier"] == (
        "50% of what you contribute from 3% to 5% of pay"
    )
    assert context.tax_year == 2026
    assert context.notes == [STUB_SAME_NOTE]
    # The result's own keys come first, then the rest of the seed for the year.
    assert [c.key for c in context.citations][:4] == result["citation_keys"]
    assert {c.key for c in context.citations} == {c.key for c in SEEDED}
    assert context.benefits_passages == ["Matching vests over 3 years."]


def test_context_notes_the_limits() -> None:
    inputs, result = decision("9")
    context = explain_context("k401_match", inputs, result, SEEDED, [], pay_stub_pct=Decimal(6))
    assert context.notes == [STUB_SAME_NOTE, CAPPED_NOTE, COMPENSATION_NOTE]
    assert "limit" in context.notes[1]
    assert "compensation" in context.notes[2]


# Each k401 example explained with no pay stub, a stub at the chosen rate, and a
# stub at 3.69 (a $100.00 flat election, spec 005 rule 24b row 3), which no
# example chooses.
STUBS = {"no-stub": None, "same": "same", "uneven": Decimal("3.69")}


def stub_rate(example: str, stub: str) -> Decimal | None:
    rate = STUBS[stub]
    if rate == "same":
        return Decimal(EXAMPLES[example][3])
    assert rate is None or isinstance(rate, Decimal)
    return rate


@pytest.mark.parametrize("stub", sorted(STUBS))
@pytest.mark.parametrize("example", sorted(EXAMPLES))
def test_every_fact_passes_the_verifier(example: str, stub: str) -> None:
    inputs, result = decision(example)
    setup = explain_setup(
        "k401_match",
        inputs,
        result,
        SEEDED,
        [],
        pay_stub_pct=stub_rate(example, stub),
        pay_stub_withholding_cents=None,
    )
    for fact in setup.context.facts:
        check = verify_explanation(
            ExplanationDraft(
                concept="c",
                text=f"{fact.label}: {fact.value}.",
                numbers=[],
                what_ifs=[*setup.context.notes],
                citation_keys=["k401.employer_match"],
            ),
            setup.allowed_numbers,
            {"k401.employer_match"},
        )
        assert check.passed, (fact, check)


@pytest.mark.parametrize("stub", sorted(STUBS))
@pytest.mark.parametrize("example", sorted(EXAMPLES))
def test_fallback_passes_the_verifier(example: str, stub: str) -> None:
    inputs, result = decision(example)
    setup = explain_setup(
        "k401_match",
        inputs,
        result,
        SEEDED,
        [],
        pay_stub_pct=stub_rate(example, stub),
        pay_stub_withholding_cents=None,
    )
    check = verify_explanation(setup.fallback, setup.allowed_numbers, setup.citation_keys)
    assert check.passed, (setup.fallback.text, check)
    keys = {c.key for c in SEEDED}
    assert setup.citation_keys == keys
    assert setup.fallback.citation_keys == [k for k in result["citation_keys"] if k in keys]


def test_fallback_for_example_1_reads_plainly() -> None:
    inputs, result = decision("1")
    draft = fallback_draft("k401_match", inputs, result, {"k401.employer_match"})
    assert "$1,800.00" in draft.text
    assert "$2,400.00" in draft.text
    assert "$600.00" in draft.text
    assert "$46.15" in draft.text
    assert "$40.62" in draft.text
    assert "12%" in draft.text
    assert draft.citation_keys == ["k401.employer_match"]
    assert {claim.value for claim in draft.numbers} >= {"$600.00", "$46.15"}


def test_fallback_when_nothing_is_missed() -> None:
    inputs, result = decision("6")
    # The stub shows the 8% chosen: the full match is earned now.
    same = fallback_draft("k401_match", inputs, result, set(), pay_stub_pct=Decimal("8.00"))
    assert "You already earn the full match of $2,800.00 a year." in same.text
    assert "missing" not in same.text
    assert same.citation_keys == []
    # The stub shows 4% or nothing is known: 8% is a choice, not what goes in now.
    for rate in (Decimal("4.00"), None):
        draft = fallback_draft("k401_match", inputs, result, set(), pay_stub_pct=rate)
        assert "already" not in draft.text
        assert "That rate earns the full match of $2,800.00 a year." in draft.text


# ---------------------------------------------------------------- issue 132 (rules 7a, 14a)


def test_context_for_issue_132() -> None:
    """The stub shows 3%; the person chose 5%. The model sees both, apart."""
    inputs, result = decision("issue-132")
    context = explain_context(
        "k401_match", inputs, result, SEEDED, [], pay_stub_pct=Decimal("3.00")
    )
    assert [(fact.label, fact.value) for fact in context.facts[:3]] == [
        ("Contribution rate you chose", "5%"),
        ("401(k) contribution rate your latest pay stub shows", "3%"),
        ("Contribution rate that earns the full match", "5%"),
    ]
    assert context.notes == [STUB_DIFFERS_NOTE]
    # Notes add no number a draft could repeat ("401(k)" is a name, not a figure).
    for note in (STUB_DIFFERS_NOTE, STUB_SAME_NOTE, NO_STUB_NOTE):
        assert extract_numbers(note) == [], note


def test_context_digest_follows_the_facts() -> None:
    """Spec 008 rule 19a: the digest is the context's, so it changes exactly when
    what a run would be given changes."""
    inputs, result = decision("issue-132")

    def digest(
        pay_stub_pct: Decimal | None,
        passages: list[BenefitsPassage] | None = None,
        citations: list[Citation] = SEEDED,
    ) -> str:
        setup = explain_setup(
            "k401_match",
            inputs,
            result,
            citations,
            passages or [],
            pay_stub_pct=pay_stub_pct,
            pay_stub_withholding_cents=None,
        )
        assert setup.digest == context_digest(setup.context)
        return setup.digest

    at_three = digest(Decimal("3.00"))
    assert len(at_three) == 64
    assert set(at_three) <= set("0123456789abcdef")
    # The same facts: the same digest, and the rate is compared by value.
    assert digest(Decimal("3.00")) == at_three
    assert digest(Decimal("3")) == at_three
    # Any other input to the context: another digest.
    others = {
        digest(None),
        digest(Decimal("5.00")),
        digest(
            Decimal("3.00"),
            [BenefitsPassage(uuid.uuid4(), 0, "Matching vests after a year.", 0.1)],
        ),
        digest(Decimal("3.00"), citations=SEEDED[:-1]),
    }
    assert at_three not in others
    assert len(others) == 4


def test_context_without_a_pay_stub() -> None:
    inputs, result = decision("issue-132")
    context = explain_context("k401_match", inputs, result, SEEDED, [])
    labels = [fact.label for fact in context.facts]
    assert labels[0] == "Contribution rate you chose"
    assert "401(k) contribution rate your latest pay stub shows" not in labels
    assert context.notes == [NO_STUB_NOTE]


@pytest.mark.parametrize(
    ("stub", "text", "unmatched"),
    [
        (
            Decimal("3.00"),
            "Your pay stub shows 3% going to your 401(k) now. At the 5% you chose,"
            " your employer adds $3,800.00 a year.",
            (),
        ),
        (Decimal("3.69"), "Your latest pay stub shows 3.69%.", ()),
        (None, "Your latest pay stub shows 3.69%.", ("3.69%",)),
    ],
)
def test_issue_132_drafts(stub: Decimal | None, text: str, unmatched: tuple[str, ...]) -> None:
    inputs, result = decision("issue-132")
    setup = explain_setup(
        "k401_match", inputs, result, SEEDED, [], pay_stub_pct=stub, pay_stub_withholding_cents=None
    )
    draft = ExplanationDraft(
        concept="c", text=text, numbers=[], what_ifs=[], citation_keys=["k401.employer_match"]
    )
    check = verify_explanation(draft, setup.allowed_numbers, setup.citation_keys)
    assert check.numbers_unmatched == unmatched
    assert check.passed is (unmatched == ())


def test_fallback_for_issue_132() -> None:
    inputs, result = decision("issue-132")
    draft = fallback_draft("k401_match", inputs, result, set(), pay_stub_pct=Decimal("3.00"))
    assert draft.text.startswith(
        "At the 5% you chose, you put in $4,750.01 a year and your employer adds $3,800.00."
        " Your latest pay stub shows 3% going to your 401(k), so the rate you chose takes"
        " effect once you change your election with your employer."
        " That rate earns the full match of $3,800.00 a year."
    )
    assert "already" not in draft.text


def test_pay_stub_numbers() -> None:
    inputs, result = decision("issue-132")

    def numbers(calculator: str, rate: Decimal | None) -> dict[str, Any]:
        return pay_stub_numbers(calculator, inputs, result, pay_stub_pct=rate)

    assert numbers("k401_match", Decimal("3.00")) == {"pay_stub_contribution_pct": "3.00"}
    assert numbers("k401_match", None) == {}
    assert numbers("health_plans", Decimal("3.00")) == {}
    allowed = AllowedNumbers.from_decision({}, {}, numbers("k401_match", Decimal("3.69")))
    assert allowed.percents == {Decimal("3.69")}


def test_other_calculators_ignore_the_pay_stub() -> None:
    inputs, result = health_decision("1")
    plain = explain_setup(
        "health_plans",
        inputs,
        result,
        HEALTH_SEEDED,
        [],
        pay_stub_pct=None,
        pay_stub_withholding_cents=None,
    )
    with_stub = explain_setup(
        "health_plans",
        inputs,
        result,
        HEALTH_SEEDED,
        [],
        pay_stub_pct=Decimal("3.00"),
        pay_stub_withholding_cents=27_244,
    )
    assert plain == with_stub
    assert with_stub.context == explain_context("health_plans", inputs, result, HEALTH_SEEDED, [])


def test_fallback_and_context_need_an_explainable_calculator() -> None:
    with pytest.raises(ValueError, match="emergency_fund"):
        fallback_draft("emergency_fund", {}, {}, set())
    with pytest.raises(ValueError, match="emergency_fund"):
        explain_context("emergency_fund", {}, {}, [], [])


# ---------------------------------------------------------------- health plans (spec 012)

A, A_LOW, B, B_TWIN, C = (
    health_examples.A,
    health_examples.A_LOW_DEDUCTIBLE,
    health_examples.B,
    health_examples.B_TWIN,
    health_examples.C,
)
# Spec 012's examples as (plans, salary, employee HSA, extra inputs).
HEALTH_EXAMPLES: dict[str, tuple[list[dict[str, Any]], int, int, dict[str, Any]]] = {
    "1": ([A, B], 6_500_000, 100_000, {}),
    "2": ([A, B, C], 6_500_000, 100_000, {}),
    "3": ([A, B], 9_000_000, 500_000, {}),
    "4": ([A_LOW, B], 6_500_000, 100_000, {}),
    "5": ([A], 2_500_000, 12_345, {}),
    "6": ([A, B], 1_500_000, 100_000, {}),
    "7": ([B, B_TWIN], 6_500_000, 100_000, {}),
    "8": ([A, B], 6_500_000, 100_000, {"expected_usage": "high", "selected_plan_index": 1}),
    # Example 3 at low use, where Bronze HSA comes out $403.00 ahead (spec 012 rule 17).
    "3-low": ([A, B], 9_000_000, 500_000, {"expected_usage": "low"}),
    "3-low-gold": ([A, B], 9_000_000, 500_000, {"expected_usage": "low", "selected_plan_index": 1}),
    # Two plans that come out ahead at low use; the one picked is not the cheapest.
    "3-low-both-ahead": (
        [{**A, "name": "Free Bronze HSA", "premium_per_period_cents": 0}, A],
        9_000_000,
        500_000,
        {"expected_usage": "low", "selected_plan_index": 1},
    ),
}
HEALTH_SEEDED = [
    citation(key)
    for key in ("health.federal_brackets", "health.hdhp_definition", "health.hsa_limit")
]


def health_decision(example: str) -> tuple[dict[str, Any], dict[str, Any]]:
    plans, salary, employee_hsa, extra = HEALTH_EXAMPLES[example]
    data = HealthPlansInput.model_validate(
        {"selected_plan_index": 0, **health_examples.payload(plans, salary, employee_hsa, **extra)}
    )
    return data.model_dump(mode="json"), health_plans(data).model_dump(mode="json")


def test_health_context_for_example_1() -> None:
    inputs, result = health_decision("1")
    passage = BenefitsPassage(
        document_id=uuid.uuid4(), chunk_index=0, text="The Bronze HSA deductible...", rank=0.5
    )
    context = explain_context("health_plans", inputs, result, HEALTH_SEEDED, [passage])
    facts = {fact.label: fact.value for fact in context.facts}
    assert facts["Federal marginal tax rate used"] == "12%"
    assert facts["Yearly HSA contribution limit, self-only"] == "$4,400.00"
    assert facts["Bronze HSA: premiums per year"] == "$650.00"
    assert facts["Bronze HSA: federal tax your HSA contribution saves"] == "$120.00"
    assert facts["Bronze HSA: cost per year at medium medical use"] == "$1,740.00"
    assert facts["Gold PPO: cost per year at medium medical use"] == "$2,375.00"
    assert facts["Medical spending per year at medium use"] == "$3,000.00"
    assert (
        facts["Bronze HSA versus Gold PPO: yearly medical spending where the cheaper plan changes"]
        == "$9,400.00, $17,100.00"
    )
    assert context.calculator == "health_plans"
    assert context.tax_year == 2026
    assert [c.key for c in context.citations] == result["citation_keys"]
    assert context.benefits_passages == ["The Bronze HSA deductible..."]
    assert context.notes == [
        "Expected medical use is medium; at that use Bronze HSA costs the least.",
        "The plan picked is Bronze HSA.",
    ]
    # Facts are numbers only, so any fact a draft repeats shows a figure.
    for fact in context.facts:
        assert extract_numbers(fact.value), fact


def test_health_context_notes() -> None:
    inputs, result = health_decision("2")
    notes = explain_context("health_plans", inputs, result, HEALTH_SEEDED, []).notes
    assert "Silver HMO costs less than Gold PPO at every level of medical spending." in notes
    inputs, result = health_decision("3")
    assert any(
        "limit" in note
        for note in explain_context("health_plans", inputs, result, HEALTH_SEEDED, []).notes
    )
    inputs, result = health_decision("4")
    assert any(
        "minimum" in note
        for note in explain_context("health_plans", inputs, result, HEALTH_SEEDED, []).notes
    )


@pytest.mark.parametrize("example", sorted(HEALTH_EXAMPLES))
def test_every_health_fact_passes_the_verifier(example: str) -> None:
    inputs, result = health_decision(example)
    context = explain_context("health_plans", inputs, result, HEALTH_SEEDED, [])
    allowed = AllowedNumbers.from_decision(inputs, result, name_numbers("health_plans", inputs))
    for fact in [*context.facts]:
        check = verify_explanation(
            ExplanationDraft(
                concept="c",
                text=" ".join([f"{fact.label}: {fact.value}.", *context.notes]),
                numbers=[],
                what_ifs=[],
                citation_keys=["health.hsa_limit"],
            ),
            allowed,
            {"health.hsa_limit"},
        )
        assert check.passed, (fact, check)


@pytest.mark.parametrize("example", sorted(HEALTH_EXAMPLES))
def test_health_fallback_passes_the_verifier(example: str) -> None:
    inputs, result = health_decision(example)
    keys = {c.key for c in HEALTH_SEEDED}
    draft = fallback_draft("health_plans", inputs, result, keys)
    check = verify_explanation(
        draft,
        AllowedNumbers.from_decision(inputs, result, name_numbers("health_plans", inputs)),
        keys,
    )
    assert check.passed, (draft.text, check)
    assert draft.citation_keys == [key for key in result["citation_keys"] if key in keys]


def test_health_fallback_for_example_1_reads_plainly() -> None:
    inputs, result = health_decision("1")
    draft = fallback_draft("health_plans", inputs, result, {"health.hsa_limit"})
    assert "Bronze HSA" in draft.text
    assert "$1,740.00" in draft.text
    assert "$9,400.00" in draft.text
    assert "$120.00" in draft.text
    assert draft.citation_keys == ["health.hsa_limit"]


def test_health_fallback_writes_a_negative_cost_as_coming_out_ahead() -> None:
    """Spec 012 rule 17's example: example 3 at low use."""
    inputs, result = health_decision("3-low")
    draft = fallback_draft("health_plans", inputs, result, {"health.hsa_limit"})
    assert draft.text.startswith(
        "At low medical use, about $500.00 of care a year, Bronze HSA costs you the least and"
        " leaves you $403.00 ahead a year: the employer's HSA money and the tax an HSA"
        " contribution saves are more than its premiums and your share of the care."
    )
    assert "-$" not in draft.text
    assert draft.numbers[0].value == "$403.00 ahead"

    inputs, result = health_decision("3-low-gold")
    draft = fallback_draft("health_plans", inputs, result, {"health.hsa_limit"})
    assert "You picked Gold PPO, which costs $2,125.00 a year at that use." in draft.text
    assert "-$" not in draft.text


def test_health_fallback_names_a_picked_plan_that_comes_out_ahead() -> None:
    inputs, result = health_decision("3-low-both-ahead")
    draft = fallback_draft("health_plans", inputs, result, {"health.hsa_limit"})
    assert "Free Bronze HSA costs you the least and leaves you $1,053.00 ahead a year" in (
        draft.text
    )
    assert "You picked Bronze HSA, which leaves you $403.00 ahead a year at that use." in (
        draft.text
    )
    assert "-$" not in draft.text
    assert [claim.value for claim in draft.numbers[:2]] == ["$1,053.00 ahead", "$403.00 ahead"]


def test_health_context_writes_net_costs_as_coming_out_ahead() -> None:
    inputs, result = health_decision("3-low")
    context = explain_context("health_plans", inputs, result, HEALTH_SEEDED, [])
    facts = {fact.label: fact.value for fact in context.facts}
    assert facts["Bronze HSA: cost per year at low medical use"] == "$403.00 ahead"
    assert facts["Bronze HSA: cost per year at medium medical use"] == "$1,057.00"
    assert all("-$" not in fact.value for fact in context.facts)
    assert NEGATIVE_COST_NOTE in context.notes
    assert "ahead" in NEGATIVE_COST_NOTE


def test_numbers_in_plan_names_are_allowed() -> None:
    """Spec 012 rule 16: "Gold PPO 2" names a plan; its 2 is not a claim."""
    inputs = health_decision("7")[0]
    extras = name_numbers("health_plans", inputs)
    assert extras == {"plan_name_numbers": [2]}
    renamed = {**inputs["plans"][0], "name": "Gold $500 PPO 10%"}
    named = {**inputs, "plans": [renamed, inputs["plans"][1]]}
    assert name_numbers("health_plans", named) == {
        "plan_name_numbers": [2],
        "plan_name_cents": [50_000],
        "plan_name_pct": ["10"],
    }
    assert name_numbers("k401_match", decision("1")[0]) == {}
