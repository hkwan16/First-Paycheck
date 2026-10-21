"""The calculators a saved decision can be recomputed with (spec 007 rule 1).

Keys are ``calculator_kind`` values (``db.enums.CalculatorKind``; a test keeps
them in step). ``POST /decisions`` validates the inputs with ``input_model``,
reruns ``run`` and compares its result with the one the client sent.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any

from pydantic import BaseModel

from calc.k401 import K401MatchInput, K401MatchResult, k401_match

__all__ = ["CALCULATORS", "Calculator", "UnknownCalculator", "calculator"]


class UnknownCalculator(KeyError):
    """No calculator is registered under this name yet."""


@dataclass(frozen=True)
class Calculator:
    input_model: type[BaseModel]
    result_model: type[BaseModel]
    run: Callable[[Any], BaseModel]


CALCULATORS: Mapping[str, Calculator] = {
    "k401_match": Calculator(
        input_model=K401MatchInput, result_model=K401MatchResult, run=k401_match
    ),
}


def calculator(name: str) -> Calculator:
    try:
        return CALCULATORS[name]
    except KeyError:
        raise UnknownCalculator(f"no calculator is available for {name!r} yet") from None
