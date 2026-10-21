"""Merchant normalization and rule precedence (spec 003, rules 1-6)."""

from __future__ import annotations

import pytest

from db.enums import RuleMatch, RuleSource
from sync.categories import CATEGORIES
from sync.categorize import CategoryRule, RuleBook, apply_rules, normalize_merchant, token_prefixes


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("NETFLIX.COM #1234", "netflix.com"),
        ("STARBUCKS STORE 05721 SEATTLE WA", "starbucks store seattle wa"),
        ("SQ *BLUE BOTTLE COFFEE 12", "blue bottle coffee"),
        ("McDonald's F12345", "mcdonalds"),
        ("Uber 063015 SF**POOL**", "uber sf pool"),
        ("TST* Joe's Diner", "joes diner"),
        ("AMZN Mktp US*2K39H1", "amzn mktp us"),
        ("   Café  Rouge  ", "café rouge"),
        ("#1234", ""),
        ("SQ", "sq"),
        ("", ""),
        ("Trader Joe\N{RIGHT SINGLE QUOTATION MARK}s #552", "trader joes"),
        ("AT&T *PAYMENT", "at&t payment"),
        ("...INC.", "inc"),
        ("POS SQ *VERVE", "verve"),
    ],
)
def test_normalize_merchant(raw: str, expected: str) -> None:
    assert normalize_merchant(raw) == expected


def test_normalize_merchant_is_idempotent() -> None:
    for raw in ("NETFLIX.COM #1234", "SQ *BLUE BOTTLE", "McDonald's F12345", "POS SQ *VERVE"):
        once = normalize_merchant(raw)
        assert normalize_merchant(once) == once


def test_normalize_merchant_caps_the_length() -> None:
    assert len(normalize_merchant("word " * 100)) <= 128
    assert not normalize_merchant("word " * 100).endswith(" ")


def test_token_prefixes_longest_first() -> None:
    assert list(token_prefixes("uber eats order")) == ["uber eats order", "uber eats", "uber"]
    assert list(token_prefixes("")) == []


def rule(norm: str, match: RuleMatch, category: str, source: RuleSource) -> CategoryRule:
    return CategoryRule(merchant_norm=norm, match=match, category=category, source=source)


SEED = [
    rule("uber eats order", RuleMatch.EXACT, "dining", RuleSource.SEED),
    rule("uber", RuleMatch.PREFIX, "transport", RuleSource.SEED),
    rule("uber eats", RuleMatch.PREFIX, "dining", RuleSource.SEED),
    rule("netflix", RuleMatch.PREFIX, "subscriptions", RuleSource.SEED),
]
USER = [
    rule("uber eats order", RuleMatch.EXACT, "groceries", RuleSource.USER),
    rule("uber", RuleMatch.PREFIX, "travel", RuleSource.USER),
]


@pytest.mark.parametrize(
    ("merchant_norm", "expected"),
    [
        ("uber eats order", "groceries"),
        ("uber trip", "travel"),
        ("netflix", "subscriptions"),
        ("netflix.com", None),
        ("ubereats", None),
        ("", None),
    ],
)
def test_precedence(merchant_norm: str, expected: str | None) -> None:
    book = RuleBook([*SEED, *USER])
    found = apply_rules(merchant_norm, book)
    assert (found.category if found else None) == expected


@pytest.mark.parametrize(
    ("merchant_norm", "expected", "match"),
    [
        ("uber eats order", "dining", RuleMatch.EXACT),
        ("uber eats pickup", "dining", RuleMatch.PREFIX),
        ("uber trip", "transport", RuleMatch.PREFIX),
    ],
)
def test_precedence_without_user_rules(merchant_norm: str, expected: str, match: RuleMatch) -> None:
    found = apply_rules(merchant_norm, RuleBook(SEED))
    assert found is not None
    assert (found.category, found.match, found.source) == (expected, match, RuleSource.SEED)


def test_user_exact_rule_beats_a_longer_seed_prefix() -> None:
    book = RuleBook(
        [
            rule("corner deli", RuleMatch.EXACT, "groceries", RuleSource.USER),
            rule("corner", RuleMatch.PREFIX, "dining", RuleSource.SEED),
        ]
    )
    found = apply_rules("corner deli", book)
    assert found is not None
    assert found.category == "groceries"


def test_exact_rule_does_not_match_longer_merchants() -> None:
    book = RuleBook([rule("shell", RuleMatch.EXACT, "transport", RuleSource.SEED)])
    assert apply_rules("shell oil", book) is None
    assert apply_rules("shell", book) is not None


def test_rulebook_rejects_categories_outside_the_list() -> None:
    with pytest.raises(ValueError, match="category"):
        RuleBook([rule("x", RuleMatch.EXACT, "not_a_category", RuleSource.SEED)])


def test_categories_are_snake_case_and_unique() -> None:
    assert len(set(CATEGORIES)) == len(CATEGORIES)
    assert all(c.replace("_", "").isalpha() and c.islower() for c in CATEGORIES)
    assert "other" in CATEGORIES
