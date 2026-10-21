"""IRS citations seed and retrieval, and benefits full-text search (spec 008 rules 3-6)."""

from __future__ import annotations

import datetime as dt
import uuid

import pytest
from sqlalchemy import Connection, text

from app.db import user_session_for
from db.enums import CalculatorKind
from db.seed.load import SeedCitation, load_irs_citations, read_seed_citations
from retrieval.benefits_search import search
from retrieval.citations import for_calculator
from tests.conftest import FixtureUser
from tests.support.factories import make_document


@pytest.fixture
def no_citations(db_connection: Connection) -> Connection:
    """Start from no citation rows (``make seed`` may have loaded them)."""
    db_connection.execute(text("DELETE FROM irs_citations"))
    return db_connection


def citation_rows(connection: Connection) -> dict[str, str]:
    rows = connection.execute(text("SELECT key, passage FROM irs_citations")).all()
    return {row[0]: row[1] for row in rows}


def test_seed_loads_idempotently(no_citations: Connection) -> None:
    citations = read_seed_citations()
    first = load_irs_citations(no_citations, citations)
    assert first.inserted == len(citations)
    before = citation_rows(no_citations)
    again = load_irs_citations(no_citations, citations)
    assert (again.inserted, again.updated, again.deleted) == (0, 0, 0)
    assert citation_rows(no_citations) == before


def test_seed_updates_and_removes(no_citations: Connection) -> None:
    def entry(key: str, passage: str) -> SeedCitation:
        return SeedCitation(
            key=key,
            calculator=CalculatorKind.K401_MATCH,
            tax_year=2026,
            title="T",
            source="S",
            url="https://www.irs.gov/x",
            passage=passage,
            verified=True,
            verified_on=dt.date(2026, 10, 21),
        )

    load_irs_citations(no_citations, [entry("k401.a", "one"), entry("k401.b", "two")])
    result = load_irs_citations(no_citations, [entry("k401.a", "changed"), entry("k401.c", "3")])
    assert (result.inserted, result.updated, result.deleted) == (1, 1, 1)
    assert citation_rows(no_citations) == {"k401.a": "changed", "k401.c": "3"}


def test_unverified_entries_are_not_loaded(no_citations: Connection) -> None:
    [first, *_] = read_seed_citations()
    unverified = first.model_copy(update={"verified": False})
    result = load_irs_citations(no_citations, [unverified])
    assert result.inserted == 0
    assert citation_rows(no_citations) == {}


def test_for_calculator_returns_the_keys(no_citations: Connection, user_a: FixtureUser) -> None:
    load_irs_citations(no_citations, read_seed_citations())
    with user_session_for(user_a.id, bind=no_citations) as session:
        found = for_calculator(session, "k401_match", 2026)
        assert [c.key for c in found] == sorted(
            [
                "k401.catch_up",
                "k401.compensation_limit",
                "k401.deferral_limit",
                "k401.employer_match",
                "k401.federal_brackets",
                "k401.pretax_deferral",
                "k401.vesting",
            ]
        )
        assert all(c.url.startswith("https://www.irs.gov/") for c in found)
        assert for_calculator(session, "k401_match", 2027) == []
        assert for_calculator(session, "w4", 2026) == []


def add_chunks(connection: Connection, user: FixtureUser, *bodies: str) -> uuid.UUID:
    document = make_document(connection, user.id, type="benefits", with_blob=False)
    with user_session_for(user.id, bind=connection) as session:
        for index, body in enumerate(bodies):
            session.execute(
                text(
                    "INSERT INTO benefits_chunks (user_id, document_id, chunk_index, text)"
                    " VALUES (:u, :d, :i, :t)"
                ),
                {"u": user.id, "d": document, "i": index, "t": body},
            )
    return document


def test_benefits_search_ranks_the_matching_chunk_first(
    db_connection: Connection, user_a: FixtureUser, user_b: FixtureUser
) -> None:
    add_chunks(
        db_connection,
        user_a,
        "Medical plans: the PPO deductible is $500 and the HMO has copays.",
        "Retirement: the company matches 100% of the first 4% you contribute to the 401(k)"
        " plan. Matching contributions vest over three years.",
        "Dental and vision coverage start on your first day.",
    )
    add_chunks(db_connection, user_b, "Retirement match: 401(k) matching contributions vest.")
    with user_session_for(user_a.id, bind=db_connection) as session:
        results = search(session, user_a.id, "401(k) retirement match vesting", 3)
    assert results
    assert results[0].chunk_index == 1
    assert "matches 100%" in results[0].text
    assert all(result.rank > 0 for result in results)
    assert [result.rank for result in results] == sorted(
        (result.rank for result in results), reverse=True
    )


def test_benefits_search_matches_any_word(db_connection: Connection, user_a: FixtureUser) -> None:
    """A chunk needs only one of the words; more words rank higher. Real plan
    text rarely says "401(k)", "retirement", "match" and "vesting" in one chunk."""
    add_chunks(
        db_connection,
        user_a,
        "Employer matching contributions vest after one year of service.",
        "Dental coverage includes two cleanings a year.",
        "The 401(k) retirement plan matches contributions, which vest after one year.",
    )
    with user_session_for(user_a.id, bind=db_connection) as session:
        results = search(session, user_a.id, "401(k) retirement match vesting", 3)
    assert [result.chunk_index for result in results] == [2, 0]


def test_benefits_search_treats_words_as_words(
    db_connection: Connection, user_a: FixtureUser
) -> None:
    """tsquery operators in the query are plain text, never syntax."""
    add_chunks(db_connection, user_a, "401(k) match")
    with user_session_for(user_a.id, bind=db_connection) as session:
        assert len(search(session, user_a.id, "match & !(| :* <->", 3)) == 1
        assert search(session, user_a.id, "the and of", 3) == []


def test_benefits_search_respects_k_and_empty_queries(
    db_connection: Connection, user_a: FixtureUser
) -> None:
    add_chunks(db_connection, user_a, "401(k) match", "401(k) vesting", "401(k) loans")
    with user_session_for(user_a.id, bind=db_connection) as session:
        assert len(search(session, user_a.id, "401(k)", 2)) == 2
        assert search(session, user_a.id, "", 3) == []
        assert search(session, user_a.id, "pension annuity", 3) == []


def test_benefits_search_never_returns_another_users_text(
    db_connection: Connection, user_a: FixtureUser, user_b: FixtureUser
) -> None:
    add_chunks(db_connection, user_a, "401(k) matching contributions")
    with user_session_for(user_b.id, bind=db_connection) as session:
        # Even asking for A's id, B's session sees none of A's rows.
        assert search(session, user_a.id, "401(k) matching", 3) == []
