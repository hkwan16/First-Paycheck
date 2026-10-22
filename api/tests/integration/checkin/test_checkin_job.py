"""The checkin.monthly job, its monthly enqueue and the sync-triggered refresh
(spec 015 rules 8-16, job examples)."""

from __future__ import annotations

import datetime as dt
import uuid

import pytest
from sqlalchemy import Connection, text

from app.db import user_session_for
from db.enums import CheckinStatus, FindingAction, JobKind
from jobs import queue, scheduler
from jobs.context import Services
from jobs.registry import default_handlers
from jobs.worker import Worker
from tests.conftest import FixtureUser
from tests.support.checkin_jobs import check_ins, checkin_jobs, findings, job_row, run_all
from tests.support.factories import make_check_in, make_finding, make_snapshot
from tests.support.november import NOW, PERIOD, november


@pytest.fixture
def empty_queue(db_connection: Connection) -> Connection:
    db_connection.execute(text("DELETE FROM jobs"))
    return db_connection


def queue_check_in(
    connection: Connection, user: FixtureUser, trigger: str = "schedule", period: str = "2026-11-01"
) -> uuid.UUID:
    with user_session_for(user.id, bind=connection) as session:
        return queue.enqueue(
            session,
            user_id=user.id,
            kind=JobKind.CHECKIN_MONTHLY,
            payload={"period": period, "trigger": trigger},
        )


# ---------------------------------------------------------------- the monthly enqueue


def test_tick_queues_one_check_in_per_user_per_month(
    empty_queue: Connection, user_a: FixtureUser, user_b: FixtureUser
) -> None:
    first = dt.datetime(2026, 11, 1, 8, 0, tzinfo=dt.UTC)

    assert scheduler.tick(bind=empty_queue, now=first)["checkins_queued"] == 2
    assert scheduler.tick(bind=empty_queue, now=first)["checkins_queued"] == 0

    queued = checkin_jobs(empty_queue)
    assert [(j["user_id"], j["idempotency_key"]) for j in queued] == [
        (user_a.id, "checkin.monthly:2026-11"),
        (user_b.id, "checkin.monthly:2026-11"),
    ]
    assert queued[0]["payload"] == {"period": "2026-11-01", "trigger": "schedule"}

    december = dt.datetime(2026, 12, 1, 0, 1, tzinfo=dt.UTC)
    assert scheduler.tick(bind=empty_queue, now=december)["checkins_queued"] == 2
    keys = sorted(j["idempotency_key"] for j in checkin_jobs(empty_queue))
    assert keys.count("checkin.monthly:2026-12") == 2


def test_tick_catches_up_later_in_the_month(empty_queue: Connection, user_a: FixtureUser) -> None:
    # The worker was down on the 1st: the first tick that month still queues it.
    assert scheduler.tick(bind=empty_queue, now=NOW)["checkins_queued"] == 1
    assert checkin_jobs(empty_queue)[0]["payload"]["period"] == "2026-11-01"


def test_the_tick_handler_uses_the_job_clock(empty_queue: Connection, user_a: FixtureUser) -> None:
    empty_queue.execute(text("INSERT INTO jobs (kind) VALUES ('schedule.tick')"))
    Worker(
        handlers={JobKind.SCHEDULE_TICK: default_handlers()[JobKind.SCHEDULE_TICK]},
        services=Services(clock=lambda: dt.datetime(2027, 1, 1, tzinfo=dt.UTC)),
        queue_bind=empty_queue,
        user_bind=empty_queue,
    ).run_once()
    assert checkin_jobs(empty_queue)[0]["idempotency_key"] == "checkin.monthly:2027-01"


# ---------------------------------------------------------------- the job


def test_monthly_job_builds_the_check_in(empty_queue: Connection, user_a: FixtureUser) -> None:
    seeded = november(empty_queue, user_a)
    job_id = queue_check_in(empty_queue, user_a)

    run_all(empty_queue)

    result = job_row(empty_queue, job_id)
    assert result["status"] == "succeeded", result["last_error"]
    made = check_ins(empty_queue, user_a)
    assert [(c["period"], c["triggered_by"], c["status"]) for c in made] == [
        (PERIOD, "schedule", "open")
    ]
    assert result["result"] == {
        "outcome": "created",
        "check_in_id": str(made[0]["id"]),
        "inserted": 6,
        "updated": 0,
        "retracted": 0,
        "dropped": 0,
        "marked_active": 1,
    }
    found = findings(empty_queue, user_a)
    assert sorted((f["kind"], f["severity"]) for f in found) == [
        ("deduction_change", "info"),
        ("deduction_change", "info"),
        ("deduction_change", "info"),
        ("election_mismatch", "alert"),
        ("goal_off_pace", "warning"),
        ("recurring_new", "warning"),
    ]
    election = next(f for f in found if f["kind"] == "election_mismatch")
    assert election["payload"]["expected_cents"] == 10_833
    assert election["payload"]["actual_pct"] == "2.00"
    pace = next(f for f in found if f["kind"] == "goal_off_pace")
    assert pace["payload"]["shortfall_cents"] == 16_000
    status = empty_queue.execute(
        text("SELECT status::text FROM recurring_charges WHERE id = :id"), {"id": seeded.equinox}
    ).scalar_one()
    assert status == "active"


def test_rerunning_changes_nothing(empty_queue: Connection, user_a: FixtureUser) -> None:
    november(empty_queue, user_a)
    queue_check_in(empty_queue, user_a)
    run_all(empty_queue)
    before = {f["id"] for f in findings(empty_queue, user_a)}

    again = queue_check_in(empty_queue, user_a, trigger="sync")
    run_all(empty_queue)

    assert {f["id"] for f in findings(empty_queue, user_a)} == before
    result = job_row(empty_queue, again)["result"]
    assert (result["outcome"], result["inserted"], result["updated"]) == ("refreshed", 0, 5)
    assert len(check_ins(empty_queue, user_a)) == 1


def test_sync_refresh_never_creates_a_check_in(
    empty_queue: Connection, user_a: FixtureUser
) -> None:
    november(empty_queue, user_a)
    job_id = queue_check_in(empty_queue, user_a, trigger="sync")
    run_all(empty_queue)
    assert job_row(empty_queue, job_id)["result"]["outcome"] == "skipped"
    assert check_ins(empty_queue, user_a) == []


def test_refresh_keeps_actions_and_retracts_cleared_conditions(
    empty_queue: Connection, user_a: FixtureUser
) -> None:
    seeded = november(empty_queue, user_a)
    queue_check_in(empty_queue, user_a)
    run_all(empty_queue)
    election = next(f for f in findings(empty_queue, user_a) if f["kind"] == "election_mismatch")
    empty_queue.execute(
        text(
            "UPDATE check_in_findings SET user_action = 'done', user_action_at = now()"
            " WHERE id = :id"
        ),
        {"id": election["id"]},
    )
    # The goal catches up: 290,000 on 2026-11-16 is on pace.
    make_snapshot(
        empty_queue,
        user_a.id,
        seeded.savings,
        balance_cents=290_000,
        as_of=dt.datetime(2026, 11, 16, 6, tzinfo=dt.UTC),
    )

    queue_check_in(empty_queue, user_a, trigger="sync")
    run_all(empty_queue)

    after = {f["kind"]: f for f in findings(empty_queue, user_a)}
    assert "goal_off_pace" not in after
    assert after["election_mismatch"]["id"] == election["id"]
    assert after["election_mismatch"]["user_action"] == FindingAction.DONE.value
    assert "recurring_new" in after


def test_a_finding_reported_last_month_is_not_repeated(
    empty_queue: Connection, user_a: FixtureUser
) -> None:
    november(empty_queue, user_a)
    queue_check_in(empty_queue, user_a)
    run_all(empty_queue)

    queue_check_in(empty_queue, user_a, period="2026-12-01")
    run_all(empty_queue, now=dt.datetime(2026, 12, 1, 8, tzinfo=dt.UTC))

    december = check_ins(empty_queue, user_a)[1]
    kinds = empty_queue.execute(
        text("SELECT kind::text FROM check_in_findings WHERE check_in_id = :c ORDER BY 1"),
        {"c": december["id"]},
    ).scalars()
    # The stubs and the 401(k) stub are the same; only the goal is judged again.
    assert list(kinds) == ["goal_off_pace"]


def test_a_completed_check_in_is_not_refreshed(
    empty_queue: Connection, user_a: FixtureUser
) -> None:
    november(empty_queue, user_a)
    make_check_in(empty_queue, user_a.id, status=CheckinStatus.COMPLETED, completed_at=NOW)
    job_id = queue_check_in(empty_queue, user_a)
    run_all(empty_queue)
    assert job_row(empty_queue, job_id)["result"]["outcome"] == "skipped"
    assert findings(empty_queue, user_a) == []


def test_a_bad_payload_fails_the_job(empty_queue: Connection, user_a: FixtureUser) -> None:
    job_id = queue_check_in(empty_queue, user_a, period="2026-11-02")
    run_all(empty_queue)
    row = job_row(empty_queue, job_id)
    assert row["status"] == "queued"
    assert "first day" in row["last_error"]


def test_a_job_after_its_month_judges_the_months_last_day(
    empty_queue: Connection, user_a: FixtureUser
) -> None:
    november(empty_queue, user_a)
    queue_check_in(empty_queue, user_a)
    run_all(empty_queue, now=dt.datetime(2027, 1, 5, tzinfo=dt.UTC))
    assert [c["period"] for c in check_ins(empty_queue, user_a)] == [PERIOD]


# ---------------------------------------------------------------- the sync-triggered refresh


def detect(connection: Connection, user: FixtureUser) -> None:
    with user_session_for(user.id, bind=connection) as session:
        queue.enqueue(session, user_id=user.id, kind=JobKind.RECURRING_DETECT)
    Worker(
        handlers={JobKind.RECURRING_DETECT: default_handlers()[JobKind.RECURRING_DETECT]},
        services=Services(clock=lambda: NOW),
        queue_bind=connection,
        user_bind=connection,
    ).run_once()


def test_detect_queues_a_refresh_for_an_open_check_in(
    empty_queue: Connection, user_a: FixtureUser
) -> None:
    make_check_in(empty_queue, user_a.id)

    detect(empty_queue, user_a)
    detect(empty_queue, user_a)

    queued = checkin_jobs(empty_queue)
    assert [(j["payload"], j["status"]) for j in queued] == [
        ({"period": "2026-11-01", "trigger": "sync"}, "queued")
    ]


def test_no_refresh_without_an_open_check_in(
    empty_queue: Connection, user_a: FixtureUser, user_b: FixtureUser
) -> None:
    detect(empty_queue, user_a)
    assert checkin_jobs(empty_queue) == []

    make_check_in(empty_queue, user_a.id, status=CheckinStatus.COMPLETED, completed_at=NOW)
    make_check_in(empty_queue, user_b.id)
    detect(empty_queue, user_a)
    assert checkin_jobs(empty_queue) == []


def test_a_finding_of_another_check_in_does_not_count_as_this_ones(
    empty_queue: Connection, user_a: FixtureUser
) -> None:
    """A key on last month's check-in is reported elsewhere; on this one it is updated."""
    november(empty_queue, user_a)
    current = make_check_in(empty_queue, user_a.id)
    stale = make_finding(empty_queue, user_a.id, current, key="pay_change:stale")
    queue_check_in(empty_queue, user_a, trigger="sync")
    run_all(empty_queue)
    keys = {f["key"] for f in findings(empty_queue, user_a)}
    # An event finding nothing produces any more stays.
    assert "pay_change:stale" in keys
    assert stale in {f["id"] for f in findings(empty_queue, user_a)}
