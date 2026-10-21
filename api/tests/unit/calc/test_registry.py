"""calc/registry.py: the calculators POST /decisions can recompute (spec 007 rule 1)."""

from __future__ import annotations

import pytest

from calc.k401 import K401MatchInput, K401MatchResult, k401_match
from calc.registry import CALCULATORS, UnknownCalculator, calculator
from db.enums import CalculatorKind


def test_every_registered_name_is_a_calculator_kind() -> None:
    assert set(CALCULATORS) <= {kind.value for kind in CalculatorKind}


def test_k401_is_registered() -> None:
    entry = calculator("k401_match")
    assert entry.input_model is K401MatchInput
    assert entry.result_model is K401MatchResult
    assert entry.run is k401_match


def test_unregistered_calculator() -> None:
    with pytest.raises(UnknownCalculator, match="w4"):
        calculator("w4")
