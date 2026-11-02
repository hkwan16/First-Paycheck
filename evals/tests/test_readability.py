"""Readable drafts (spec 008 rule 24f): the hand-worked examples, row by row."""

from __future__ import annotations

import pytest

from evals.suites.readability import Readability
from llm.schemas import ExplainContext, ExplainFact, ExplanationDraft, NumberClaim
from verify.flow import Attempt
from verify.verify import Verification

# Issue 181's decision: two amounts per paycheck, which keep their cents, and a
# yearly one, which does not.
CONTEXT = ExplainContext(
    calculator="w4",
    tax_year=2026,
    facts=[
        ExplainFact(
            label="Federal income tax these entries would withhold per paycheck", value="$423.16"
        ),
        ExplainFact(
            label="Federal income tax your latest pay stub withholds per paycheck", value="$272.44"
        ),
        ExplainFact(
            label="Projected balance due at your pay stub's withholding", value="$3,918.70"
        ),
    ],
    notes=[],
    citations=[],
    benefits_passages=[],
)


def draft(
    text: str = "Your employer adds to your 401(k).",
    *,
    what_ifs: tuple[str, ...] = (),
    numbers: tuple[str, ...] = (),
) -> ExplanationDraft:
    return ExplanationDraft(
        concept="An employer match is pay you get only when you contribute.",
        text=text,
        numbers=[NumberClaim(value=value, label="A figure") for value in numbers],
        what_ifs=list(what_ifs),
        citation_keys=["k401.employer_match"],
    )


def final(example: ExplanationDraft, *, fallback: bool = False) -> Attempt:
    checked = Verification(
        numbers_checked=0,
        numbers_unmatched=(),
        citations_checked=1,
        citations_unknown=(),
        has_citation=True,
    )
    return Attempt(attempt=1, retries=0, draft=example, verification=checked, fallback=fallback)


def measure(*examples: ExplanationDraft) -> Readability:
    readability = Readability()
    for index, example in enumerate(examples):
        readability.add(f"case-{index}", final(example), CONTEXT)
    return readability


@pytest.mark.parametrize(
    ("example", "concise", "whole_dollars"),
    [
        (draft("At the 5% you chose, your employer would add $3,800 a year."), True, True),
        (draft(" ".join(["word"] * 151)), False, True),
        (draft("You would put in $4,750.01 a year."), True, False),
        (draft("That is $46.15 a paycheck, about $41 after tax."), True, True),
        (draft(what_ifs=("Raising it to 6% costs $2,400.00 more a year.",)), True, False),
        (draft(numbers=("$3,918.70",)), True, False),
        (draft("Your latest pay stub withholds $272.44 a paycheck now."), True, True),
    ],
)
def test_the_spec_examples(example: ExplanationDraft, concise: bool, whole_dollars: bool) -> None:
    assert measure(example).metrics() == {
        "concise": float(concise),
        "whole_dollars": float(whole_dollars),
    }


def test_exactly_150_words_is_concise() -> None:
    assert measure(draft(" ".join(["word"] * 150))).metrics()["concise"] == 1.0


def test_a_fallback_is_not_counted() -> None:
    """27 of 28 drafted decisions concise, and a fallback ending the 29th: 27/28."""
    readability = measure(*[draft()] * 27, draft(" ".join(["word"] * 151)))
    readability.add("fell-back", final(draft("$4,750.01 a year."), fallback=True), CONTEXT)
    assert readability.metrics()["concise"] == pytest.approx(27 / 28)
    assert readability.metrics()["whole_dollars"] == 1.0
    assert readability.case_worth() == {
        "concise": pytest.approx(1 / 28),
        "whole_dollars": pytest.approx(1 / 28),
    }


def test_failure_lines_name_the_decision_and_what_to_fix() -> None:
    readability = measure(
        draft(" ".join(["word"] * 151)),
        draft("You put in $4,750.01, and $2,400.00 more, against $423.16 a paycheck."),
    )
    assert readability.failures == [
        "case-0: text is 151 words, over 150",
        "case-1: cents on $100 or more: $4,750.01, $2,400.00",
    ]


def test_no_drafted_decision_scores_full_and_weighs_nothing() -> None:
    readability = Readability()
    readability.add("fell-back", final(draft(), fallback=True), CONTEXT)
    assert readability.metrics() == {"concise": 1.0, "whole_dollars": 1.0}
    assert readability.case_worth() == {"concise": 0.0, "whole_dollars": 0.0}
