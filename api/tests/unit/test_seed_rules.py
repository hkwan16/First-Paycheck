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


@pytest.mark.parametrize(
    ("raw", "category"),
    [
        ("NETFLIX.COM #1234", "subscriptions"),
        ("WHOLEFDS MKT 10234", "groceries"),
        ("Uber 063015 SF**POOL**", "transport"),
        ("UBER EATS 8005928996", "dining"),
        ("ADP PAYROLL 102326", "income"),
        ("ACH Electronic CreditGUSTO PAY 123456", "income"),
        ("COMCAST CABLE 800-266-2278", "phone_internet"),
        ("PG&E WEB ONLINE", "utilities"),
        ("GEICO *AUTO", "insurance"),
        ("ZELLE TO JOHN", "transfer"),
        ("CREDIT CARD 3333 PAYMENT *//", "transfer"),
        ("BILT RENT 12/01", "housing"),
        ("CLIPPER SERVICE", "transport"),
        ("COSTCO GAS #0123", "transport"),
        ("COSTCO WHSE #0123", "shopping"),
        ("United Airlines", "travel"),
        ("McDonald's", "dining"),
    ],
)
def test_seed_rules_label_common_descriptors(raw: str, category: str) -> None:
    found = apply_rules(normalize_merchant(raw), RuleBook(read_seed_rules()))
    assert found is not None, raw
    assert found.category == category


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
    ],
)
def test_invalid_seed_rows_are_rejected(tmp_path: Path, body: str, message: str) -> None:
    with pytest.raises(SeedError, match=message):
        read_seed_rules(write(tmp_path, body))


def test_header_is_required(tmp_path: Path) -> None:
    path = tmp_path / "rules.csv"
    path.write_text("norm,kind,label\nnetflix,prefix,subscriptions\n")
    with pytest.raises(SeedError, match="header"):
        read_seed_rules(path)


def test_seed_path_is_the_committed_file() -> None:
    assert SEED_CSV.name == "category_rules.csv"
    assert read_seed_rules()[0].match in tuple(RuleMatch)
