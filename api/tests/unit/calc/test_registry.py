"""calc/registry.py: the calculators POST /decisions can recompute (spec 007 rule 1)."""

from __future__ import annotations

import pytest

from calc.emergency_fund import EmergencyFundInput, EmergencyFundResult, emergency_fund
from calc.health_plans import HealthPlansInput, HealthPlansResult, health_plans
from calc.k401 import K401MatchInput, K401MatchResult, k401_match
from calc.registry import CALCULATORS, UnknownCalculator, calculator
from calc.w4 import W4Input, W4Result, w4
from db.enums import CalculatorKind


def test_every_registered_name_is_a_calculator_kind() -> None:
    assert set(CALCULATORS) <= {kind.value for kind in CalculatorKind}


def test_k401_is_registered() -> None:
    entry = calculator("k401_match")
    assert entry.input_model is K401MatchInput
    assert entry.result_model is K401MatchResult
    assert entry.run is k401_match


def test_every_calculator_kind_is_registered() -> None:
    """Spec 014 registers the last kind, so every saved decision can be recomputed."""
    assert set(CALCULATORS) == {kind.value for kind in CalculatorKind}


def test_unregistered_calculator() -> None:
    with pytest.raises(UnknownCalculator, match="pension"):
        calculator("pension")


@pytest.mark.parametrize(
    ("name", "input_model", "result_model", "run"),
    [
        ("emergency_fund", EmergencyFundInput, EmergencyFundResult, emergency_fund),
        ("health_plans", HealthPlansInput, HealthPlansResult, health_plans),
        ("w4", W4Input, W4Result, w4),
    ],
)
def test_later_calculators_are_registered(
    name: str, input_model: type, result_model: type, run: object
) -> None:
    entry = calculator(name)
    assert (entry.input_model, entry.result_model, entry.run) == (input_model, result_model, run)
