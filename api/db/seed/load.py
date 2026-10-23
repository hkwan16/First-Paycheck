"""Load reference data: ``python -m db.seed.load``.

Runs on every deploy after ``alembic upgrade head`` (Render pre-deploy) on the
privileged connection, so it must be idempotent. It upserts the seed category
rules from ``category_rules.csv`` and the IRS citations from
``irs_citations/*.yaml`` (spec 008), and deletes seed rows the files no
longer list, in one transaction. User rules are never touched.
"""

from __future__ import annotations

import csv
import datetime as dt
import logging
import re
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml
from pydantic import BaseModel, ConfigDict, ValidationError, field_validator
from sqlalchemy import Connection, Engine, text

from app.db import get_privileged_engine
from app.logs import configure_logging
from db.enums import CalculatorKind, RuleMatch, RuleSource
from sync.categories import CATEGORIES
from sync.categorize import CategoryRule, check_contains, normalize_merchant

logger = logging.getLogger("db.seed")

SEED_DIR = Path(__file__).resolve().parent
SEED_CSV = SEED_DIR / "category_rules.csv"
SEED_CITATIONS_DIR = SEED_DIR / "irs_citations"
_HEADER = ["merchant_norm", "match", "category"]
_CITATION_KEY = re.compile(r"[a-z0-9]+(?:\.[a-z0-9_]+)+")
MAX_PASSAGE_WORDS = 80


class SeedError(ValueError):
    """The seed file is malformed."""


@dataclass(frozen=True)
class SeedResult:
    inserted: int
    updated: int
    deleted: int


def read_seed_rules(path: Path = SEED_CSV) -> list[CategoryRule]:
    """Parse and validate the seed file; any bad row fails the whole load."""
    with path.open(newline="", encoding="utf-8") as handle:
        reader = csv.reader(handle)
        header = next(reader, None)
        if header != _HEADER:
            raise SeedError(f"{path.name}: header must be {','.join(_HEADER)}")
        rules: list[CategoryRule] = []
        seen: set[tuple[str, RuleMatch]] = set()
        for line, row in enumerate(reader, start=2):
            rules.append(_parse_row(path.name, line, row, seen))
    return rules


def _parse_row(
    name: str, line: int, row: list[str], seen: set[tuple[str, RuleMatch]]
) -> CategoryRule:
    where = f"{name}:{line}"
    if len(row) != len(_HEADER):
        raise SeedError(f"{where}: expected {len(_HEADER)} columns")
    merchant_norm, match_value, category = row
    if not merchant_norm:
        raise SeedError(f"{where}: empty merchant_norm")
    if merchant_norm != normalize_merchant(merchant_norm):
        raise SeedError(
            f"{where}: {merchant_norm!r} is not normalized"
            f" (normalize_merchant gives {normalize_merchant(merchant_norm)!r})"
        )
    try:
        match = RuleMatch(match_value)
    except ValueError as exc:
        choices = ", ".join(kind.value for kind in RuleMatch)
        raise SeedError(f"{where}: match must be one of {choices}") from exc
    if category not in CATEGORIES:
        raise SeedError(f"{where}: unknown category {category!r}")
    if (merchant_norm, match) in seen:
        raise SeedError(f"{where}: duplicate rule {merchant_norm!r} ({match})")
    seen.add((merchant_norm, match))
    rule = CategoryRule(
        merchant_norm=merchant_norm, match=match, category=category, source=RuleSource.SEED
    )
    problem = check_contains(rule)
    if problem is not None:
        raise SeedError(f"{where}: {problem}, not {category!r} (spec 003 rule 3c)")
    return rule


_UPSERT = text(
    """
    INSERT INTO category_rules (user_id, merchant_norm, match, category, source)
    SELECT NULL, rule.merchant_norm, rule.match, rule.category, 'seed'
    FROM unnest(
      CAST(:norms AS text[]), CAST(:matches AS rule_match[]), CAST(:categories AS text[])
    ) AS rule (merchant_norm, match, category)
    ON CONFLICT ON CONSTRAINT uq_category_rules_user_id_merchant_norm_match
    DO UPDATE SET category = EXCLUDED.category
    WHERE category_rules.category IS DISTINCT FROM EXCLUDED.category
    RETURNING (xmax = 0) AS inserted
    """
)

_DELETE_DROPPED = text(
    """
    DELETE FROM category_rules
    WHERE user_id IS NULL
      AND (merchant_norm, match) NOT IN (
        SELECT * FROM unnest(CAST(:norms AS text[]), CAST(:matches AS rule_match[]))
      )
    """
)


def load_category_rules(connection: Connection, rules: Sequence[CategoryRule]) -> SeedResult:
    """Make the seed rows equal ``rules``. Runs inside the caller's transaction."""
    if any(rule.source is not RuleSource.SEED for rule in rules):
        raise SeedError("only seed rules can be loaded")
    params = {
        "norms": [rule.merchant_norm for rule in rules],
        "matches": [rule.match.value for rule in rules],
        "categories": [rule.category for rule in rules],
    }
    written = connection.execute(_UPSERT, params).scalars().all()
    inserted = sum(1 for was_insert in written if was_insert)
    deleted = connection.execute(_DELETE_DROPPED, params).rowcount
    return SeedResult(inserted=inserted, updated=len(written) - inserted, deleted=deleted)


# ---------------------------------------------------------------- IRS citations


class SeedCitation(BaseModel):
    """One curated passage (spec 008 rule 1)."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    key: str
    calculator: CalculatorKind
    tax_year: int
    title: str
    source: str
    url: str
    passage: str
    # False when the page could not be fetched to check the quote; not loaded.
    verified: bool
    verified_on: dt.date

    @field_validator("key")
    @classmethod
    def _key_shape(cls, value: str) -> str:
        if not _CITATION_KEY.fullmatch(value):
            raise ValueError(f"key {value!r} must look like 'k401.deferral_limit'")
        return value

    @field_validator("url")
    @classmethod
    def _irs_https(cls, value: str) -> str:
        if not value.startswith("https://www.irs.gov/"):
            raise ValueError("url must be an https://www.irs.gov/ page")
        return value

    @field_validator("passage")
    @classmethod
    def _short(cls, value: str) -> str:
        if len(value.split()) >= MAX_PASSAGE_WORDS:
            raise ValueError(f"passage must be under {MAX_PASSAGE_WORDS} words")
        return value.strip()


def read_seed_citations(directory: Path = SEED_CITATIONS_DIR) -> list[SeedCitation]:
    """Parse and validate every ``*.yaml`` file; any bad entry fails the whole load."""
    citations: list[SeedCitation] = []
    seen: set[tuple[str, str, int]] = set()
    for path in sorted(directory.glob("*.yaml")):
        entries: Any = yaml.safe_load(path.read_text(encoding="utf-8"))
        if not isinstance(entries, list):
            raise SeedError(f"{path.name}: expected a list of citations")
        for number, entry in enumerate(entries, start=1):
            where = f"{path.name}: entry {number}"
            try:
                citation = SeedCitation.model_validate(entry)
            except ValidationError as exc:
                problems = "; ".join(
                    f"{'.'.join(map(str, error['loc']))}: {error['msg']}" for error in exc.errors()
                )
                raise SeedError(f"{where}: {problems}") from None
            identity = (citation.calculator.value, citation.key, citation.tax_year)
            if identity in seen:
                raise SeedError(f"{where}: duplicate citation {citation.key} ({citation.tax_year})")
            seen.add(identity)
            citations.append(citation)
    return citations


_UPSERT_CITATIONS = text(
    """
    INSERT INTO irs_citations (calculator, key, tax_year, title, url, passage, source, verified_on)
    SELECT * FROM unnest(
      CAST(:calculators AS calculator_kind[]), CAST(:keys AS text[]), CAST(:years AS smallint[]),
      CAST(:titles AS text[]), CAST(:urls AS text[]), CAST(:passages AS text[]),
      CAST(:sources AS text[]), CAST(:verified_on AS date[])
    )
    ON CONFLICT ON CONSTRAINT uq_irs_citations_calculator_key_tax_year
    DO UPDATE SET title = EXCLUDED.title, url = EXCLUDED.url, passage = EXCLUDED.passage,
      source = EXCLUDED.source, verified_on = EXCLUDED.verified_on
    WHERE (irs_citations.title, irs_citations.url, irs_citations.passage, irs_citations.source,
           irs_citations.verified_on)
      IS DISTINCT FROM (EXCLUDED.title, EXCLUDED.url, EXCLUDED.passage, EXCLUDED.source,
           EXCLUDED.verified_on)
    RETURNING (xmax = 0) AS inserted
    """
)

_DELETE_DROPPED_CITATIONS = text(
    """
    DELETE FROM irs_citations
    WHERE (calculator::text, key, tax_year) NOT IN (
      SELECT * FROM unnest(
        CAST(:calculators AS text[]), CAST(:keys AS text[]), CAST(:years AS smallint[])
      )
    )
    """
)


def load_irs_citations(connection: Connection, citations: Sequence[SeedCitation]) -> SeedResult:
    """Make the table equal the verified ``citations``. Runs in the caller's transaction."""
    verified = [citation for citation in citations if citation.verified]
    params = {
        "calculators": [citation.calculator.value for citation in verified],
        "keys": [citation.key for citation in verified],
        "years": [citation.tax_year for citation in verified],
        "titles": [citation.title for citation in verified],
        "urls": [citation.url for citation in verified],
        "passages": [citation.passage for citation in verified],
        "sources": [citation.source for citation in verified],
        "verified_on": [citation.verified_on for citation in verified],
    }
    written = connection.execute(_UPSERT_CITATIONS, params).scalars().all()
    inserted = sum(1 for was_insert in written if was_insert)
    deleted = connection.execute(_DELETE_DROPPED_CITATIONS, params).rowcount
    return SeedResult(inserted=inserted, updated=len(written) - inserted, deleted=deleted)


def load(bind: Engine | None = None) -> int:
    """Load every seed; returns the number of seed category rules."""
    rules = read_seed_rules()
    citations = read_seed_citations()
    engine = bind if bind is not None else get_privileged_engine()
    with engine.begin() as connection:
        result = load_category_rules(connection, rules)
        cited = load_irs_citations(connection, citations)
    logger.info(
        "category rules: %d seed rows (%d inserted, %d updated, %d deleted)",
        len(rules),
        result.inserted,
        result.updated,
        result.deleted,
    )
    unverified = [citation.key for citation in citations if not citation.verified]
    logger.info(
        "irs citations: %d verified (%d inserted, %d updated, %d deleted);"
        " unverified, not loaded: %s",
        len(citations) - len(unverified),
        cited.inserted,
        cited.updated,
        cited.deleted,
        ", ".join(unverified) or "none",
    )
    return len(rules)


def main() -> int:
    configure_logging()
    load()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
