"""What an LLM call cost, in microcents (millionths of a cent; spec 003 rule 26).

Prices are Anthropic's list prices in US dollars per million tokens for prompts
up to 100K tokens. Cache writes are 1.25x input (5-minute TTL); cache reads are
0.1x input. ``tokens * dollars_per_million`` is micro-dollars, and one
micro-dollar is 100 microcents.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal

__all__ = ["PRICES", "Price", "UnknownModelPrice", "cost_microcents", "price_for"]


@dataclass(frozen=True)
class Price:
    input: Decimal
    output: Decimal
    cache_read: Decimal
    cache_write: Decimal


PRICES: dict[str, Price] = {
    # No purpose runs on Haiku since #136; its price stays because earlier
    # llm_calls rows name it and spec 003's cost examples check its arithmetic.
    "claude-haiku-5-5": Price(
        input=Decimal("0.10"),
        output=Decimal("0.50"),
        cache_read=Decimal("0.01"),
        cache_write=Decimal("0.125"),
    ),
    "claude-sonnet-5-5": Price(
        input=Decimal("2.00"),
        output=Decimal("10.00"),
        cache_read=Decimal("0.20"),
        cache_write=Decimal("2.50"),
    ),
}

_MICROCENTS_PER_MICRODOLLAR = 100


class UnknownModelPrice(LookupError):
    """A model with no entry in ``PRICES``; add its price before using it."""


def price_for(model: str) -> Price:
    try:
        return PRICES[model]
    except KeyError:
        raise UnknownModelPrice(f"no price for model {model!r} in llm/cost.py") from None


def cost_microcents(
    model: str,
    *,
    input_tokens: int = 0,
    output_tokens: int = 0,
    cache_read_tokens: int = 0,
    cache_write_tokens: int = 0,
) -> int:
    """``input_tokens`` here are uncached input only; cache writes are separate."""
    counts = (input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
    if any(count < 0 for count in counts):
        raise ValueError("token counts cannot be negative")
    price = price_for(model)
    microdollars = (
        input_tokens * price.input
        + output_tokens * price.output
        + cache_read_tokens * price.cache_read
        + cache_write_tokens * price.cache_write
    )
    microcents = microdollars * _MICROCENTS_PER_MICRODOLLAR
    return int(microcents.quantize(Decimal(1), rounding=ROUND_HALF_UP))
