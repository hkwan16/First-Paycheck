"""verify/flow.py: draft, verify, one retry with feedback, then the fallback.

Spec 008 rules 15-16.
"""

from __future__ import annotations

import uuid
from collections.abc import Sequence

import pytest

from llm.gateway import LLMBudgetExceeded, LLMRefused, LLMSchemaError
from llm.schemas import ExplainContext, ExplainFact, ExplanationDraft
from verify.allowed import AllowedNumbers
from verify.flow import Attempt, run_explain

USER = uuid.UUID("00000000-0000-4000-8000-00000000f10e")
CONTEXT = ExplainContext(
    calculator="k401_match",
    tax_year=2026,
    facts=[ExplainFact(label="Match you miss per year", value="$600.00")],
    notes=[],
    citations=[],
    benefits_passages=[],
)
ALLOWED = AllowedNumbers.from_decision({"missed_cents": 60_000, "contribution_pct": "3.00"})
KEYS = frozenset({"k401.employer_match"})


def draft(text: str) -> ExplanationDraft:
    return ExplanationDraft(
        concept="The match",
        text=text,
        numbers=[],
        what_ifs=[],
        citation_keys=["k401.employer_match"],
    )


GOOD = draft("You miss $600.00 a year at 3%.")
BAD = draft("You miss $650.00 a year.")
FALLBACK = draft("Plain result: you miss $600.00.")


class Scripted:
    """Answers in order; an exception in the script is raised instead."""

    def __init__(self, *answers: ExplanationDraft | Exception) -> None:
        self.answers = list(answers)
        self.feedback: list[str | None] = []

    def explain(
        self, user_id: uuid.UUID, context: ExplainContext, *, feedback: str | None = None
    ) -> ExplanationDraft:
        assert user_id == USER
        assert context is CONTEXT
        self.feedback.append(feedback)
        answer = self.answers.pop(0)
        if isinstance(answer, Exception):
            raise answer
        return answer


def run(*answers: ExplanationDraft | Exception) -> tuple[Scripted, list[Attempt]]:
    drafter = Scripted(*answers)
    return drafter, run_explain(drafter, USER, CONTEXT, ALLOWED, KEYS, FALLBACK)


def shape(attempts: Sequence[Attempt]) -> list[tuple[int, int, bool, bool]]:
    return [(a.attempt, a.retries, a.verified, a.fallback) for a in attempts]


def test_pass_first_try() -> None:
    drafter, attempts = run(GOOD)
    assert shape(attempts) == [(1, 0, True, False)]
    assert drafter.feedback == [None]


def test_fail_then_pass_sends_the_feedback() -> None:
    drafter, attempts = run(BAD, GOOD)
    assert shape(attempts) == [(1, 0, False, False), (2, 1, True, False)]
    assert drafter.feedback[0] is None
    assert "$650.00" in (drafter.feedback[1] or "")


def test_fail_twice_falls_back() -> None:
    _, attempts = run(BAD, BAD)
    assert shape(attempts) == [(1, 0, False, False), (2, 1, False, False), (3, 1, False, True)]
    last = attempts[-1]
    assert last.draft == FALLBACK
    assert last.verification.passed


@pytest.mark.parametrize(
    "error", [LLMRefused("no"), LLMBudgetExceeded("spent"), LLMSchemaError("bad json")]
)
def test_a_gateway_error_falls_back_at_once(error: Exception) -> None:
    drafter, attempts = run(error)
    assert shape(attempts) == [(1, 0, False, True)]
    assert len(drafter.feedback) == 1


def test_an_error_on_the_retry_falls_back() -> None:
    _, attempts = run(BAD, LLMRefused("no"))
    assert shape(attempts) == [(1, 0, False, False), (2, 1, False, True)]


def test_other_errors_propagate() -> None:
    with pytest.raises(KeyError):
        run(KeyError("bug"))
