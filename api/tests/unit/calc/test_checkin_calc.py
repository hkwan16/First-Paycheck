"""calc/checkin.py: the money arithmetic behind check-in findings (spec 015 rules 1-6)."""

from __future__ import annotations

from decimal import Decimal

import pytest
from hypothesis import given
from hypothesis import strategies as st

from calc.checkin import GoalPace, change_cents, expected_deferral_cents, goal_pace
from calc.money import rate_pct


def test_expected_deferral_rounds_half_up() -> None:
    # Spec 015 finder row 1: 270,833 * 4% = 10,833.32.
    assert expected_deferral_cents(270_833, Decimal("4")) == 10_833
    # 0.5 cent rounds up: 50 * 1% = 0.5.
    assert expected_deferral_cents(50, Decimal("1")) == 1
    assert expected_deferral_cents(270_833, Decimal("0")) == 0


def test_rate_pct_has_two_places() -> None:
    assert rate_pct(5_417, 270_833) == Decimal("2.00")
    assert str(rate_pct(10_833, 270_833)) == "4.00"
    assert rate_pct(1, 3) == Decimal("33.33")


def test_rate_pct_needs_a_positive_whole() -> None:
    with pytest.raises(ValueError, match="positive"):
        rate_pct(1, 0)


def test_change_is_new_minus_old() -> None:
    assert change_cents(1_699, 1_549) == 150
    assert change_cents(999, 1_199) == -200


def test_goal_pace_off_pace() -> None:
    # Spec 015 finder row 5.
    assert goal_pace(200_000, 30_000, 3, 274_000) == GoalPace(
        expected_cents=290_000, shortfall_cents=16_000
    )


def test_goal_pace_ahead_has_a_negative_shortfall() -> None:
    assert goal_pace(200_000, 30_000, 3, 300_000).shortfall_cents == -10_000


def test_goal_pace_refuses_negative_months() -> None:
    with pytest.raises(ValueError, match="months"):
        goal_pace(0, 1, -1, 0)


@given(
    gross=st.integers(min_value=1, max_value=10**9),
    pct=st.decimals(min_value=0, max_value=100, places=2),
)
def test_expected_deferral_is_within_half_a_cent(gross: int, pct: Decimal) -> None:
    exact = Decimal(gross) * pct / 100
    assert abs(Decimal(expected_deferral_cents(gross, pct)) - exact) <= Decimal("0.5")
