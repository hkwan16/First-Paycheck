"""calc/recurring.py: the amount arithmetic of recurring detection (spec 009 rules 5, 7, 12)."""

from __future__ import annotations

import pytest
from hypothesis import given
from hypothesis import strategies as st

from calc.recurring import median_cents, moved_more_than, within_pct


@pytest.mark.parametrize(
    ("values", "median"),
    [
        ([1549], 1549),
        ([13900, 13900], 13900),
        ([8200, 9100, 8700, 25000, 8900], 8900),
        # Spec 009 example 8: (540 + 633) / 2 = 586.5, half up to 587.
        ([540, 633, 540, 633, 540, 633], 587),
        ([1549, 1549, 1549, 1549, 1699, 1699], 1549),
        ([1, 2], 2),
        ([100, 101, 102, 103], 102),
    ],
)
def test_median_cents(values: list[int], median: int) -> None:
    assert median_cents(values) == median


def test_median_of_nothing_raises() -> None:
    with pytest.raises(ValueError, match="empty"):
        median_cents([])


@given(st.lists(st.integers(min_value=1, max_value=10**9), min_size=1, max_size=40))
def test_median_lies_between_min_and_max(values: list[int]) -> None:
    assert min(values) <= median_cents(values) <= max(values)


@given(st.lists(st.integers(min_value=1, max_value=10**9), min_size=1, max_size=40))
def test_median_ignores_order(values: list[int]) -> None:
    assert median_cents(values) == median_cents(list(reversed(values)))


@pytest.mark.parametrize(
    ("amount", "reference", "inside"),
    [
        (8200, 8900, True),  # 100 * 700 = 70000 <= 133500
        (25000, 8900, False),
        (10235, 8900, True),  # 100 * 1335 = 133500, exactly 15%
        (10236, 8900, False),
        (7565, 8900, True),
        (7564, 8900, False),
    ],
)
def test_within_fifteen_pct(amount: int, reference: int, inside: bool) -> None:
    assert within_pct(amount, reference, 15) is inside


@pytest.mark.parametrize(
    ("new", "old", "moved"),
    [
        (1699, 1549, True),  # 100 * 150 = 15000 > 7745
        (1599, 1549, False),  # 100 * 50 = 5000 <= 7745
        (1549, 1549, False),
        (2100, 2000, False),  # exactly 5% is not more than 5%
        (2101, 2000, True),
        (1899, 2000, True),
    ],
)
def test_moved_more_than_five_pct(new: int, old: int, moved: bool) -> None:
    assert moved_more_than(new, old, 5) is moved


def test_reference_must_be_positive() -> None:
    with pytest.raises(ValueError, match="positive"):
        within_pct(1, 0, 15)
    with pytest.raises(ValueError, match="positive"):
        moved_more_than(1, 0, 5)
