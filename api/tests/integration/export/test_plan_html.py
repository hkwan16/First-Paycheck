"""The plan page renders the same HTML for the same plan (spec 016 rule 11, example 19)."""

from __future__ import annotations

import datetime as dt
import re
from html import unescape
from pathlib import Path

from sqlalchemy import Connection, text

from app.db import user_session_for
from app.decision_review import ReviewReason
from app.plan import PlanExplanation, PlanOut, build_plan
from export.html import REVIEW_NOTE, STALE_LABEL, render_html
from tests.conftest import FixtureUser
from tests.support.factories import make_document
from tests.support.plan_user import NOW, PlanUser

FIXTURE = Path(__file__).parent.parent.parent / "fixtures" / "export" / "plan.html"
# Spec 016 rule 4: a decision with no explanation row.
NO_EXPLANATION = PlanExplanation(
    status="none", id=None, concept=None, text=None, created_at=None, citations=[], stale=False
)


def saved_at(plan: PlanOut, when: dt.datetime) -> PlanOut:
    """``plan`` with every decision saved at ``when``."""
    return plan.model_copy(
        update={
            "decisions": [
                decision.model_copy(update={"created_at": when}) for decision in plan.decisions
            ]
        }
    )


def plan_of(connection: Connection, user: FixtureUser) -> PlanOut:
    """The user's plan, its decisions saved at ``NOW`` as spec 016's plan user's are.

    Postgres stamps ``created_at`` with the real start of the test's transaction,
    which no fixture can freeze, so the page would print a different saved date
    every day the suite runs.
    """
    with user_session_for(user.id, bind=connection) as session:
        return saved_at(build_plan(session, NOW.date()), NOW)


def plan_html(connection: Connection, user: FixtureUser) -> str:
    return render_html(plan_of(connection, user), NOW)


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


def test_an_overdue_date_is_marked(
    plan_user: PlanUser, db_connection: Connection, user_a: FixtureUser
) -> None:
    """Spec 016 rules 6 and 11 (issue 233): printed on 2026-11-02, the three
    2026-10-31 dates nobody settled are listed and marked Overdue."""
    with user_session_for(user_a.id, bind=db_connection) as session:
        html = render_html(build_plan(session, dt.date(2026, 11, 2)), NOW)
    assert html.count('<span class="overdue">Overdue</span>') == 3
    assert "Oct 31, 2026" in html
    assert 'class="overdue"' not in plan_html(db_connection, user_a)


def test_an_empty_plan_says_nothing_is_saved(
    frozen_app: object, db_connection: Connection, user_b: FixtureUser
) -> None:
    html = plan_html(db_connection, user_b)
    assert "No decisions saved yet." in html
    # Spec 016 rule 11a: the Plan page's "Still to decide" and "Next 90 days" words.
    assert "Still to decide: Emergency fund, 401(k) match, Health plan, W-4, federal only." in html
    assert "<h2>Next 90 days</h2>" in html
    assert "Nothing is due by Jan 19, 2027." in html


def pages(html: str) -> tuple[str, str]:
    """The plan page and the page that starts with the calendar."""
    first, second = html.split('<section class="page-break">')
    return first, second


def decision_block(html: str, name: str) -> str:
    """The page 1 block of the decision headed ``name``."""
    [block] = [
        block.split("\n  </div>\n")[0]
        for block in pages(html)[0].split('<div class="decision">')[1:]
        if f'<span class="name">{name}</span>' in block.split("\n")[1]
    ]
    return block


def text_of(html: str) -> str:
    """What a reader sees: the tags and the stylesheet dropped."""
    body = html.split("<body>", 1)[1]
    return " ".join(unescape(re.sub(r"<[^>]+>", " ", body)).split())


def test_the_pdf_names_calculators_as_the_plan_page_does(
    plan_user: PlanUser, db_connection: Connection, user_a: FixtureUser
) -> None:
    """Spec 016 rule 11a (issue 239): the web's CALCULATOR_LABELS, and a saved date, not a
    version number, beside each decision."""
    html = plan_html(db_connection, user_a)
    assert re.findall(r'<span class="name">([^<]+)</span>', html) == [
        "1. Emergency fund",
        "2. 401(k) match",
        "3. Health plan",
        "4. W-4, federal only",
    ]
    assert html.count('<span class="muted">Saved Oct 21, 2026</span>') == 4
    assert "Version" not in html
    # The UTC day of the save, as the preparation date is (spec 016 rule 11).
    late = dt.datetime(2026, 10, 21, 23, 30, tzinfo=dt.timezone(dt.timedelta(hours=-7)))
    next_day = render_html(saved_at(plan_of(db_connection, user_a), late), NOW)
    assert next_day.count('<span class="muted">Saved Oct 22, 2026</span>') == 4
    assert re.findall(r"<h3>([^<]+)</h3>", html) == [
        "401(k) match",
        "Health plan",
        "W-4, federal only",
    ]
    assert re.findall(r'<span class="what">&#183; ([^<]+)</span>', html) == [
        "401(k) match",
        "Emergency fund",
        "W-4, federal only",
        "Health plan",
    ]


def test_the_paycheck_uses_the_plan_page_labels(
    plan_user: PlanUser, db_connection: Connection, user_a: FixtureUser
) -> None:
    """Spec 016 rule 11a: the "Your paycheck" card's tiles and lines, in the PDF's order."""
    paycheck = pages(plan_html(db_connection, user_a))[0].split("<h2>Decisions</h2>")[0]
    assert re.findall(r'<td class="label">(?:<strong>)?([^<]+)', paycheck) == [
        "Pay date",
        "Gross pay",
        "Federal withholding",
        "Social Security",
        "Medicare",
        "State tax",
        "401(k)",
        "Medical premium",
        "Other deductions",
        "Take-home pay",
    ]


def test_an_emergency_fund_prints_no_explanation_line(
    plan_user: PlanUser, db_connection: Connection, user_a: FixtureUser
) -> None:
    """Spec 016 rule 11a: an emergency fund is never explained (spec 011), so the PDF does
    not say it is "Not explained yet", as the Plan page says nothing."""
    fund = decision_block(plan_html(db_connection, user_a), "1. Emergency fund")
    assert '<td class="label">Target</td>' in fund
    assert 'class="status' not in fund


def test_explanation_lines_use_the_plan_page_words(
    plan_user: PlanUser, db_connection: Connection, user_a: FixtureUser
) -> None:
    """Spec 016 rule 11a: page 1 in the Plan page's words, page 2 in the Why page's."""
    plan = plan_of(db_connection, user_a)
    unexplained = plan.model_copy(
        update={
            "decisions": [
                decision.model_copy(update={"explanation": NO_EXPLANATION})
                if decision.calculator == "w4"
                else decision
                for decision in plan.decisions
            ]
        }
    )
    html = render_html(unexplained, NOW)
    assert (
        "Explained under Why, with sources. We checked every number in it against the"
        " decision you saved." in decision_block(html, "2. 401(k) match")
    )
    assert (
        "We could not write this explanation. Open Why in First Paycheck to try again."
        in decision_block(html, "3. Health plan")
    )
    assert "No explanation yet. Open Why in First Paycheck to write one." in decision_block(
        html, "4. W-4, federal only"
    )
    why = pages(html)[1]
    assert "We checked every number here against the decision you saved." in why
    assert (
        "We could not write an explanation that matches your numbers, so here are the"
        " numbers you saved." in why
    )
    assert "W-4, federal only" not in why.split("<h2>Why, with sources</h2>")[1]


def test_the_fund_decision_and_its_goal_do_not_both_say_saved_so_far(
    plan_user: PlanUser, db_connection: Connection, user_a: FixtureUser
) -> None:
    """Spec 016 rules 3 and 11a (issue 239): the decision's balance is from when it was saved,
    the goal's is the linked account's now, and a goal with none prints no balance row."""
    html = plan_html(db_connection, user_a)
    assert (
        '<td class="label">Already saved when you decided</td><td class="num">$2,140.00</td>'
        in decision_block(html, "1. Emergency fund")
    )
    goals = pages(html)[0].split("<h2>Goals</h2>")[1]
    assert '<td class="label">Saved so far</td><td class="num">$2,140.00 (39.13%)</td>' in goals
    with user_session_for(user_a.id, bind=db_connection) as session:
        session.execute(text("UPDATE goals SET account_id = NULL"))
    unlinked = plan_html(db_connection, user_a)
    assert "Saved so far" not in unlinked
    assert "No linked account" not in unlinked
    assert "Already saved when you decided" in unlinked


# Words about how the app works rather than the person's money (plan.spec.ts's INTERNALS).
INTERNALS = re.compile(r"\b(calculators?|verified|verifier|fallback|version \d+|v\d+)\b", re.I)


def test_page_one_speaks_plainly(
    plan_user: PlanUser, db_connection: Connection, user_a: FixtureUser
) -> None:
    """Spec 016 rule 11a: every status page 1 can print, in words a first job's reader knows."""
    plan = plan_of(db_connection, user_a)
    variants = [plan]
    for change in (
        {"status": "none", "stale": False},
        {"stale": True},
    ):
        variants.append(
            plan.model_copy(
                update={
                    "decisions": [
                        decision.model_copy(
                            update={"explanation": decision.explanation.model_copy(update=change)}
                        )
                        for decision in plan.decisions
                    ]
                }
            )
        )
    for variant in variants:
        page_one = text_of(pages(render_html(variant, NOW))[0])
        assert not INTERNALS.search(page_one), INTERNALS.search(page_one)


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


def test_a_decision_that_needs_review_prints_the_note(
    plan_user: PlanUser, db_connection: Connection, user_a: FixtureUser
) -> None:
    """Spec 016 rule 3a: its figures were worked out before the change, so none print."""
    with user_session_for(user_a.id, bind=db_connection) as session:
        plan = build_plan(session, NOW.date())
    reason = ReviewReason(
        kind="changed",
        input="pay_periods_per_year",
        text="Your pay schedule changed from 24 to 26 paychecks a year.",
    )
    decisions = [
        decision.model_copy(update={"review": [reason]})
        if decision.calculator == "health_plans"
        else decision
        for decision in plan.decisions
    ]
    html = render_html(plan.model_copy(update={"decisions": decisions}), NOW)
    assert "Needs review: Your pay schedule changed from 24 to 26 paychecks a year." in html
    assert html.count(REVIEW_NOTE) == 1
    # The health plan's figures are left out; the other decisions keep theirs.
    assert "Bronze HSA" not in html
    assert "Premiums a year" not in html
    assert "Federal tax withheld per paycheck with your new W-4" in html
