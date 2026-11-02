"""Readable drafts (spec 008 rule 24f): the hand-worked examples, row by row."""

from __future__ import annotations

import pytest

from evals.suites.readability import Readability
from llm.schemas import ExplanationDraft, NumberClaim


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


@pytest.mark.parametrize(
    ("example", "concise", "whole_dollars"),
    [
        (draft("At the 5% you chose, your employer would add $3,800 a year."), True, True),
        (draft(" ".join(["word"] * 151)), False, True),
        (draft("You would put in $4,750.01 a year."), True, False),
        (draft("That is $46.15 a paycheck, about $41 after tax."), True, True),
        (draft(what_ifs=("Raising it to 6% costs $2,400.00 more a year.",)), True, False),
        (draft(numbers=("$3,918.70",)), True, False),
    ],
)
def test_the_spec_examples(example: ExplanationDraft, concise: bool, whole_dollars: bool) -> None:
    readability = Readability()
    readability.add("case", example, fallback=False)
    assert readability.metrics() == {
        "concise": float(concise),
        "whole_dollars": float(whole_dollars),
    }


def test_exactly_150_words_is_concise() -> None:
    readability = Readability()
    readability.add("case", draft(" ".join(["word"] * 150)), fallback=False)
    assert readability.metrics()["concise"] == 1.0


def test_a_fallback_is_not_counted() -> None:
    """27 of 28 drafted decisions concise, and a fallback ending the 29th: 27/28."""
    readability = Readability()
    for index in range(27):
        readability.add(f"short-{index}", draft(), fallback=False)
    readability.add("long", draft(" ".join(["word"] * 151)), fallback=False)
    readability.add("fell-back", draft("You would put in $4,750.01 a year."), fallback=True)
    assert readability.metrics()["concise"] == pytest.approx(27 / 28)
    assert readability.metrics()["whole_dollars"] == 1.0
    assert readability.case_worth() == {
        "concise": pytest.approx(1 / 28),
        "whole_dollars": pytest.approx(1 / 28),
    }


def test_failure_lines_name_the_decision_and_what_to_fix() -> None:
    readability = Readability()
    readability.add("long", draft(" ".join(["word"] * 151)), fallback=False)
    readability.add("cents", draft("You put in $4,750.01, and $2,400.00 more."), fallback=False)
    assert readability.failures == [
        "long: text is 151 words, over 150",
        "cents: cents on $100 or more: $4,750.01, $2,400.00",
    ]


def test_no_drafted_decision_scores_full_and_weighs_nothing() -> None:
    readability = Readability()
    readability.add("fell-back", draft(), fallback=True)
    assert readability.metrics() == {"concise": 1.0, "whole_dollars": 1.0}
    assert readability.case_worth() == {"concise": 0.0, "whole_dollars": 0.0}
