"""Sentences that say a cost is zero (spec 008 rule 14a, issue 223).

A zero written in words ("would cost no extra per paycheck") is a figure the
number check cannot see. Every cost a 401(k) explanation is given is above
zero (rule 7c), so for a 401(k) decision such a sentence has no fact behind
it. This reads only that one claim; the forms it knows are the spec's.
"""

from __future__ import annotations

import re

__all__ = ["zero_cost_claims"]

# A sentence ends at ".", "!" or "?" followed by a space ("$0.00" stays whole).
_SENTENCE_END = re.compile(r"(?<=[.!?])\s+")
# Money first, so "$0.00" is one word; then words with an inner apostrophe.
_WORD = re.compile(r"\$\d[\d,]*(?:\.\d+)?|[a-z]+(?:'[a-z]+)?")
_ZERO_MONEY = re.compile(r"\$0(?:\.0+)?")

_COST_VERBS = frozenset({"cost", "costs", "costing"})
_COST_NOUNS = frozenset({"cost", "costs", "charge", "charges"})
_ZERO_WORDS = frozenset({"nothing", "no", "zero", "none"})
_NONE_BEFORE_COST = frozenset({"no", "zero"})
_ADDED = frozenset({"extra", "additional", "added"})
_MORE = frozenset({"extra", "more", "additional"})
_NEGATIONS = frozenset({"not", "never"})
# Words about money leaving a paycheck, allowed between "no more" and "paycheck".
_LEAVING = frozenset(
    {
        "per",
        "from",
        "out",
        "of",
        "each",
        "a",
        "in",
        "on",
        "for",
        "your",
        "the",
        "taken",
        "comes",
        "goes",
        "is",
        "would",
        "be",
    }
)
_PAYCHECK = frozenset({"paycheck", "paychecks"})
_ABOUT_PAY = ("paycheck", "cost", "take-home")


def _words(sentence: str) -> list[str]:
    return _WORD.findall(sentence.lower().replace("\N{RIGHT SINGLE QUOTATION MARK}", "'"))


def _is_negation(word: str) -> bool:
    return word in _NEGATIONS or word.endswith("n't")


def _cost_then_zero(words: list[str]) -> bool:
    """A cost, then a zero within two words: "would cost no extra", "costs you nothing"."""
    return any(
        word in _COST_VERBS and _ZERO_WORDS & set(words[i + 1 : i + 3])
        for i, word in enumerate(words)
    )


def _zero_then_cost(words: list[str]) -> bool:
    """A zero before a cost: "no cost", "at no extra cost", "zero added charge"."""
    for i, word in enumerate(words):
        if word not in _NONE_BEFORE_COST:
            continue
        rest = words[i + 1 : i + 3]
        if rest[:1] and rest[0] in _COST_NOUNS:
            return True
        if len(rest) == 2 and rest[0] in _ADDED and rest[1] in _COST_NOUNS:
            return True
    return False


def _negated_cost(words: list[str]) -> bool:
    """A negated cost: "would not cost you more", "doesn't cost"."""
    return any(
        _is_negation(word) and _COST_VERBS & set(words[i + 1 : i + 3])
        for i, word in enumerate(words)
    )


def _nothing_more_per_paycheck(words: list[str]) -> bool:
    """No more from a paycheck: "no extra per paycheck", "nothing more taken out of each
    paycheck"."""
    for i, word in enumerate(words[:-1]):
        if word not in {"nothing", "no"} or words[i + 1] not in _MORE:
            continue
        for between, later in enumerate(words[i + 2 :]):
            if later in _PAYCHECK:
                return True
            if later not in _LEAVING or between >= 4:
                break
    return False


def _zero_money_about_pay(sentence: str) -> bool:
    """A zero amount in a sentence about pay or cost: "an extra $0.00 per paycheck"."""
    lowered = sentence.lower()
    zero = any(_ZERO_MONEY.fullmatch(word) for word in _words(sentence))
    return zero and any(term in lowered for term in _ABOUT_PAY)


def zero_cost_claims(text: str) -> tuple[str, ...]:
    """Each sentence of ``text`` that says a cost is zero, in reading order."""
    claims = []
    for sentence in _SENTENCE_END.split(text.strip()):
        words = _words(sentence)
        if (
            _cost_then_zero(words)
            or _zero_then_cost(words)
            or _negated_cost(words)
            or _nothing_more_per_paycheck(words)
            or _zero_money_about_pay(sentence)
        ):
            claims.append(sentence)
    return tuple(claims)
