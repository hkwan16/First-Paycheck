"""calc/data/2026.json: every constant pinned to spec 006's verified values."""

from __future__ import annotations

from decimal import Decimal

import pytest

from calc.data import FilingStatus, UnknownTaxYear, available_years, tax_year


def test_2026_is_available() -> None:
    assert 2026 in available_years()


def test_2026_retirement_limits() -> None:
    data = tax_year(2026)
    assert data.tax_year == 2026
    assert data.k401.elective_deferral_limit_cents == 2_450_000
    assert data.k401.catch_up_50_cents == 800_000
    assert data.k401.catch_up_60_63_cents == 1_125_000
    assert data.k401.compensation_limit_cents == 36_000_000
    assert "Notice 2025-67" in data.k401.source
    assert data.k401.url == "https://www.irs.gov/pub/irs-drop/n-25-67.pdf"


def test_2026_hsa_and_hdhp_limits() -> None:
    """Spec 012: Rev. Proc. 2025-19, section 2.01."""
    hsa = tax_year(2026).hsa
    assert (hsa.self_only_limit_cents, hsa.family_limit_cents) == (440_000, 875_000)
    assert (hsa.hdhp_min_deductible_self_cents, hsa.hdhp_min_deductible_family_cents) == (
        170_000,
        340_000,
    )
    assert (hsa.hdhp_max_oop_self_cents, hsa.hdhp_max_oop_family_cents) == (850_000, 1_700_000)
    assert "Rev. Proc. 2025-19" in hsa.source
    assert hsa.url == "https://www.irs.gov/pub/irs-drop/rp-25-19.pdf"


def test_2026_standard_deductions() -> None:
    data = tax_year(2026)
    assert data.standard_deduction.cents == {
        "single": 1_610_000,
        "married_filing_jointly": 3_220_000,
        "head_of_household": 2_415_000,
    }
    assert "Rev. Proc. 2025-32" in data.standard_deduction.source


# (rate in percent points, upper bound in cents or None for the top bracket)
SINGLE = [
    ("10", 1_240_000),
    ("12", 5_040_000),
    ("22", 10_570_000),
    ("24", 20_177_500),
    ("32", 25_622_500),
    ("35", 64_060_000),
    ("37", None),
]
MARRIED_FILING_JOINTLY = [
    ("10", 2_480_000),
    ("12", 10_080_000),
    ("22", 21_140_000),
    ("24", 40_355_000),
    ("32", 51_245_000),
    ("35", 76_870_000),
    ("37", None),
]
HEAD_OF_HOUSEHOLD = [
    ("10", 1_770_000),
    ("12", 6_745_000),
    ("22", 10_570_000),
    ("24", 20_175_000),
    ("32", 25_620_000),
    ("35", 64_060_000),
    ("37", None),
]


@pytest.mark.parametrize(
    ("status", "expected"),
    [
        ("single", SINGLE),
        ("married_filing_jointly", MARRIED_FILING_JOINTLY),
        ("head_of_household", HEAD_OF_HOUSEHOLD),
    ],
)
def test_2026_brackets(status: FilingStatus, expected: list[tuple[str, int | None]]) -> None:
    brackets = tax_year(2026).brackets.by_status[status]
    assert [(bracket.rate_pct, bracket.up_to_cents) for bracket in brackets] == [
        (Decimal(rate), bound) for rate, bound in expected
    ]
    assert "Rev. Proc. 2025-32" in tax_year(2026).brackets.source


def test_unknown_year_names_the_year() -> None:
    with pytest.raises(UnknownTaxYear, match="2027"):
        tax_year(2027)


def test_tax_year_is_cached() -> None:
    assert tax_year(2026) is tax_year(2026)
