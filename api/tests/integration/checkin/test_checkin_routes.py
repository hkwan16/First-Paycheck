"""GET /check-ins, GET /check-ins/{id}, PATCH a finding and GET /calendar's window
(spec 015 rules 13, 17-19 and 22, route examples)."""

from __future__ import annotations

import datetime as dt
import uuid
from collections.abc import Callable
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import Connection, text

from app.deps import get_now
from db.enums import (
    CalculatorKind,
    CalendarKind,
    FindingAction,
    FindingKind,
    FindingSeverity,
)
from tests.conftest import FixtureUser
from tests.support.factories import (
    make_account,
    make_calendar_event,
    make_check_in,
    make_decision,
    make_finding,
    make_goal,
    make_item,
)
from tests.support.november import EMERGENCY_FUND_INPUTS, HEALTH_INPUTS, K401_INPUTS
from tests.support.sandbox_history import link_sandbox
from tests.support.spending_month import september

Client = Callable[[FixtureUser], TestClient]
NOW = dt.datetime(2026, 10, 21, 15, 0, tzinfo=dt.UTC)
DECIDED_AT = dt.datetime(2026, 8, 20, tzinfo=dt.UTC)


@pytest.fixture
def frozen(app: FastAPI) -> FastAPI:
    app.dependency_overrides[get_now] = lambda: NOW
    return app


def finding_payload(kind: FindingKind) -> dict[str, object]:
    """A stored payload of ``kind`` as the engine writes it."""
    if kind is FindingKind.PAY_CHANGE:
        return {
            "kind": "pay_change",
            "affects": "w4",
            "pay_stub_id": str(uuid.uuid4()),
            "pay_date": "2026-09-30",
            "previous_pay_stub_id": str(uuid.uuid4()),
            "previous_pay_date": "2026-09-15",
            "gross_cents": 291_667,
            "previous_gross_cents": 270_833,
            "gross_change_cents": 20_834,
            "net_cents": 218_845,
            "previous_net_cents": 199_604,
            "net_change_cents": 19_241,
        }
    return {
        "kind": "upcoming_deadline",
        "affects": "emergency_fund",
        "calendar_event_id": str(uuid.uuid4()),
        "calendar_kind": "goal_review",
        "title": "Review your emergency fund progress",
        "due_at": "2026-10-30",
        "days_until": 9,
    }


def add_finding(
    connection: Connection,
    user: FixtureUser,
    check_in: uuid.UUID,
    kind: FindingKind = FindingKind.PAY_CHANGE,
    severity: FindingSeverity = FindingSeverity.INFO,
    **fields: Any,
) -> uuid.UUID:
    return make_finding(
        connection,
        user.id,
        check_in,
        kind=kind,
        severity=severity,
        payload=finding_payload(kind),
        **fields,
    )


# ---------------------------------------------------------------- list and detail


def test_list_check_ins(
    frozen: FastAPI, db_connection: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    september_check_in = make_check_in(db_connection, user_a.id, period=dt.date(2026, 9, 1))
    october = make_check_in(db_connection, user_a.id, period=dt.date(2026, 10, 1))
    add_finding(db_connection, user_a, october)
    add_finding(
        db_connection,
        user_a,
        october,
        FindingKind.UPCOMING_DEADLINE,
        user_action=FindingAction.DONE,
        user_action_at=NOW,
    )

    response = client_as(user_a).get("/check-ins")

    assert response.status_code == 200, response.text
    body = response.json()
    assert [(c["id"], c["period"]) for c in body] == [
        (str(october), "2026-10-01"),
        (str(september_check_in), "2026-09-01"),
    ]
    assert [(c["finding_count"], c["handled_count"]) for c in body] == [(2, 1), (0, 0)]
    assert body[0]["triggered_by"] == "schedule"
    assert body[0]["status"] == "open"


def test_detail_orders_findings_by_severity(
    frozen: FastAPI, db_connection: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    check_in = make_check_in(db_connection, user_a.id, period=dt.date(2026, 10, 1))
    info = add_finding(db_connection, user_a, check_in)
    warning = add_finding(
        db_connection, user_a, check_in, FindingKind.UPCOMING_DEADLINE, FindingSeverity.WARNING
    )

    body = client_as(user_a).get(f"/check-ins/{check_in}").json()

    assert [f["id"] for f in body["findings"]] == [str(warning), str(info)]
    first = body["findings"][0]
    assert first["kind"] == "upcoming_deadline"
    assert first["payload"]["kind"] == "upcoming_deadline"
    assert first["payload"]["days_until"] == 9
    assert first["check_in_id"] == str(check_in)
    assert first["user_action"] is None
    # The month to date: October 1 to the frozen 21st.
    assert (body["cash_flow"]["cash_flow"]["start"], body["cash_flow"]["cash_flow"]["end"]) == (
        "2026-10-01",
        "2026-10-21",
    )


def test_cash_flow_against_the_plan(
    frozen: FastAPI, db_connection: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    # Spec 015 route row 2: spec 007's September beside the saved decisions.
    item = make_item(db_connection, user_a.id)
    september(db_connection, user_a, make_account(db_connection, user_a.id, item))
    make_decision(
        db_connection, user_a.id, CalculatorKind.K401_MATCH, K401_INPUTS, created_at=DECIDED_AT
    )
    make_decision(
        db_connection,
        user_a.id,
        CalculatorKind.HEALTH_PLANS,
        {**HEALTH_INPUTS, "selected_plan_index": 0},
        created_at=DECIDED_AT,
    )
    emergency_fund = make_decision(
        db_connection,
        user_a.id,
        CalculatorKind.EMERGENCY_FUND,
        {**EMERGENCY_FUND_INPUTS, "monthly_essentials_cents": 250_000},
        created_at=DECIDED_AT,
    )
    make_goal(
        db_connection, user_a.id, decision_id=emergency_fund, monthly_contribution_cents=50_000
    )
    check_in = make_check_in(db_connection, user_a.id, period=dt.date(2026, 9, 1))

    response = client_as(user_a).get(f"/check-ins/{check_in}")

    assert response.status_code == 200, response.text
    flow = response.json()["cash_flow"]
    assert (flow["cash_flow"]["start"], flow["cash_flow"]["end"]) == ("2026-09-01", "2026-09-30")
    assert flow["cash_flow"]["withholding"]["paycheck_count"] == 2
    assert flow["cash_flow"]["spending"]["essentials_cents"] == 180_000
    lines = {
        line["key"]: (line["actual_cents"], line["plan_cents"], line["difference_cents"])
        for line in flow["plan"]
    }
    assert lines == {
        "take_home": (399_208, None, None),
        "essentials": (180_000, 250_000, -70_000),
        "flexible": (8_500, None, None),
        "other": (3_900, None, None),
        "savings": (40_000, 50_000, -10_000),
        "retirement": (0, 21_667, -21_667),
        "health": (12_500, 12_500, 0),
        "left_over": (166_808, None, None),
    }
    # Rule 19a: which side of the plan each line is on, null without a plan.
    assert {line["key"]: line["status"] for line in flow["plan"]} == {
        "take_home": None,
        "essentials": "under",
        "flexible": None,
        "other": None,
        "savings": "under",
        "retirement": "under",
        "health": "on_plan",
        "left_over": None,
    }


def test_take_home_counts_money_in_only(
    app: FastAPI, seeded_rules: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    # Spec 015 route row 13: the Plaid sandbox's October, where GUSTO PAY is an
    # income-labeled outflow (spec 007 rule 22a). It used to read -584,578. The
    # United Airlines refund is uncategorized (spec 003 rule 3b), so it no longer
    # offsets spending.
    app.dependency_overrides[get_now] = lambda: dt.datetime(2026, 10, 22, 15, 0, tzinfo=dt.UTC)
    link_sandbox(seeded_rules, user_a)
    check_in = make_check_in(seeded_rules, user_a.id, period=dt.date(2026, 10, 1))

    response = client_as(user_a).get(f"/check-ins/{check_in}")

    assert response.status_code == 200, response.text
    lines = {line["key"]: line for line in response.json()["cash_flow"]["plan"]}
    assert lines["take_home"]["label"] == "Take-home pay"
    assert (lines["take_home"]["actual_cents"], lines["left_over"]["actual_cents"]) == (
        422,
        -218_541,
    )


def test_unknown_check_in_is_404(frozen: FastAPI, client_as: Client, user_a: FixtureUser) -> None:
    response = client_as(user_a).get(f"/check-ins/{uuid.uuid4()}")
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"


# ---------------------------------------------------------------- PATCH a finding


def patch(
    client: TestClient, check_in: uuid.UUID, finding: uuid.UUID, action: str | None
) -> dict[str, Any]:
    response = client.patch(
        f"/check-ins/{check_in}/findings/{finding}", json={"user_action": action}
    )
    assert response.status_code == 200, response.text
    body: dict[str, Any] = response.json()
    return body


def check_in_state(connection: Connection, check_in: uuid.UUID) -> tuple[str, bool]:
    row = connection.execute(
        text("SELECT status::text, completed_at IS NOT NULL FROM check_ins WHERE id = :id"),
        {"id": check_in},
    ).one()
    return row[0], row[1]


def test_patch_done_dismissed_and_undo(
    frozen: FastAPI, db_connection: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    check_in = make_check_in(db_connection, user_a.id, period=dt.date(2026, 10, 1))
    first = add_finding(db_connection, user_a, check_in)
    second = add_finding(db_connection, user_a, check_in, FindingKind.UPCOMING_DEADLINE)
    client = client_as(user_a)

    done = patch(client, check_in, first, "done")
    assert (done["user_action"], done["user_action_at"]) == ("done", "2026-10-21T15:00:00Z")
    assert check_in_state(db_connection, check_in) == ("open", False)

    patch(client, check_in, second, "dismissed")
    assert check_in_state(db_connection, check_in) == ("completed", True)

    undone = patch(client, check_in, first, None)
    assert (undone["user_action"], undone["user_action_at"]) == (None, None)
    assert check_in_state(db_connection, check_in) == ("open", False)


def test_the_same_action_again_changes_nothing(
    frozen: FastAPI, app: FastAPI, db_connection: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    check_in = make_check_in(db_connection, user_a.id, period=dt.date(2026, 10, 1))
    finding = add_finding(db_connection, user_a, check_in)
    client = client_as(user_a)
    patch(client, check_in, finding, "done")
    app.dependency_overrides[get_now] = lambda: NOW + dt.timedelta(hours=1)
    assert patch(client, check_in, finding, "done")["user_action_at"] == "2026-10-21T15:00:00Z"


def test_patch_validation_and_404(
    frozen: FastAPI, db_connection: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    check_in = make_check_in(db_connection, user_a.id, period=dt.date(2026, 10, 1))
    other = make_check_in(db_connection, user_a.id, period=dt.date(2026, 9, 1))
    finding = add_finding(db_connection, user_a, check_in)
    client = client_as(user_a)
    path = f"/check-ins/{check_in}/findings/{finding}"

    assert client.patch(path, json={"user_action": "acted"}).status_code == 422
    assert client.patch(path, json={"user_action": "done", "note": "x"}).status_code == 422
    assert client.patch(path, json={}).status_code == 422
    wrong = client.patch(f"/check-ins/{other}/findings/{finding}", json={"user_action": "done"})
    assert wrong.status_code == 404
    assert wrong.json()["error"]["code"] == "not_found"


# ---------------------------------------------------------------- GET /calendar window


def test_calendar_window(
    frozen: FastAPI, db_connection: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    for due in ("2026-10-30", "2026-11-20", "2027-01-31"):
        make_calendar_event(
            db_connection,
            user_a.id,
            due_at=dt.date.fromisoformat(due),
            kind=CalendarKind.TAX_SEASON,
        )
    client = client_as(user_a)

    def dues(**params: str) -> list[str]:
        response = client.get("/calendar", params=params)
        assert response.status_code == 200, response.text
        return [event["due_at"] for event in response.json()]

    assert dues() == ["2026-10-30", "2026-11-20", "2027-01-31"]
    assert dues(**{"from": "2026-11-01"}) == ["2026-11-20", "2027-01-31"]
    assert dues(to="2026-11-30") == ["2026-10-30", "2026-11-20"]
    assert dues(**{"from": "2026-11-01", "to": "2026-11-30"}) == ["2026-11-20"]
    assert dues(**{"from": "2026-11-20", "to": "2026-11-20"}) == ["2026-11-20"]
    backwards = client.get("/calendar", params={"from": "2026-12-01", "to": "2026-11-01"})
    assert backwards.status_code == 422
