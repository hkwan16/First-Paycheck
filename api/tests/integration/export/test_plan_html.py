"""The plan page renders the same HTML for the same plan (spec 016 rule 11, example 19)."""

from __future__ import annotations

from pathlib import Path

from sqlalchemy import Connection, text

from app.db import user_session_for
from app.plan import build_plan
from export.html import STALE_LABEL, render_html
from tests.conftest import FixtureUser
from tests.support.factories import make_document
from tests.support.plan_user import NOW, PlanUser

FIXTURE = Path(__file__).parent.parent.parent / "fixtures" / "export" / "plan.html"


def plan_html(connection: Connection, user: FixtureUser) -> str:
    with user_session_for(user.id, bind=connection) as session:
        plan = build_plan(session, NOW.date())
    return render_html(plan, NOW)


def test_html_matches_the_fixture(
    plan_user: PlanUser, db_connection: Connection, user_a: FixtureUser
) -> None:
    assert plan_html(db_connection, user_a) == FIXTURE.read_text(encoding="utf-8")


def test_html_has_no_ids(
    plan_user: PlanUser, db_connection: Connection, user_a: FixtureUser
) -> None:
    html = plan_html(db_connection, user_a)
    for decision_id in (plan_user.k401_id, plan_user.w4_id, plan_user.account_id):
        assert str(decision_id) not in html


def test_a_paused_goal_has_no_pace(
    plan_user: PlanUser, db_connection: Connection, user_a: FixtureUser
) -> None:
    # Issue 166: a paused goal gets no contributions, so it is on pace for nothing.
    assert "On pace for" in plan_html(db_connection, user_a)
    with user_session_for(user_a.id, bind=db_connection) as session:
        session.execute(text("UPDATE goals SET status = 'paused'"))
    html = plan_html(db_connection, user_a)
    assert '<td class="num">Paused</td>' in html
    assert "On pace for" not in html


def test_an_empty_plan_says_nothing_is_saved(
    frozen_app: object, db_connection: Connection, user_b: FixtureUser
) -> None:
    html = plan_html(db_connection, user_b)
    assert "No decisions saved yet." in html
    assert "Nothing is due in the next 90 days." in html


def test_a_stale_explanation_is_labeled_and_its_text_left_out(
    plan_user: PlanUser, db_connection: Connection, user_a: FixtureUser
) -> None:
    """Spec 016 rule 11: a printed plan never carries an out-of-date sentence."""
    # A benefits summary the 401(k) query finds changes what it is explained from.
    document = make_document(db_connection, user_a.id, type="benefits", with_blob=False)
    with user_session_for(user_a.id, bind=db_connection) as session:
        session.execute(
            text(
                "INSERT INTO benefits_chunks (user_id, document_id, chunk_index, text)"
                " VALUES (:u, :d, 0, 'Employer matching contributions vest after one year.')"
            ),
            {"u": user_a.id, "d": document},
        )
    html = plan_html(db_connection, user_a)
    # Once on page 1 and once in "Why, with sources".
    assert html.count(STALE_LABEL) == 2
    assert "Contributing 4% earns the full employer match" not in html
    # The W-4's explanation is still current and printed.
    assert "the withholding covers the year" in html
