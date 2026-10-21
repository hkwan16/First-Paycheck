"""The explain context's facts and the fallback text, on spec 006's examples
(spec 008 rules 7 and 17). Both must pass the verifier by construction."""

from __future__ import annotations

import uuid
from decimal import Decimal
from typing import Any

import pytest

from calc.k401 import K401MatchInput, k401_match
from llm.schemas import ExplanationDraft
from retrieval.benefits_search import BenefitsPassage
from retrieval.citations import Citation
from retrieval.context import explain_context
from verify.allowed import AllowedNumbers
from verify.fallback import fallback_draft
from verify.format import dollars, percent
from verify.verify import verify_explanation

TIERED = [
    {"employee_pct_upto": "3", "employer_pct": "100"},
    {"employee_pct_upto": "5", "employer_pct": "50"},
]
# (salary, periods, tiers, contribution, age) for spec 006 examples 1-10.
EXAMPLES: dict[str, tuple[int, int, list[dict[str, str]], str, int]] = {
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


def test_context_for_example_1() -> None:
    inputs, result = decision("1")
    passage = BenefitsPassage(
        document_id=uuid.uuid4(), chunk_index=0, text="Matching vests over 3 years.", rank=0.5
    )
    context = explain_context("k401_match", inputs, result, SEEDED, [passage])
    facts = {fact.label: fact.value for fact in context.facts}
    assert facts["Your contribution rate"] == "3%"
    assert facts["Contribution rate that earns the full match"] == "5%"
    assert facts["Employer match per year at your rate"] == "$1,800.00"
    assert facts["Employer match per year at the full-match rate"] == "$2,400.00"
    assert facts["Match you miss per year"] == "$600.00"
    assert facts["Extra per paycheck before tax at the full-match rate"] == "$46.15"
    assert facts["Extra per paycheck after federal income tax"] == "$40.62"
    assert facts["Federal marginal tax rate used"] == "12%"
    assert facts["Yearly 401(k) contribution limit"] == "$24,500.00"
    assert facts["Paychecks per year"] == "26"
    assert facts["Tax year"] == "2026"
    assert facts["Employer match formula"] == "100% of what you contribute up to 3% of pay"
    assert facts["Employer match formula, next tier"] == (
        "50% of what you contribute from 3% to 5% of pay"
    )
    assert context.tax_year == 2026
    assert context.notes == []
    # The result's own keys come first, then the rest of the seed for the year.
    assert [c.key for c in context.citations][:4] == result["citation_keys"]
    assert {c.key for c in context.citations} == {c.key for c in SEEDED}
    assert context.benefits_passages == ["Matching vests over 3 years."]


def test_context_notes_the_limits() -> None:
    inputs, result = decision("9")
    context = explain_context("k401_match", inputs, result, SEEDED, [])
    assert len(context.notes) == 2
    assert "limit" in context.notes[0]
    assert "compensation" in context.notes[1]


@pytest.mark.parametrize("example", sorted(EXAMPLES))
def test_every_fact_passes_the_verifier(example: str) -> None:
    inputs, result = decision(example)
    context = explain_context("k401_match", inputs, result, SEEDED, [])
    allowed = AllowedNumbers.from_decision(inputs, result)
    for fact in context.facts:
        check = verify_explanation(
            ExplanationDraft(
                concept="c",
                text=f"{fact.label}: {fact.value}.",
                numbers=[],
                what_ifs=[*context.notes],
                citation_keys=["k401.employer_match"],
            ),
            allowed,
            {"k401.employer_match"},
        )
        assert check.passed, (fact, check)


@pytest.mark.parametrize("example", sorted(EXAMPLES))
def test_fallback_passes_the_verifier(example: str) -> None:
    inputs, result = decision(example)
    keys = {c.key for c in SEEDED}
    draft = fallback_draft("k401_match", inputs, result, keys)
    check = verify_explanation(draft, AllowedNumbers.from_decision(inputs, result), keys)
    assert check.passed, (draft.text, check)
    assert draft.citation_keys == [key for key in result["citation_keys"] if key in keys]


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
    draft = fallback_draft("k401_match", inputs, result, set())
    assert "already" in draft.text
    assert "missing" not in draft.text
    assert draft.citation_keys == []


def test_fallback_and_context_need_a_registered_calculator() -> None:
    with pytest.raises(ValueError, match="w4"):
        fallback_draft("w4", {}, {}, set())
    with pytest.raises(ValueError, match="w4"):
        explain_context("w4", {}, {}, [], [])
