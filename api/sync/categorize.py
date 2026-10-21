"""Transaction categorization (spec 003).

Plain-string rules first, in a fixed precedence (user exact, user prefix,
seed exact, seed prefix); only merchants no rule knows go to the LLM gateway,
50 per call. A user's correction becomes a user exact rule and relabels the
same merchant's other transactions.
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Iterable, Iterator
from dataclasses import dataclass

from db.enums import RuleMatch, RuleSource
from sync.categories import CATEGORIES

MAX_MERCHANT_NORM = 128
PROCESSOR_PREFIXES = frozenset({"sq", "tst", "pp", "sp", "pos", "checkcard"})
_APOSTROPHES = str.maketrans("", "", "'\N{RIGHT SINGLE QUOTATION MARK}")
# Token characters: letters and digits (Unicode \w without "_"), "." and "&".
_SEPARATORS = re.compile(r"[^\w.&]+|_")
_DIGIT = re.compile(r"\d")


def normalize_merchant(raw: str) -> str:
    """The rule-matching key for a merchant description (spec 003 rule 1)."""
    text = unicodedata.normalize("NFKC", raw).lower().translate(_APOSTROPHES)
    tokens = [token.strip(".") for token in _SEPARATORS.split(text) if not _DIGIT.search(token)]
    tokens = [token for token in tokens if token]
    while len(tokens) > 1 and tokens[0] in PROCESSOR_PREFIXES:
        tokens.pop(0)
    return " ".join(tokens)[:MAX_MERCHANT_NORM].rstrip()


def token_prefixes(merchant_norm: str) -> Iterator[str]:
    """Every whole-token prefix of ``merchant_norm``, longest first."""
    tokens = merchant_norm.split(" ") if merchant_norm else []
    for end in range(len(tokens), 0, -1):
        yield " ".join(tokens[:end])


@dataclass(frozen=True)
class CategoryRule:
    merchant_norm: str
    match: RuleMatch
    category: str
    source: RuleSource


class RuleBook:
    """The rules one user sees (their own plus the seed rows), indexed for
    hash lookups: one exact lookup and one lookup per whole-token prefix."""

    def __init__(self, rules: Iterable[CategoryRule]) -> None:
        self._index: dict[tuple[RuleSource, RuleMatch], dict[str, CategoryRule]] = {
            (source, match): {} for source in RuleSource for match in RuleMatch
        }
        for rule in rules:
            if rule.category not in CATEGORIES:
                raise ValueError(
                    f"rule {rule.merchant_norm!r} has unknown category {rule.category!r}"
                )
            self._index[(rule.source, rule.match)][rule.merchant_norm] = rule

    def match(self, merchant_norm: str) -> CategoryRule | None:
        if not merchant_norm:
            return None
        for source in (RuleSource.USER, RuleSource.SEED):
            exact = self._index[(source, RuleMatch.EXACT)].get(merchant_norm)
            if exact is not None:
                return exact
            prefixes = self._index[(source, RuleMatch.PREFIX)]
            for prefix in token_prefixes(merchant_norm):
                found = prefixes.get(prefix)
                if found is not None:
                    return found
        return None


def apply_rules(merchant_norm: str, rules: RuleBook) -> CategoryRule | None:
    """The rule that decides ``merchant_norm``'s category, or None for the LLM."""
    return rules.match(merchant_norm)
