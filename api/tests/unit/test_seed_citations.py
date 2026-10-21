"""The committed IRS citation seed (spec 008 rules 1-2)."""

from __future__ import annotations

from pathlib import Path

import pytest

from calc.health_plans import BASE_CITATION_KEYS as HEALTH_BASE_KEYS
from calc.health_plans import HDHP_CITATION_KEYS
from calc.k401 import BASE_CITATION_KEYS, CATCH_UP_KEY, COMPENSATION_LIMIT_KEY
from db.seed.load import SeedError, read_seed_citations


def test_every_committed_entry_is_verified_and_short() -> None:
    citations = read_seed_citations()
    assert citations
    for citation in citations:
        assert citation.verified, citation.key
        assert len(citation.passage.split()) < 80, citation.key
        assert citation.url.startswith("https://www.irs.gov/"), citation.key


def test_k401_seed_covers_every_key_the_calculator_emits() -> None:
    keys = {c.key for c in read_seed_citations() if c.calculator == "k401_match"}
    emitted = {*BASE_CITATION_KEYS, CATCH_UP_KEY, COMPENSATION_LIMIT_KEY}
    assert emitted <= keys
    assert keys == emitted | {"k401.vesting"}
    assert {c.tax_year for c in read_seed_citations()} == {2026}


def test_health_seed_covers_every_key_the_calculator_emits() -> None:
    """Spec 012 rule 11."""
    keys = {c.key for c in read_seed_citations() if c.calculator == "health_plans"}
    assert keys == {*HDHP_CITATION_KEYS, *HEALTH_BASE_KEYS}


def write(directory: Path, body: str) -> Path:
    (directory / "k401.yaml").write_text(body, encoding="utf-8")
    return directory


ENTRY = """
- key: k401.deferral_limit
  calculator: k401_match
  tax_year: 2026
  title: T
  source: S
  url: https://www.irs.gov/x
  passage: A short passage.
  verified: {verified}
  verified_on: 2026-10-21
"""


def test_unverified_entries_are_read_but_flagged(tmp_path: Path) -> None:
    [citation] = read_seed_citations(write(tmp_path, ENTRY.format(verified="false")))
    assert citation.verified is False


@pytest.mark.parametrize(
    ("change", "message"),
    [
        (("url: https://www.irs.gov/x", "url: http://www.irs.gov/x"), "url"),
        (("url: https://www.irs.gov/x", "url: https://example.com/x"), "url"),
        (("key: k401.deferral_limit", "key: Deferral Limit"), "key"),
        (("calculator: k401_match", "calculator: pension"), "calculator"),
        (("passage: A short passage.", "passage: " + "word " * 80), "80 words"),
    ],
)
def test_malformed_entries_fail_the_load(
    tmp_path: Path, change: tuple[str, str], message: str
) -> None:
    body = ENTRY.format(verified="true").replace(*change)
    with pytest.raises(SeedError, match=message):
        read_seed_citations(write(tmp_path, body))


def test_duplicate_keys_fail_the_load(tmp_path: Path) -> None:
    entry = ENTRY.format(verified="true")
    with pytest.raises(SeedError, match="duplicate"):
        read_seed_citations(write(tmp_path, entry + entry))
