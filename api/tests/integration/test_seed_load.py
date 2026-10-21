"""The seed loader upserts category rules idempotently on the privileged connection."""

from __future__ import annotations

import logging
import os
import subprocess
import sys

import pytest
from sqlalchemy import Connection, Engine, text

from app.config import REPO_ROOT
from db.enums import RuleMatch, RuleSource
from db.seed import load
from db.seed.load import load_category_rules, read_seed_rules
from sync.categorize import CategoryRule
from tests.support.database import upgrade


def seed_rule(merchant_norm: str, match: RuleMatch, category: str) -> CategoryRule:
    return CategoryRule(merchant_norm, match, category, RuleSource.SEED)


def seed_rows(connection: Connection) -> dict[tuple[str, str], str]:
    rows = connection.execute(
        text("SELECT merchant_norm, match, category FROM category_rules WHERE user_id IS NULL")
    ).all()
    return {(row[0], row[1]): row[2] for row in rows}


@pytest.mark.usefixtures("no_seed_rules")
def test_load_inserts_every_seed_row(db_connection: Connection) -> None:
    rules = read_seed_rules()
    result = load_category_rules(db_connection, rules)
    assert result.inserted == len(rules)
    assert len(seed_rows(db_connection)) == len(rules)


@pytest.mark.usefixtures("no_seed_rules")
def test_load_is_idempotent(db_connection: Connection) -> None:
    rules = read_seed_rules()
    load_category_rules(db_connection, rules)
    before = seed_rows(db_connection)
    again = load_category_rules(db_connection, rules)
    assert (again.inserted, again.updated, again.deleted) == (0, 0, 0)
    assert seed_rows(db_connection) == before


@pytest.mark.usefixtures("no_seed_rules")
def test_load_updates_changed_rows_and_removes_dropped_ones(db_connection: Connection) -> None:
    load_category_rules(
        db_connection,
        [
            seed_rule("netflix", RuleMatch.PREFIX, "entertainment"),
            seed_rule("old merchant", RuleMatch.EXACT, "other"),
        ],
    )
    result = load_category_rules(
        db_connection,
        [
            seed_rule("netflix", RuleMatch.PREFIX, "subscriptions"),
            seed_rule("spotify", RuleMatch.PREFIX, "subscriptions"),
        ],
    )
    assert (result.inserted, result.updated, result.deleted) == (1, 1, 1)
    assert seed_rows(db_connection) == {
        ("netflix", "prefix"): "subscriptions",
        ("spotify", "prefix"): "subscriptions",
    }


def test_load_never_touches_user_rules(db_connection: Connection, user_a: object) -> None:
    db_connection.execute(
        text(
            "INSERT INTO category_rules (user_id, merchant_norm, match, category, source)"
            " VALUES ('00000000-0000-4000-8000-00000000000a', 'netflix', 'prefix', 'other', 'user')"
        )
    )
    load_category_rules(db_connection, [seed_rule("spotify", RuleMatch.PREFIX, "subscriptions")])
    users = db_connection.execute(
        text("SELECT count(*) FROM category_rules WHERE user_id IS NOT NULL")
    ).scalar_one()
    assert users == 1


def seed_count(engine: Engine) -> int:
    with engine.connect() as connection:
        return int(
            connection.execute(
                text("SELECT count(*) FROM category_rules WHERE user_id IS NULL")
            ).scalar_one()
        )


def test_load_commits_on_the_given_engine(
    scratch_database: tuple[str, Engine], caplog: pytest.LogCaptureFixture
) -> None:
    url, engine = scratch_database
    upgrade(url, "head")
    with caplog.at_level(logging.INFO):
        assert load.load(engine) == len(read_seed_rules())
        assert load.load(engine) == len(read_seed_rules())
    assert seed_count(engine) == len(read_seed_rules())
    assert "0 inserted, 0 updated, 0 deleted" in caplog.text


def test_seed_module_runs_against_the_privileged_url(scratch_database: tuple[str, Engine]) -> None:
    url, engine = scratch_database
    upgrade(url, "head")
    result = subprocess.run(
        [sys.executable, "-m", "db.seed.load"],
        cwd=REPO_ROOT / "api",
        env={**os.environ, "DATABASE_URL_PRIVILEGED": url},
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    assert "category rules" in result.stderr
    assert seed_count(engine) == len(read_seed_rules())
