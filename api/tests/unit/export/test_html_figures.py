"""How the PDF writes a plan figure (spec 016 rules 3 and 11, spec 012 rule 17)."""

from __future__ import annotations

import pytest

from app.plan import FigureKind, PlanFigure
from export.html import figure_value


def figure(kind: FigureKind, value: int | str | None) -> PlanFigure:
    return PlanFigure(key="result.x", label="X", kind=kind, value=value)


@pytest.mark.parametrize(
    ("value", "text"),
    [
        (181_000, "$1,810.00"),
        (0, "$0.00"),
        (-40_300, "$403.00 ahead"),
    ],
)
def test_a_net_cost_figure_reads_as_coming_out_ahead(value: int, text: str) -> None:
    assert figure_value(figure("net_cost", value)) == text


def test_a_money_figure_keeps_its_sign() -> None:
    assert figure_value(figure("money", -12_345)) == "-$123.45"


def test_a_net_cost_figure_must_be_cents() -> None:
    with pytest.raises(ValueError, match="net_cost"):
        figure_value(figure("net_cost", "12"))
