"""The plan page renders the same HTML for the same plan (spec 016 rule 11, example 19)."""

from __future__ import annotations

from pathlib import Path

from sqlalchemy import Connection

from app.db import user_session_for
from app.plan import build_plan
from export.html import render_html
from tests.conftest import FixtureUser
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


def test_an_empty_plan_says_nothing_is_saved(
    frozen_app: object, db_connection: Connection, user_b: FixtureUser
) -> None:
    html = plan_html(db_connection, user_b)
    assert "No decisions saved yet." in html
    assert "Nothing is due in the next 90 days." in html
