"""Find the numbers in an explanation (spec 008 rule 11).

Reads ``$1,234.56``, ``1234``, ``6%``, ``6.0%``, ``5 percent`` and ``-$12``.
Digits that are part of a word or a reference are not numbers: statute
sections followed by a parenthesis (``401(k)``, ``414(v)``), form names
(``W-4``, ``Form 1040``), Form W-4 steps (``Step 2``) and digits glued to
letters (``3rd``, ``k401``).
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from decimal import Decimal
from typing import Literal

__all__ = ["NumberKind", "NumberToken", "extract_numbers"]

NumberKind = Literal["money", "percent", "plain"]

_NUMBER = re.compile(
    r"""
    (?<![\w.$-])                # not inside a word, a decimal or another number
    (?<!Form\ )                 # "Form 1040" names a form
    (?<!Step\ )(?<!Steps\ )     # "Step 2", "Steps 3": Form W-4 steps (spec 014)
    (?<!\)\()                   # "401(a)(17)": a statute subsection
    (?P<sign>-)?
    (?P<dollar>\$)?
    (?P<whole>\d{1,3}(?:,\d{3})+|\d+)
    (?:\.(?P<cents>\d+))?
    (?P<percent>\s?%|\s+percent\b)?
    (?![\w(]|\.\d)              # not "401(k)", "3rd", or a longer number
    """,
    re.VERBOSE,
)


@dataclass(frozen=True)
class NumberToken:
    raw: str
    value: Decimal
    kind: NumberKind
    # Written with a decimal part ("$46.15", "6.0%").
    has_cents: bool


def extract_numbers(text: str) -> list[NumberToken]:
    tokens: list[NumberToken] = []
    for match in _NUMBER.finditer(text):
        digits = match["whole"].replace(",", "")
        if match["cents"] is not None:
            digits = f"{digits}.{match['cents']}"
        value = Decimal(digits)
        if match["sign"]:
            value = -value
        kind: NumberKind
        if match["dollar"]:
            kind = "money"
        elif match["percent"]:
            kind = "percent"
        else:
            kind = "plain"
        tokens.append(
            NumberToken(
                raw=match.group(0),
                value=value,
                kind=kind,
                has_cents=match["cents"] is not None,
            )
        )
    return tokens
