"""Readable drafts (spec 008 rule 24f, issue 204), shared by the explain suites.

The Why page is read by someone in their first salaried job, so a final draft
should be short and write large amounts in whole dollars. Both are measured in
code over the decisions whose final row is a draft (a fallback's text is
code's, spec 008 rule 17, and ``no_fallback`` counts it already). Neither gates
a draft: the verifier still accepts exact cents.

- ``concise``: the share whose ``text`` has at most ``WORD_LIMIT`` words.
- ``whole_dollars``: the share that writes no amount of ``WHOLE_DOLLARS_FROM``
  or more with cents, in the concept, text, what-ifs or number values.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal

from llm.schemas import ExplanationDraft
from verify.numbers import extract_numbers

WORD_LIMIT = 150
WHOLE_DOLLARS_FROM = Decimal(100)


def word_count(text: str) -> int:
    return len(text.split())


def cents_on_large_amounts(draft: ExplanationDraft) -> list[str]:
    """Every money token of $100 or more the draft writes with cents, as written."""
    parts = [draft.concept, draft.text, *draft.what_ifs, *(claim.value for claim in draft.numbers)]
    return [
        token.raw
        for part in parts
        for token in extract_numbers(part)
        if token.kind == "money" and token.has_cents and abs(token.value) >= WHOLE_DOLLARS_FROM
    ]


@dataclass
class Readability:
    """Counts over one suite run's final rows; ``add`` each decision's final row."""

    drafted: int = 0
    concise: int = 0
    whole_dollars: int = 0
    failures: list[str] = field(default_factory=list)

    def add(self, decision_id: str, draft: ExplanationDraft, *, fallback: bool) -> None:
        if fallback:
            return
        self.drafted += 1
        words = word_count(draft.text)
        if words <= WORD_LIMIT:
            self.concise += 1
        else:
            self.failures.append(f"{decision_id}: text is {words} words, over {WORD_LIMIT}")
        cents = cents_on_large_amounts(draft)
        if cents:
            self.failures.append(f"{decision_id}: cents on $100 or more: {', '.join(cents)}")
        else:
            self.whole_dollars += 1

    def metrics(self) -> dict[str, float]:
        if not self.drafted:
            return {"concise": 1.0, "whole_dollars": 1.0}
        return {
            "concise": self.concise / self.drafted,
            "whole_dollars": self.whole_dollars / self.drafted,
        }

    def case_worth(self) -> dict[str, float]:
        """One case is one drafted decision."""
        worth = 1 / self.drafted if self.drafted else 0.0
        return {"concise": worth, "whole_dollars": worth}
