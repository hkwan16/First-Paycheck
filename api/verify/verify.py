"""Check a drafted explanation against the calculator (spec 008 rule 14)."""

from __future__ import annotations

from collections.abc import Collection
from dataclasses import dataclass
from typing import Any

from llm.schemas import ExplanationDraft
from verify.allowed import AllowedNumbers
from verify.numbers import extract_numbers

__all__ = ["Verification", "verify_explanation"]


@dataclass(frozen=True)
class Verification:
    numbers_checked: int
    # The raw text of every number no allowed value matched, in reading order.
    numbers_unmatched: tuple[str, ...]
    citations_checked: int
    citations_unknown: tuple[str, ...]
    has_citation: bool

    @property
    def passed(self) -> bool:
        return not self.numbers_unmatched and not self.citations_unknown and self.has_citation

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
        return "\n".join(lines)

    def as_json(self) -> dict[str, Any]:
        return {
            "numbers_checked": self.numbers_checked,
            "numbers_unmatched": list(self.numbers_unmatched),
            "citations_checked": self.citations_checked,
            "citations_unknown": list(self.citations_unknown),
            "has_citation": self.has_citation,
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
    return Verification(
        numbers_checked=checked,
        numbers_unmatched=tuple(unmatched),
        citations_checked=len(draft.citation_keys),
        citations_unknown=unknown,
        has_citation=bool(draft.citation_keys),
    )
