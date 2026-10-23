"""Merchant normalization, rule precedence and direction (spec 003, rules 1-6)."""

from __future__ import annotations

import pytest

from db.enums import RuleMatch, RuleSource
from sync.categories import CATEGORIES, INCOME_TRANSFER_CATEGORIES, is_money_in
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
    rule("sweetgreen", RuleMatch.PREFIX, "dining", RuleSource.SEED),
    rule("united airlines", RuleMatch.PREFIX, "travel", RuleSource.SEED),
    rule("zelle", RuleMatch.PREFIX, "transfer", RuleSource.SEED),
    rule("interest", RuleMatch.EXACT, "fees", RuleSource.SEED),
    rule("payroll", RuleMatch.CONTAINS, "income", RuleSource.SEED),
    rule("interest", RuleMatch.CONTAINS, "income", RuleSource.SEED),
]
USER = [
    rule("uber eats order", RuleMatch.EXACT, "groceries", RuleSource.USER),
    rule("uber", RuleMatch.PREFIX, "travel", RuleSource.USER),
]


# Spec 003, "Precedence": amounts in cents, positive is money out.
@pytest.mark.parametrize(
    ("merchant_norm", "amount_cents", "expected"),
    [
        ("uber eats order", 2_000, "groceries"),
        ("uber trip", 1_500, "travel"),
        ("netflix", 1_549, "subscriptions"),
        ("netflix.com", 1_549, None),
        ("ubereats", 1_800, None),
        ("", 100, None),
        ("uber eats order", -2_000, "groceries"),
        ("netflix", -1_549, "subscriptions"),
        # A refund keeps its spending category: no contains rule matches.
        ("united airlines", -50_000, "travel"),
        # A paycheck is income: seed contains ranks above seed prefix for money in.
        ("sweetgreen inc payroll ppd id", -81_000, "income"),
        ("sweetgreen inc payroll ppd id", 81_000, "dining"),
        ("sweetgreen", -1_450, "dining"),
        ("acme corp payroll", 5_000, None),
        ("interest", 10_788, "fees"),
        ("interest", -12, "income"),
        ("zelle to alex", 2_000, "transfer"),
        ("zelle to alex", -2_000, "transfer"),
        ("uber trip", 0, "travel"),
    ],
)
def test_precedence(merchant_norm: str, amount_cents: int, expected: str | None) -> None:
    book = RuleBook([*SEED, *USER])
    found = apply_rules(merchant_norm, book, amount_cents=amount_cents)
    assert (found.category if found else None) == expected


def test_a_money_in_paycheck_is_decided_by_the_seed_contains_rule() -> None:
    found = apply_rules(
        "sweetgreen inc payroll ppd id", RuleBook([*SEED, *USER]), amount_cents=-81_000
    )
    assert found == rule("payroll", RuleMatch.CONTAINS, "income", RuleSource.SEED)


@pytest.mark.parametrize(
    ("contains", "merchant_norm", "expected"),
    [
        # Two tokens beat one.
        (
            [("payroll", "income"), ("online transfer", "transfer")],
            "payroll online transfer",
            "transfer",
        ),
        # One token each: the one further left wins.
        ([("payroll", "income"), ("transfer", "transfer")], "payroll transfer", "income"),
        ([("payroll", "income"), ("transfer", "transfer")], "transfer payroll", "transfer"),
    ],
)
def test_contains_precedence(
    contains: list[tuple[str, str]], merchant_norm: str, expected: str
) -> None:
    book = RuleBook(rule(norm, RuleMatch.CONTAINS, cat, RuleSource.SEED) for norm, cat in contains)
    found = apply_rules(merchant_norm, book, amount_cents=-100)
    assert found is not None
    assert found.category == expected


@pytest.mark.parametrize(
    ("merchant_norm", "matches"),
    [
        ("payroll", True),
        ("payroll acme", True),
        ("acme payroll", True),
        ("acme payroll inc", True),
        ("payrolls inc", False),
        ("acme prepayroll", False),
        ("pay roll", False),
    ],
)
def test_contains_matches_whole_tokens_only(merchant_norm: str, matches: bool) -> None:
    book = RuleBook([rule("payroll", RuleMatch.CONTAINS, "income", RuleSource.SEED)])
    assert (apply_rules(merchant_norm, book, amount_cents=-100) is not None) is matches


def test_a_multi_token_contains_rule_matches_a_run_of_tokens() -> None:
    book = RuleBook([rule("ppd id", RuleMatch.CONTAINS, "income", RuleSource.SEED)])
    assert apply_rules("acme ppd id", book, amount_cents=-100) is not None
    assert apply_rules("acme ppd x id", book, amount_cents=-100) is None


def test_a_user_rule_beats_a_seed_contains_rule_for_money_in() -> None:
    book = RuleBook(
        [
            rule("sweetgreen inc payroll ppd id", RuleMatch.EXACT, "dining", RuleSource.USER),
            rule("payroll", RuleMatch.CONTAINS, "income", RuleSource.SEED),
        ]
    )
    for amount_cents in (-81_000, 1_200):
        found = apply_rules("sweetgreen inc payroll ppd id", book, amount_cents=amount_cents)
        assert found is not None
        assert (found.category, found.source) == ("dining", RuleSource.USER)


def test_a_user_income_rule_applies_both_ways() -> None:
    book = RuleBook([rule("acme corp", RuleMatch.EXACT, "income", RuleSource.USER)])
    for amount_cents in (-300_000, 300_000):
        found = apply_rules("acme corp", book, amount_cents=amount_cents)
        assert found is not None
        assert found.category == "income"


@pytest.mark.parametrize(
    ("contains", "message"),
    [
        (rule("payroll", RuleMatch.CONTAINS, "dining", RuleSource.SEED), "contains"),
        (rule("payroll", RuleMatch.CONTAINS, "income", RuleSource.USER), "contains"),
    ],
)
def test_rulebook_refuses_contains_outside_seed_income_and_transfer(
    contains: CategoryRule, message: str
) -> None:
    with pytest.raises(ValueError, match=message):
        RuleBook([contains])


def test_contains_categories_are_the_income_and_transfer_buckets() -> None:
    assert frozenset({"income", "transfer"}) == INCOME_TRANSFER_CATEGORIES
    assert is_money_in(-1)
    assert not is_money_in(0)
    assert not is_money_in(1)


@pytest.mark.parametrize(
    ("merchant_norm", "expected", "match"),
    [
        ("uber eats order", "dining", RuleMatch.EXACT),
        ("uber eats pickup", "dining", RuleMatch.PREFIX),
        ("uber trip", "transport", RuleMatch.PREFIX),
    ],
)
def test_precedence_without_user_rules(merchant_norm: str, expected: str, match: RuleMatch) -> None:
    found = apply_rules(merchant_norm, RuleBook(SEED), amount_cents=1_000)
    assert found is not None
    assert (found.category, found.match, found.source) == (expected, match, RuleSource.SEED)


def test_user_exact_rule_beats_a_longer_seed_prefix() -> None:
    book = RuleBook(
        [
            rule("corner deli", RuleMatch.EXACT, "groceries", RuleSource.USER),
            rule("corner", RuleMatch.PREFIX, "dining", RuleSource.SEED),
        ]
    )
    found = apply_rules("corner deli", book, amount_cents=1_000)
    assert found is not None
    assert found.category == "groceries"


def test_exact_rule_does_not_match_longer_merchants() -> None:
    book = RuleBook([rule("shell", RuleMatch.EXACT, "transport", RuleSource.SEED)])
    assert apply_rules("shell oil", book, amount_cents=1_000) is None
    assert apply_rules("shell", book, amount_cents=1_000) is not None


def test_rulebook_rejects_categories_outside_the_list() -> None:
    with pytest.raises(ValueError, match="category"):
        RuleBook([rule("x", RuleMatch.EXACT, "not_a_category", RuleSource.SEED)])


def test_categories_are_snake_case_and_unique() -> None:
    assert len(set(CATEGORIES)) == len(CATEGORIES)
    assert all(c.replace("_", "").isalpha() and c.islower() for c in CATEGORIES)
    assert "other" in CATEGORIES
