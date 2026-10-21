"""Spec 013 rule 8: a summary's printed bands become cumulative match tiers."""

from __future__ import annotations

from decimal import Decimal

import pytest

from calc.k401 import MatchTier, tiers_from_bands

D = Decimal


def tiers(*pairs: tuple[str, str]) -> list[MatchTier]:
    return [MatchTier(employee_pct_upto=D(upto), employer_pct=D(share)) for upto, share in pairs]


def test_first_three_then_next_two() -> None:
    assert tiers_from_bands([(D(3), D(100)), (D(2), D(50))]) == tiers(("3", "100"), ("5", "50"))


def test_single_band() -> None:
    assert tiers_from_bands([(D(6), D(50))]) == tiers(("6", "50"))


def test_fractional_bands() -> None:
    result = tiers_from_bands([(D("1.5"), D(100)), (D("2.25"), D(50))])
    assert result == tiers(("1.50", "100"), ("3.75", "50"))
    assert str(result[1].employee_pct_upto) == "3.75"


def test_no_bands() -> None:
    assert tiers_from_bands([]) == []


@pytest.mark.parametrize(
    ("bands", "message"),
    [
        ([(D(0), D(100))], "a match band must be positive"),
        ([(D(60), D(100)), (D(50), D(50))], "less than or equal to 100"),
        ([(D(3), D(0))], "greater than 0"),
    ],
    ids=["zero_band", "over_100_pct", "zero_share"],
)
def test_bands_that_make_no_valid_tier_are_refused(
    bands: list[tuple[Decimal, Decimal]], message: str
) -> None:
    with pytest.raises(ValueError, match=message):
        tiers_from_bands(bands)
