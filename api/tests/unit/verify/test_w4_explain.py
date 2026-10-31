"""The explain context's facts and notes and the fallback text for W-4 decisions
(spec 014 rule 19, spec 008 rule 7b), on spec 014's examples. Both must pass the
verifier by construction, with and without what the pay stub withholds."""

from __future__ import annotations

from decimal import Decimal
from typing import Any

import pytest

from calc.k401 import K401MatchInput, k401_match
from calc.w4 import W4Input, w4
from db.enums import CalculatorKind
from llm.schemas import ExplanationDraft
from retrieval.citations import Citation
from retrieval.context import (
    BENEFITS_QUERIES,
    W4_NO_STUB_NOTE,
    W4_STUB_DIFFERS_NOTE,
    W4_STUB_SAME_NOTE,
    explain_context,
    explain_setup,
    pay_stub_numbers,
)
from verify.allowed import AllowedNumbers
from verify.fallback import fallback_draft
from verify.numbers import extract_numbers
from verify.verify import verify_explanation

# Spec 014's examples and the edge cases with a suggestion, as input changes.
W4_EXAMPLES: dict[str, dict[str, Any]] = {
    "1": {"salary_cents": 5_187_000},
    "2b": {"salary_cents": 6_500_000, "pay_periods_per_year": 24},
    "3": {
        "salary_cents": 6_500_000,
        "k401_contribution_pct": "5",
        "health_premium_per_paycheck_cents": 6_250,
    },
    "4": {
        "salary_cents": 6_000_000,
        "filing_status": "married_filing_jointly",
        "multiple_jobs": True,
        "other_jobs_wages_cents": 6_000_000,
        "other_jobs_withholding_cents": 502_008,
    },
    "5": {
        "salary_cents": 5_000_000,
        "other_jobs_wages_cents": 2_000_000,
        "other_jobs_withholding_cents": 39_000,
    },
    "6": {
        "salary_cents": 4_000_000,
        "filing_status": "head_of_household",
        "dependents_credit_cents": 440_000,
    },
    "7": {
        "salary_cents": 8_000_000,
        "pay_periods_per_year": 24,
        "other_income_cents": 200_000,
        "deductions_cents": 500_000,
    },
    "8": {"salary_cents": 6_500_000, "extra_withholding_cents": 10_000},
    "9": {
        "salary_cents": 9_000_000,
        "filing_status": "married_filing_jointly",
        "multiple_jobs": True,
        "other_jobs_wages_cents": 3_000_000,
        "other_jobs_withholding_cents": 142_012,
    },
    "9-saved": {
        "salary_cents": 9_000_000,
        "filing_status": "married_filing_jointly",
        "multiple_jobs": True,
        "other_jobs_wages_cents": 3_000_000,
        "other_jobs_withholding_cents": 142_012,
        "deductions_cents": 1_068_300,
        "expected_deductions_cents": 0,
    },
    "10": {"salary_cents": 25_000_000, "k401_contribution_pct": "15", "age": 30},
    # Issue 181's decision, the e2e account, saved before issue 153 (no stub figure).
    "11": {
        "salary_cents": 9_500_010,
        "k401_contribution_pct": "5",
        "age": 24,
        "health_premium_per_paycheck_cents": 400,
    },
    "12": {
        "salary_cents": 6_500_000,
        "pay_periods_per_year": 24,
        "k401_contribution_pct": "4",
        "age": 30,
        "health_premium_per_paycheck_cents": 6_250,
    },
    "step2-alone": {"salary_cents": 6_500_000, "multiple_jobs": True},
}
# What the newest stub withholds a paycheck (spec 008 rule 7b): nothing known, the
# entries' own figure, stub-01's $272.44, or a confirmed 0.
STUBS: dict[str, str | int | None] = {
    "none": None,
    "entries": "entries",
    "other": 27_244,
    "zero": 0,
}
SEEDED_KEYS = (
    "w4.dependents_credit",
    "w4.federal_brackets",
    "w4.form_adjustments",
    "w4.multiple_jobs",
    "w4.percentage_method",
    "w4.pretax_deferral",
    "w4.standard_deduction",
)
SEEDED = [
    Citation(
        key=key,
        title=key,
        url="https://www.irs.gov/x",
        passage="Quoted words with $16,100 and Step 4(c).",
        source="Pub. 15-T",
        tax_year=2026,
    )
    for key in SEEDED_KEYS
]
ENTRIES_PER_PAYCHECK = "Federal income tax these entries would withhold per paycheck"
STUB_PER_PAYCHECK = "Federal income tax your latest pay stub withholds per paycheck"
ENTRIES_PER_YEAR = "Federal income tax these entries would withhold per year"
STUB_PER_YEAR = (
    "Federal income tax withheld per year if every paycheck withholds what your latest pay"
    " stub does"
)


def w4_decision(example: str) -> tuple[dict[str, Any], dict[str, Any]]:
    data = W4Input.model_validate(
        {
            "pay_periods_per_year": 26,
            "filing_status": "single",
            "tax_year": 2026,
            **W4_EXAMPLES[example],
        }
    )
    return data.model_dump(mode="json"), w4(data).model_dump(mode="json")


def stub_withholding(example: str, stub: str) -> int | None:
    value = STUBS[stub]
    if value == "entries":
        _, result = w4_decision(example)
        withheld: int = result["withholding_per_paycheck_cents"]
        return withheld
    assert value is None or isinstance(value, int)
    return value


def facts_of(example: str, pay_stub_withholding_cents: int | None = None) -> dict[str, str]:
    inputs, result = w4_decision(example)
    context = explain_context(
        "w4", inputs, result, SEEDED, [], pay_stub_withholding_cents=pay_stub_withholding_cents
    )
    return {fact.label: fact.value for fact in context.facts}


def setup_of(example: str, stub: int | None) -> Any:
    inputs, result = w4_decision(example)
    return explain_setup(
        "w4", inputs, result, SEEDED, [], pay_stub_pct=None, pay_stub_withholding_cents=stub
    )


def test_w4_has_a_benefits_query() -> None:
    assert "premium" in BENEFITS_QUERIES[CalculatorKind.W4]


def test_w4_context_for_example_5() -> None:
    inputs, result = w4_decision("5")
    context = explain_context("w4", inputs, result, SEEDED, [])
    facts = {fact.label: fact.value for fact in context.facts}
    assert facts[ENTRIES_PER_PAYCHECK] == "$146.92"
    assert facts[ENTRIES_PER_YEAR] == "$3,819.92"
    assert facts["Projected federal income tax for the year after credits"] == "$6,570.00"
    assert facts["Projected balance due with these entries"] == "$2,360.08"
    assert facts["Withholding table rate"] == "12%"
    assert facts["Other jobs' wages per year"] == "$20,000.00"
    assert facts["Suggested Step 4(c) extra withholding per paycheck"] == "$91.00"
    assert facts["Projected refund with the suggested entries"] == "$5.92"
    assert facts["Paychecks per year"] == "26"
    assert facts["Tax year"] == "2026"
    assert context.calculator == "w4"
    assert [c.key for c in context.citations][: len(result["citation_keys"])] == result[
        "citation_keys"
    ]
    assert any("balance due" in note for note in context.notes)
    # Facts are numbers only, so any fact a draft repeats shows a figure.
    for fact in context.facts:
        assert extract_numbers(fact.value), fact


def test_w4_context_shows_only_entries_that_are_set() -> None:
    facts = facts_of("1")
    assert "Projected balance due with these entries" in facts
    assert not any("Step 3" in label or "Step 4" in label for label in facts)
    assert not any("401(k)" in label for label in facts)
    facts = facts_of("3")
    assert facts["401(k) contributions per year, before tax"] == "$3,250.00"
    assert facts["Health premiums per year, before tax"] == "$1,625.00"
    facts = facts_of("7")
    assert facts["Step 4(a) other income per year"] == "$2,000.00"
    assert facts["Step 4(b) deductions per year"] == "$5,000.00"
    assert facts["Projected refund with these entries"] == "$0.08"


def test_w4_notes() -> None:
    def notes(example: str, stub: str = "none") -> list[str]:
        inputs, result = w4_decision(example)
        return explain_context(
            "w4",
            inputs,
            result,
            SEEDED,
            [],
            pay_stub_withholding_cents=stub_withholding(example, stub),
        ).notes

    assert any("half" in note for note in notes("4"))
    assert any("unchecked" in note for note in notes("step2-alone"))
    assert any("expected" in note for note in notes("9"))
    assert any("more than the tax" in note for note in notes("6"))
    assert any("limit" in note for note in notes("10"))
    for example in W4_EXAMPLES:
        for stub in STUBS:
            for note in notes(example, stub):
                assert not extract_numbers(note), (example, stub, note)


@pytest.mark.parametrize("stub", sorted(STUBS))
@pytest.mark.parametrize("example", sorted(W4_EXAMPLES))
def test_every_w4_fact_passes_the_verifier(example: str, stub: str) -> None:
    setup = setup_of(example, stub_withholding(example, stub))
    for fact in setup.context.facts:
        check = verify_explanation(
            ExplanationDraft(
                concept="c",
                text=" ".join([f"{fact.label}: {fact.value}.", *setup.context.notes]),
                numbers=[],
                what_ifs=[],
                citation_keys=["w4.percentage_method"],
            ),
            setup.allowed_numbers,
            {"w4.percentage_method"},
        )
        assert check.passed, (fact, check)


@pytest.mark.parametrize("stub", sorted(STUBS))
@pytest.mark.parametrize("example", sorted(W4_EXAMPLES))
def test_w4_fallback_passes_the_verifier(example: str, stub: str) -> None:
    setup = setup_of(example, stub_withholding(example, stub))
    _, result = w4_decision(example)
    check = verify_explanation(setup.fallback, setup.allowed_numbers, setup.citation_keys)
    assert check.passed, (setup.fallback.text, check)
    assert setup.fallback.citation_keys == result["citation_keys"]
    # It says what the entries would do, never what the employer withholds now.
    assert "your employer withholds" not in setup.fallback.text


def test_w4_fallback_for_example_5_reads_plainly() -> None:
    inputs, result = w4_decision("5")
    draft = fallback_draft("w4", inputs, result, {"w4.percentage_method"})
    assert "$146.92" in draft.text
    assert "owe about $2,360.08" in draft.text
    assert "$91.00" in draft.text
    assert "Step 4(c)" in draft.text
    assert draft.citation_keys == ["w4.percentage_method"]


def test_w4_fallback_for_example_9_explains_the_deductions_entry() -> None:
    inputs, result = w4_decision("9")
    draft = fallback_draft("w4", inputs, result, set())
    assert "$10,683.00" in draft.text
    assert "Step 4(b)" in draft.text
    assert draft.citation_keys == []


# ------------------------------------------------- issue 181 (spec 008 rule 7b)


def test_context_for_issue_181_when_the_stub_withholds_another_amount() -> None:
    """Stub-01 withholds $272.44; the entries would withhold $423.16. The model
    sees both, apart, and the balance due if nothing changes."""
    inputs, result = w4_decision("11")
    assert "current_withholding_per_paycheck_cents" not in W4_EXAMPLES["11"]
    context = explain_context("w4", inputs, result, SEEDED, [], pay_stub_withholding_cents=27_244)
    assert [(fact.label, fact.value) for fact in context.facts[:4]] == [
        (ENTRIES_PER_PAYCHECK, "$423.16"),
        (STUB_PER_PAYCHECK, "$272.44"),
        (ENTRIES_PER_YEAR, "$11,002.16"),
        (STUB_PER_YEAR, "$7,083.44"),
    ]
    facts = {fact.label: fact.value for fact in context.facts}
    assert facts["Projected refund with these entries"] == "$0.02"
    assert facts["Projected balance due at your pay stub's withholding"] == "$3,918.70"
    labels = [fact.label for fact in context.facts]
    assert labels.index("Projected refund with these entries") + 1 == labels.index(
        "Projected balance due at your pay stub's withholding"
    )
    assert context.notes[:3] == [
        W4_STUB_DIFFERS_NOTE,
        "With these entries the projection is a refund: they would withhold more than the"
        " year's tax.",
        "At what the latest pay stub withholds, the year ends in a balance due: less is"
        " withheld than the year's tax.",
    ]


def test_context_for_issue_181_when_the_stub_withholds_what_the_entries_give() -> None:
    facts = facts_of("11", 42_316)
    assert facts[STUB_PER_PAYCHECK] == "$423.16"
    assert STUB_PER_YEAR not in facts
    assert not any("pay stub's withholding" in label for label in facts)
    inputs, result = w4_decision("11")
    notes = explain_context(
        "w4", inputs, result, SEEDED, [], pay_stub_withholding_cents=42_316
    ).notes
    assert notes[0] == W4_STUB_SAME_NOTE
    assert not any(note.startswith("At what the latest pay stub") for note in notes)


def test_context_for_issue_181_without_a_stub() -> None:
    facts = facts_of("11")
    assert list(facts)[:2] == [ENTRIES_PER_PAYCHECK, ENTRIES_PER_YEAR]
    assert not any("pay stub" in label for label in facts)
    inputs, result = w4_decision("11")
    assert explain_context("w4", inputs, result, SEEDED, []).notes[0] == W4_NO_STUB_NOTE


def test_stub_outcome_notes() -> None:
    """The outcome at the stub is a refund, a balance due or even, by its own sign."""
    inputs, result = w4_decision("12")
    notes = explain_context(
        "w4", inputs, result, SEEDED, [], pay_stub_withholding_cents=29_776
    ).notes
    assert (
        "At what the latest pay stub withholds, the year ends in a refund: more is withheld"
        " than the year's tax."
    ) in notes
    # A tax that 26 paychecks of $272.44 cover exactly.
    inputs, result = w4_decision("11")
    even = {**result, "projected_tax_after_credits_cents": 27_244 * 26}
    notes = explain_context("w4", inputs, even, SEEDED, [], pay_stub_withholding_cents=27_244).notes
    assert (
        "At what the latest pay stub withholds, what is withheld matches the projected tax for"
        " the year."
    ) in notes
    # Example 6: credits cover the tax, so the entries withhold nothing; a stub that
    # withholds nothing withholds what they give.
    inputs, result = w4_decision("6")
    notes = explain_context("w4", inputs, result, SEEDED, [], pay_stub_withholding_cents=0).notes
    assert notes[0] == W4_STUB_SAME_NOTE


@pytest.mark.parametrize(
    ("stub", "text", "unmatched"),
    [
        (
            27_244,
            "Your latest pay stub withholds $272.44 a paycheck now. If nothing changes, you"
            " would owe about $3,919 at tax time.",
            (),
        ),
        (27_244, "These entries would withhold $423.16 a paycheck, $11,002.16 over the year.", ()),
        (None, "Your latest pay stub withholds $272.44 a paycheck now.", ("$272.44",)),
    ],
)
def test_issue_181_drafts(stub: int | None, text: str, unmatched: tuple[str, ...]) -> None:
    setup = setup_of("11", stub)
    draft = ExplanationDraft(
        concept="c", text=text, numbers=[], what_ifs=[], citation_keys=["w4.percentage_method"]
    )
    check = verify_explanation(draft, setup.allowed_numbers, setup.citation_keys)
    assert check.numbers_unmatched == unmatched
    assert check.passed is (unmatched == ())


ISSUE_181_OPENING = (
    "These Form W-4 entries would withhold $423.16 of federal income tax from each paycheck,"
    " $11,002.16 over the year. Your projected federal income tax for 2026 is $11,002.14, so"
    " with these entries you would get a refund of about $0.02."
)


def test_fallback_for_issue_181() -> None:
    draft = setup_of("11", 27_244).fallback
    assert draft.text.startswith(
        ISSUE_181_OPENING + " Your latest pay stub withholds $272.44 a paycheck now. If every"
        " paycheck this year withholds that, $7,083.44 in all, you would owe about $3,918.70."
        " These entries change that once you give your employer your updated Form W-4."
        " Your $4,750.01 of 401(k) contributions and $104.00 of health premiums a year come"
        " out before tax"
    )
    assert {claim.value for claim in draft.numbers} >= {"$423.16", "$272.44", "$3,918.70"}
    same = setup_of("11", 42_316).fallback
    assert same.text.startswith(
        ISSUE_181_OPENING + " Your latest pay stub withholds $423.16 a paycheck, the same as"
        " these entries, so they are in effect now."
    )
    none = setup_of("11", None).fallback
    assert none.text.startswith(ISSUE_181_OPENING + " Your $4,750.01 of 401(k) contributions")
    assert "pay stub" not in none.text


def test_fallback_states_a_refund_at_the_stub() -> None:
    draft = setup_of("12", 29_776).fallback
    assert (
        "Your latest pay stub withholds $297.76 a paycheck now. If every paycheck this year"
        " withholds that, $7,146.24 in all, you would get a refund of about $2,018.24."
    ) in draft.text


def test_pay_stub_numbers_for_w4() -> None:
    inputs, result = w4_decision("11")
    assert pay_stub_numbers("w4", inputs, result, pay_stub_withholding_cents=27_244) == {
        "pay_stub_withholding_per_paycheck_cents": 27_244,
        "pay_stub_annual_withholding_cents": 708_344,
        "pay_stub_refund_cents": -391_870,
    }
    assert pay_stub_numbers("w4", inputs, result, pay_stub_withholding_cents=None) == {}
    # A W-4 decision has no 401(k) rate to compare, and a 401(k) one no withholding.
    assert pay_stub_numbers("w4", inputs, result, pay_stub_pct=None) == {}
    allowed = AllowedNumbers.from_decision(
        {}, {}, pay_stub_numbers("w4", inputs, result, pay_stub_withholding_cents=27_244)
    )
    assert allowed.money_exact == {Decimal("272.44"), Decimal("7083.44"), Decimal("3918.70")}
    assert Decimal("3919") in allowed.money_whole


def test_the_digest_follows_the_stub_withholding() -> None:
    """Spec 008 rule 19a: a newer stub with another withholding makes a stored W-4
    explanation stale; the same withholding keeps it current."""
    digests = {stub: setup_of("11", stub).digest for stub in (None, 27_244, 42_316, 0)}
    assert len(set(digests.values())) == 4
    assert setup_of("11", 27_244).digest == digests[27_244]


def test_other_calculators_ignore_the_pay_stub_withholding() -> None:
    data = K401MatchInput.model_validate(
        {
            "salary_cents": 9_500_010,
            "pay_periods_per_year": 26,
            "match_tiers": [],
            "contribution_pct": "5",
            "tax_year": 2026,
            "filing_status": "single",
            "age": 24,
        }
    )
    inputs, result = data.model_dump(mode="json"), k401_match(data).model_dump(mode="json")

    def setup(stub: int | None) -> Any:
        return explain_setup(
            "k401_match",
            inputs,
            result,
            [],
            [],
            pay_stub_pct=None,
            pay_stub_withholding_cents=stub,
        )

    assert setup(None) == setup(27_244)
    assert pay_stub_numbers("k401_match", inputs, result, pay_stub_withholding_cents=27_244) == {}
