"""calc/data/pub15t_2026.json: the Pub 15-T (2026) percentage method tables (spec 014).

The tables are pinned to the figures the spec quotes, and checked row by row
against the Rev. Proc. 2025-32 brackets and standard deductions they are built
from, so a typo in either file fails here.
"""

from __future__ import annotations

import json
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path
from typing import Any

import pytest
from pydantic import ValidationError

from calc.data import (
    FILING_STATUSES,
    FilingStatus,
    Pub15T,
    UnknownTaxYear,
    pub15t,
    tax_year,
)

DATA = Path(__file__).resolve().parents[3] / "calc" / "data" / "pub15t_2026.json"


def test_2026_line_1g_and_source() -> None:
    tables = pub15t(2026)
    assert tables.tax_year == 2026
    assert tables.worksheet_1g_cents == {
        "single": 860_000,
        "married_filing_jointly": 1_290_000,
        "head_of_household": 860_000,
    }
    assert "Publication 15-T (2026)" in tables.source
    assert tables.url == "https://www.irs.gov/pub/irs-pdf/p15t.pdf"


def test_2026_single_rows_as_printed() -> None:
    """Spot-check the rows spec 014's examples use, in dollars as Pub 15-T prints them."""
    rows = pub15t(2026).standard["single"]
    standard = [(r.at_least_cents, r.base_cents, r.rate_pct) for r in rows]
    assert standard[2] == (1_990_000, 124_000, Decimal(12))
    assert standard[5] == (20_927_500, 4_102_400, Decimal(32))
    assert standard[7] == (64_810_000, 19_297_925, Decimal(37))
    checkbox = pub15t(2026).step2_checkbox["single"]
    assert (checkbox[7].at_least_cents, checkbox[7].base_cents) == (32_835_000, 9_648_963)


def _tax_cents(status: FilingStatus, taxable: int) -> Decimal:
    """Exact progressive tax on ``taxable`` cents from the 2026 brackets."""
    total = Decimal(0)
    lower = 0
    for bracket in tax_year(2026).brackets.by_status[status]:
        upper = taxable if bracket.up_to_cents is None else min(taxable, bracket.up_to_cents)
        if upper > lower:
            total += Decimal(upper - lower) * bracket.rate_pct / 100
        if bracket.up_to_cents is None or taxable <= bracket.up_to_cents:
            break
        lower = bracket.up_to_cents
    return total


def _half_up(value: Decimal, places: Decimal) -> Decimal:
    return value.quantize(places, rounding=ROUND_HALF_UP)


@pytest.mark.parametrize("status", FILING_STATUSES)
def test_tables_are_built_from_the_2026_brackets(status: FilingStatus) -> None:
    """Spec 014, 2026 constants: standard rows start at standard deduction - 1g +
    bracket bound; checkbox rows at half of standard deduction + bound, rounded to
    whole dollars; column C is the tax on the bound (halved and rounded to cents)."""
    data = tax_year(2026)
    tables = pub15t(2026)
    deduction = data.standard_deduction.cents[status]
    line_1g = tables.worksheet_1g_cents[status]
    bounds = [0] + [b.up_to_cents for b in data.brackets.by_status[status] if b.up_to_cents]
    rates = [b.rate_pct for b in data.brackets.by_status[status]]
    standard = tables.standard[status]
    checkbox = tables.step2_checkbox[status]
    assert len(standard) == len(checkbox) == len(bounds) + 1
    assert (standard[0].at_least_cents, standard[0].rate_pct) == (0, Decimal(0))
    assert (checkbox[0].at_least_cents, checkbox[0].rate_pct) == (0, Decimal(0))
    for index, bound in enumerate(bounds, start=1):
        tax = _tax_cents(status, bound)
        assert standard[index].rate_pct == rates[index - 1]
        assert checkbox[index].rate_pct == rates[index - 1]
        assert standard[index].at_least_cents == deduction - line_1g + bound
        assert standard[index].base_cents == tax
        half_start = _half_up(Decimal(deduction + bound) / 200, Decimal(1)) * 100
        assert checkbox[index].at_least_cents == half_start
        assert checkbox[index].base_cents == _half_up(tax / 2, Decimal(1))


def test_unknown_year() -> None:
    with pytest.raises(UnknownTaxYear, match="2027"):
        pub15t(2027)


def _document() -> dict[str, Any]:
    return json.loads(DATA.read_text())


def test_rows_must_start_at_zero_and_ascend() -> None:
    document = _document()
    document["standard"]["single"][0]["at_least_cents"] = 100
    with pytest.raises(ValidationError, match="start at 0"):
        Pub15T.model_validate(document)
    document = _document()
    rows = document["step2_checkbox"]["head_of_household"]
    rows[2]["at_least_cents"] = rows[1]["at_least_cents"]
    with pytest.raises(ValidationError, match="ascend"):
        Pub15T.model_validate(document)


def test_every_filing_status_needs_a_table() -> None:
    document = _document()
    del document["standard"]["head_of_household"]
    with pytest.raises(ValidationError, match="filing status"):
        Pub15T.model_validate(document)
