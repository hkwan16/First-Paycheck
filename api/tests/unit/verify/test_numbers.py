"""verify/numbers.py: every number in an explanation, with its kind (spec 008 rule 11)."""

from __future__ import annotations

from decimal import Decimal

import pytest

from verify.numbers import extract_numbers


def values(text: str) -> list[tuple[Decimal, str]]:
    return [(token.value, token.kind) for token in extract_numbers(text)]


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("You miss $1,234.56 a year.", [(Decimal("1234.56"), "money")]),
        ("That is 1234 dollars.", [(Decimal(1234), "plain")]),
        ("Contribute 6% or 6.0%.", [(Decimal(6), "percent"), (Decimal("6.0"), "percent")]),
        ("Take-home drops -$12.", [(Decimal(-12), "money")]),
        ("Your 401(k) and W-4 under 402(g)", []),
        (
            "In 2026, 26 paychecks of $46.15",
            [(Decimal(2026), "plain"), (Decimal(26), "plain"), (Decimal("46.15"), "money")],
        ),
        ("5 percent of pay", [(Decimal(5), "percent")]),
        ("A 12 % rate", [(Decimal(12), "percent")]),
        ("Code 414(v) and 401(a)(17) apply", []),
        ("See Form 1040 and the k401 key, 3rd paycheck", []),
        ("$60,000 salary, $2,400 match.", [(Decimal(60000), "money"), (Decimal(2400), "money")]),
        ("$46.15.", [(Decimal("46.15"), "money")]),
        ("No numbers here.", []),
    ],
)
def test_extract_numbers(text: str, expected: list[tuple[Decimal, str]]) -> None:
    assert values(text) == expected


def test_tokens_keep_the_raw_text() -> None:
    [money, percent] = extract_numbers("Save $1,800.00 at 3%")
    assert money.raw == "$1,800.00"
    assert money.has_cents is True
    assert percent.raw == "3%"
    assert percent.has_cents is False


def test_whole_dollars_have_no_cents() -> None:
    [token] = extract_numbers("about $41 after tax")
    assert token.has_cents is False
    assert token.value == Decimal(41)
