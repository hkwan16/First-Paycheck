"""Check a drafted explanation against the calculator (spec 008 rules 14 and 14a)."""

from __future__ import annotations

from collections.abc import Collection
from dataclasses import dataclass
from typing import Any

from llm.schemas import ExplanationDraft
from verify.allowed import AllowedNumbers
from verify.numbers import extract_numbers
from verify.zero_cost import zero_cost_claims

__all__ = ["Verification", "verify_explanation"]


@dataclass(frozen=True)
class Verification:
    numbers_checked: int
    # The raw text of every number no allowed value matched, in reading order.
    numbers_unmatched: tuple[str, ...]
    citations_checked: int
    citations_unknown: tuple[str, ...]
    has_citation: bool
    # Each sentence that says a cost is zero where none may be (rule 14a).
    zero_cost_claims: tuple[str, ...] = ()

    @property
    def passed(self) -> bool:
        return (
            not self.numbers_unmatched
            and not self.citations_unknown
            and self.has_citation
            and not self.zero_cost_claims
        )

    def feedback(self) -> str:
        """One line per problem, for the retry; empty when the draft passed."""
        lines = [
            f"The number {raw!r} is not one of the facts; use only the facts' numbers."
            for raw in self.numbers_unmatched
        ]
        lines += [
            f"The citation key {key!r} is not in the allowed citations."
            for key in self.citations_unknown
        ]
        if not self.has_citation:
            lines.append("Cite at least one of the allowed citation keys.")
        lines += [
            f"The sentence {sentence!r} says the choice costs nothing per paycheck, but every"
            " cost per paycheck in the facts is above zero; state the cost a fact gives, or"
            " leave the sentence out."
            for sentence in self.zero_cost_claims
        ]
        return "\n".join(lines)

    def as_json(self) -> dict[str, Any]:
        return {
            "numbers_checked": self.numbers_checked,
            "numbers_unmatched": list(self.numbers_unmatched),
            "citations_checked": self.citations_checked,
            "citations_unknown": list(self.citations_unknown),
            "has_citation": self.has_citation,
            "zero_cost_claims": list(self.zero_cost_claims),
        }


def verify_explanation(
    draft: ExplanationDraft,
    allowed_numbers: AllowedNumbers,
    allowed_citation_keys: Collection[str],
) -> Verification:
    texts = [draft.concept, draft.text, *draft.what_ifs]
    checked = 0
    unmatched: list[str] = []

    def check(text: str) -> int:
        nonlocal checked
        tokens = extract_numbers(text)
        checked += len(tokens)
        unmatched.extend(token.raw for token in tokens if not allowed_numbers.allows(token))
        return len(tokens)

    for text in texts:
        check(text)
    for claim in draft.numbers:
        if check(claim.value) == 0:
            # A claimed figure with no number in it cannot be checked.
            unmatched.append(claim.value)
        check(claim.label)
    unknown = tuple(key for key in draft.citation_keys if key not in allowed_citation_keys)
    zero_costs: tuple[str, ...] = ()
    if not allowed_numbers.zero_cost:
        zero_costs = tuple(sentence for text in texts for sentence in zero_cost_claims(text))
    return Verification(
        numbers_checked=checked,
        numbers_unmatched=tuple(unmatched),
        citations_checked=len(draft.citation_keys),
        citations_unknown=unknown,
        has_citation=bool(draft.citation_keys),
        zero_cost_claims=zero_costs,
    )
