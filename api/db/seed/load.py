"""Load reference data: ``python -m db.seed.load``.

Runs on every deploy after ``alembic upgrade head`` (Render pre-deploy) on the
privileged connection, so it must be idempotent: it upserts the seed category
rules from ``category_rules.csv`` and deletes seed rows the file no longer
lists. User rules are never touched.
"""

from __future__ import annotations

import csv
import logging
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path

from sqlalchemy import Connection, Engine, text

from app.db import get_privileged_engine
from app.logs import configure_logging
from db.enums import RuleMatch, RuleSource
from sync.categories import CATEGORIES
from sync.categorize import CategoryRule, normalize_merchant

logger = logging.getLogger("db.seed")

SEED_CSV = Path(__file__).resolve().parent / "category_rules.csv"
_HEADER = ["merchant_norm", "match", "category"]


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
        raise SeedError(f"{where}: match must be exact or prefix") from exc
    if category not in CATEGORIES:
        raise SeedError(f"{where}: unknown category {category!r}")
    if (merchant_norm, match) in seen:
        raise SeedError(f"{where}: duplicate rule {merchant_norm!r} ({match})")
    seen.add((merchant_norm, match))
    return CategoryRule(
        merchant_norm=merchant_norm, match=match, category=category, source=RuleSource.SEED
    )


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


def load(bind: Engine | None = None) -> int:
    """Load every seed; returns the number of seed category rules."""
    rules = read_seed_rules()
    engine = bind if bind is not None else get_privileged_engine()
    with engine.begin() as connection:
        result = load_category_rules(connection, rules)
    logger.info(
        "category rules: %d seed rows (%d inserted, %d updated, %d deleted)",
        len(rules),
        result.inserted,
        result.updated,
        result.deleted,
    )
    return len(rules)


def main() -> int:
    configure_logging()
    load()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
