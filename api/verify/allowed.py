"""The numbers an explanation may use (spec 008 rules 12-13).

Built from a decision's stored inputs and result (JSON, money in integer
cents, percentages as strings): every value under a key with a ``_cents`` part
in dollars, exactly and as whole dollars rounded half up; every value under a
``_pct`` or ``_rate`` part as a percentage; the tax year, the pay periods per
year and any other integer (``age``) as plain numbers.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from typing import Any

from calc.money import round_half_up
from verify.numbers import NumberToken

__all__ = ["AllowedNumbers"]

_HUNDRED = Decimal(100)
# "salary_cents", "employer_match_cents_full"; "employee_pct_upto", "marginal_rate_used".
_MONEY_KEY = re.compile(r"_cents(?:_|$)")
_PERCENT_KEY = re.compile(r"_(?:pct|rate)(?:_|$)")


def _decimal(value: Any) -> Decimal | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int | Decimal):
        return Decimal(value)
    if isinstance(value, str):
        try:
            return Decimal(value)
        except InvalidOperation:
            return None
    return None


@dataclass(frozen=True)
class AllowedNumbers:
    money_exact: frozenset[Decimal]
    money_whole: frozenset[Decimal]
    percents: frozenset[Decimal]
    plain: frozenset[Decimal]

    @classmethod
    def from_decision(cls, *documents: Mapping[str, Any]) -> AllowedNumbers:
        money: set[Decimal] = set()
        percents: set[Decimal] = set()
        plain: set[Decimal] = set()

        def walk(key: str, value: Any) -> None:
            if isinstance(value, Mapping):
                for child_key, child in value.items():
                    walk(str(child_key), child)
            elif isinstance(value, list):
                for item in value:
                    walk(key, item)
            elif _MONEY_KEY.search(key):
                number = _decimal(value)
                if number is not None:
                    # Tokens are matched by magnitude (rule 13), so values are too.
                    money.add(abs(number))
            elif _PERCENT_KEY.search(key):
                number = _decimal(value)
                if number is not None:
                    percents.add(number)
            elif isinstance(value, int) and not isinstance(value, bool):
                plain.add(Decimal(value))

        for document in documents:
            walk("", document)
        return cls(
            money_exact=frozenset(cents / _HUNDRED for cents in money),
            money_whole=frozenset(Decimal(round_half_up(cents / _HUNDRED)) for cents in money),
            percents=frozenset(percents),
            plain=frozenset(plain),
        )

    def allows(self, token: NumberToken) -> bool:
        if token.kind == "money":
            amount = abs(token.value)
            return amount in self.money_exact or (
                not token.has_cents and amount in self.money_whole
            )
        if token.kind == "percent":
            return token.value in self.percents
        return (
            token.value in self.plain
            or token.value in self.money_exact
            or (not token.has_cents and token.value in self.money_whole)
        )
