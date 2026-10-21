"""calc/money.py: half-up rounding to whole cents and exact percentage helpers."""

from __future__ import annotations

import ast
from decimal import Decimal

import pytest

from app.config import REPO_ROOT
from calc.money import pct_of, per_period, round_half_up

CALC = REPO_ROOT / "api" / "calc"


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (Decimal("0.5"), 1),
        (Decimal("1.5"), 2),
        (Decimal("2.5"), 3),
        (Decimal("2.4999"), 2),
        (Decimal("203055.525"), 203056),
        (Decimal("-0.5"), -1),
        (Decimal("-1.4"), -1),
        (Decimal(7), 7),
    ],
)
def test_round_half_up_rounds_ties_away_from_zero(value: Decimal, expected: int) -> None:
    assert round_half_up(value) == expected
    assert type(round_half_up(value)) is int


def test_round_half_up_rejects_floats() -> None:
    with pytest.raises(TypeError, match="Decimal"):
        round_half_up(0.5)  # type: ignore[arg-type]  # the point of the test


def test_pct_of_is_exact() -> None:
    assert pct_of(4_512_345, Decimal("4.5")) == Decimal("203055.525")
    assert pct_of(Decimal("135370.35"), Decimal("50")) == Decimal("67685.175")
    assert pct_of(0, Decimal("12.34")) == 0


def test_per_period_divides_without_rounding() -> None:
    assert per_period(Decimal(120_000), 26) * 26 == Decimal(120_000)
    assert round_half_up(per_period(Decimal(120_000), 26)) == 4_615
    assert per_period(Decimal(156_000), 24) == Decimal(6_500)


def test_per_period_rejects_non_positive_periods() -> None:
    with pytest.raises(ValueError, match="positive"):
        per_period(Decimal(1), 0)


def test_no_float_in_calc() -> None:
    """Money math never touches binary floating point: no float literals, no
    ``float(...)`` calls and no ``float`` annotations anywhere in ``calc/``."""
    offenders: list[str] = []
    for path in sorted(CALC.rglob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, ast.Constant) and isinstance(node.value, float):
                offenders.append(f"{path.name}:{node.lineno} float literal {node.value!r}")
            elif isinstance(node, ast.Name) and node.id == "float":
                offenders.append(f"{path.name}:{node.lineno} uses float")
    assert offenders == []
