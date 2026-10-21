"""LLM call cost in microcents (spec 003 rule 26 and the cost table)."""

from __future__ import annotations

import pytest

from llm.cost import PRICES, UnknownModelPrice, cost_microcents, price_for


@pytest.mark.parametrize(
    ("model", "input_tokens", "output_tokens", "cache_read", "cache_write", "expected"),
    [
        ("claude-haiku-5-5", 1_000, 500, 0, 0, 35_000),
        ("claude-haiku-5-5", 200, 0, 2_000, 0, 4_000),
        ("claude-haiku-5-5", 0, 0, 0, 2_000, 25_000),
        ("claude-sonnet-5-5", 1_234, 567, 0, 0, 813_800),
        ("claude-haiku-5-5", 3, 0, 0, 0, 30),
    ],
)
def test_cost_microcents(
    model: str,
    input_tokens: int,
    output_tokens: int,
    cache_read: int,
    cache_write: int,
    expected: int,
) -> None:
    cost = cost_microcents(
        model,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        cache_read_tokens=cache_read,
        cache_write_tokens=cache_write,
    )
    assert cost == expected
    assert isinstance(cost, int)


def test_fractions_of_a_microcent_round_half_up() -> None:
    # One cache-write token on Haiku: 0.125 * 100 = 12.5 microcents, a tie.
    assert cost_microcents("claude-haiku-5-5", cache_write_tokens=1) == 13
    assert cost_microcents("claude-haiku-5-5", cache_read_tokens=1) == 1


def test_unknown_models_raise() -> None:
    with pytest.raises(UnknownModelPrice, match="claude-unknown"):
        price_for("claude-unknown")
    with pytest.raises(UnknownModelPrice):
        cost_microcents("claude-unknown", input_tokens=1)


def test_negative_token_counts_are_refused() -> None:
    with pytest.raises(ValueError, match="negative"):
        cost_microcents("claude-haiku-5-5", input_tokens=-1)


def test_every_configured_default_model_has_a_price() -> None:
    from app.config import Settings

    settings = Settings(_env_file=None)
    for model in (
        settings.llm_model_extract,
        settings.llm_model_categorize,
        settings.llm_model_explain,
    ):
        assert model in PRICES
