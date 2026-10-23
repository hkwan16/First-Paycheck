"""The committed category seed file (spec 003): every row is valid and normalized."""

from __future__ import annotations

from collections import Counter
from pathlib import Path

import pytest

from db.enums import RuleMatch
from db.seed.load import SEED_CSV, SeedError, read_seed_rules
from sync.categories import CATEGORIES
from sync.categorize import RuleBook, apply_rules, normalize_merchant


def test_seed_file_has_about_250_valid_rows() -> None:
    rules = read_seed_rules()
    assert 230 <= len(rules) <= 300
    for rule in rules:
        assert rule.merchant_norm == normalize_merchant(rule.merchant_norm), rule
        assert rule.category in CATEGORIES
    keys = Counter((rule.merchant_norm, rule.match) for rule in rules)
    assert [key for key, n in keys.items() if n > 1] == []


@pytest.mark.parametrize(
    "category",
    [
        "groceries",
        "utilities",
        "housing",
        "transport",
        "subscriptions",
        "insurance",
        "phone_internet",
        "income",
        "transfer",
    ],
)
def test_seed_covers_the_core_categories(category: str) -> None:
    assert sum(rule.category == category for rule in read_seed_rules()) >= 5


# Amounts in cents, positive is money out (spec 001 rule 21).
@pytest.mark.parametrize(
    ("raw", "amount_cents", "category"),
    [
        ("NETFLIX.COM #1234", 1_549, "subscriptions"),
        ("WHOLEFDS MKT 10234", 4_500, "groceries"),
        ("Uber 063015 SF**POOL**", 540, "transport"),
        ("UBER EATS 8005928996", 2_300, "dining"),
        ("ADP PAYROLL 102326", -250_000, "income"),
        ("ACH Electronic CreditGUSTO PAY 123456", -585_000, "income"),
        # The Plaid sandbox books GUSTO PAY as money out: an income rule applies both ways.
        ("ACH Electronic CreditGUSTO PAY 123456", 585_000, "income"),
        ("COMCAST CABLE 800-266-2278", 7_000, "phone_internet"),
        ("PG&E WEB ONLINE", 9_000, "utilities"),
        ("GEICO *AUTO", 12_000, "insurance"),
        ("ZELLE TO JOHN", 2_000, "transfer"),
        ("CREDIT CARD 3333 PAYMENT *//", 2_500, "transfer"),
        ("BILT RENT 12/01", 200_000, "housing"),
        ("CLIPPER SERVICE", 2_000, "transport"),
        ("COSTCO GAS #0123", 4_000, "transport"),
        ("COSTCO WHSE #0123", 12_000, "shopping"),
        ("United Airlines", 50_000, "travel"),
        ("McDonald's", 1_200, "dining"),
        # Spec 003 rule 3b: a paycheck from an employer named like a merchant.
        ("Sweetgreen inc payroll ppd id", -81_000, "income"),
        ("SWEETGREEN #0412", 1_450, "dining"),
        ("STARBUCKS CORP DIRECT DEP", -254_300, "income"),
        ("ACME CORP SALARY", -300_000, "income"),
        # Spec 003 rule 5a: generic bank descriptors.
        ("Monthly payment", -31_195, "transfer"),
        ("Payment", -31_195, "transfer"),
        ("Interest charged", 10_788, "fees"),
        ("Interest", 11_147, "fees"),
        ("Interest", -12, "income"),
        ("Interest payment", -12, "income"),
        ("CASH DEPOSIT", -49_600, "transfer"),
    ],
)
def test_seed_rules_label_common_descriptors(raw: str, amount_cents: int, category: str) -> None:
    found = apply_rules(
        normalize_merchant(raw), RuleBook(read_seed_rules()), amount_cents=amount_cents
    )
    assert found is not None, raw
    assert found.category == category


@pytest.mark.parametrize(
    ("raw", "amount_cents", "category"),
    [
        # Refunds keep their merchant's category: no contains word matches (spec 003 rule 4).
        ("United Airlines", -50_000, "travel"),
        ("AMZN Mktp US*2K39H1", -2_599, "shopping"),
        ("Sweetgreen", -1_450, "dining"),
    ],
)
def test_seed_rules_label_a_refund_with_its_merchants_category(
    raw: str, amount_cents: int, category: str
) -> None:
    found = apply_rules(
        normalize_merchant(raw), RuleBook(read_seed_rules()), amount_cents=amount_cents
    )
    assert found is not None, raw
    assert found.category == category


def test_seed_contains_rows_are_the_income_markers() -> None:
    contains = {
        rule.merchant_norm: rule.category
        for rule in read_seed_rules()
        if rule.match is RuleMatch.CONTAINS
    }
    assert contains == {
        "payroll": "income",
        "ppd id": "income",
        "direct dep": "income",
        "direct deposit": "income",
        "salary": "income",
        "interest": "income",
    }


def write(tmp_path: Path, body: str) -> Path:
    path = tmp_path / "rules.csv"
    path.write_text("merchant_norm,match,category\n" + body)
    return path


@pytest.mark.parametrize(
    ("body", "message"),
    [
        ("Netflix,prefix,subscriptions\n", "normalized"),
        ("netflix,fuzzy,subscriptions\n", "match"),
        ("netflix,prefix,streaming\n", "category"),
        ("netflix,prefix,subscriptions\nnetflix,prefix,entertainment\n", "duplicate"),
        (",exact,other\n", "empty"),
        # Spec 003 rule 3c: contains is for income and transfer only.
        ("payroll,contains,dining\n", "contains"),
        ("payroll,contains,savings_investment\n", "contains"),
    ],
)
def test_invalid_seed_rows_are_rejected(tmp_path: Path, body: str, message: str) -> None:
    with pytest.raises(SeedError, match=message):
        read_seed_rules(write(tmp_path, body))


@pytest.mark.parametrize("category", ["income", "transfer"])
def test_contains_rows_for_income_and_transfer_are_read(tmp_path: Path, category: str) -> None:
    [rule] = read_seed_rules(write(tmp_path, f"ppd id,contains,{category}\n"))
    assert (rule.merchant_norm, rule.match, rule.category) == (
        "ppd id",
        RuleMatch.CONTAINS,
        category,
    )


def test_a_contains_and_a_prefix_rule_may_share_a_merchant(tmp_path: Path) -> None:
    rules = read_seed_rules(write(tmp_path, "payroll,prefix,income\npayroll,contains,income\n"))
    assert [rule.match for rule in rules] == [RuleMatch.PREFIX, RuleMatch.CONTAINS]


def test_header_is_required(tmp_path: Path) -> None:
    path = tmp_path / "rules.csv"
    path.write_text("norm,kind,label\nnetflix,prefix,subscriptions\n")
    with pytest.raises(SeedError, match="header"):
        read_seed_rules(path)


def test_seed_path_is_the_committed_file() -> None:
    assert SEED_CSV.name == "category_rules.csv"
    assert read_seed_rules()[0].match in tuple(RuleMatch)
