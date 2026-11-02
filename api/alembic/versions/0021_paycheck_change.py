"""One finding per paycheck change, keyed by the paycheck (spec 015 rules 5, 6,
12 and 13a; issues 194 and 202).

Before this revision a stub that differed from the one before it made a
``pay_change`` (when gross differed) plus one ``deduction_change`` per changed
line, each its own card with its own Done; and every finding about a stub was
keyed by the newest stub's row, so confirming a copy of that paycheck (spec 005
rule 22b) reported all of them again.

The upgrade rewrites each check-in's pay stub findings as the finders write
them now:

* ``pay_change`` and ``deduction_change`` findings whose ``pay_stub_id`` has
  one paycheck id (the first copy of that paycheck) become one ``pay_change``
  keyed ``pay_change:{paycheck_id}``: the newest copy's pay change, or a new
  one built from its two stubs when that copy had only deduction lines, with
  the newest copy's lines in ``deductions``.
* ``election_mismatch`` findings with one calculator, decision and paycheck id
  become the newest of them, keyed by the paycheck id.
* What is left has a user action only when every finding it stands for had
  one (the newest of those actions), so every check-in keeps its status.

Then ``deduction_change`` leaves ``finding_kind``, which is rebuilt (Postgres
cannot drop an enum value). The downgrade writes the lines back as
``deduction_change`` findings, drops the pay changes that only carried lines,
and restores the label; keys and merged findings stay as they are.

No new table or function.

Revision ID: 0021_paycheck_change
Revises: 0020_pay_stub_superseded_by
Create Date: 2026-11-01
"""

import datetime as dt
import json
import uuid
from collections import defaultdict
from collections.abc import Sequence
from typing import Any

import sqlalchemy as sa
from alembic import op

from calc.checkin import change_cents

revision: str = "0021_paycheck_change"
down_revision: str | None = "0020_pay_stub_superseded_by"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

KINDS_BEFORE = (
    "election_mismatch",
    "goal_off_pace",
    "recurring_new",
    "recurring_changed",
    "recurring_stopped",
    "pay_change",
    "deduction_change",
    "upcoming_deadline",
)
KINDS_AFTER = tuple(kind for kind in KINDS_BEFORE if kind != "deduction_change")

# Spec 015 rule 6: the lines in order, and what each affected as its own finding.
LINE_AFFECTS: dict[str, str | None] = {
    "federal_withholding": "w4",
    "state_tax": None,
    "retirement_contribution": "k401_match",
    "medical_premium": "health_plans",
    "other_deductions": None,
}
LINE_ORDER = list(LINE_AFFECTS)

Row = dict[str, Any]


def _rebuild_kinds(labels: tuple[str, ...]) -> None:
    op.execute("ALTER TYPE public.finding_kind RENAME TO finding_kind_old")
    values = ", ".join(f"'{label}'" for label in labels)
    op.execute(f"CREATE TYPE public.finding_kind AS ENUM ({values})")
    op.execute(
        "ALTER TABLE public.check_in_findings ALTER COLUMN kind TYPE public.finding_kind"
        " USING kind::text::public.finding_kind"
    )
    op.execute("DROP TYPE public.finding_kind_old")


def _paycheck_ids(bind: sa.Connection) -> dict[str, str]:
    """Every stub, current or superseded, to the first copy of its paycheck: of
    the stubs leading to the same current stub, the oldest that superseded
    nothing (spec 015, Inputs; ``db/pay_stubs.py:paycheck_ids`` as of 0021)."""
    rows = bind.execute(
        sa.text(
            "SELECT id::text, superseded_by_id::text FROM public.pay_stubs ORDER BY created_at, id"
        )
    ).all()
    successor: dict[str, str | None] = dict(rows)
    superseding = set(successor.values())

    def current(stub: str) -> str:
        while (newer := successor[stub]) is not None:
            stub = newer
        return stub

    first: dict[str, str] = {}
    for stub, _ in rows:
        if stub not in superseding:
            first.setdefault(current(stub), stub)
    return {stub: first[current(stub)] for stub, _ in rows}


def _findings(bind: sa.Connection, kinds: Sequence[str]) -> list[Row]:
    rows = bind.execute(
        sa.text(
            "SELECT id, user_id, check_in_id, kind::text AS kind, severity::text AS severity,"
            " key, decision_id, payload, user_action::text AS user_action, user_action_at,"
            " created_at FROM public.check_in_findings WHERE kind::text = ANY(:kinds)"
            " ORDER BY created_at, id"
        ),
        {"kinds": list(kinds)},
    ).all()
    return [dict(row._mapping) for row in rows]


def _action(group: list[Row]) -> tuple[str | None, dt.datetime | None]:
    """Spec 015 rule 13a.3: handled only when every finding folded in was."""
    if any(row["user_action"] is None for row in group):
        return None, None
    newest = max(group, key=lambda row: row["user_action_at"])
    return newest["user_action"], newest["user_action_at"]


def _delete(bind: sa.Connection, rows: list[Row]) -> None:
    if rows:
        bind.execute(
            sa.text("DELETE FROM public.check_in_findings WHERE id = ANY(:ids)"),
            {"ids": [row["id"] for row in rows]},
        )


def _keep(bind: sa.Connection, row: Row, key: str, payload: Row, group: list[Row]) -> None:
    action, at = _action(group)
    bind.execute(
        sa.text(
            "UPDATE public.check_in_findings SET key = :key, payload = CAST(:payload AS jsonb),"
            " user_action = CAST(:action AS public.finding_action), user_action_at = :at"
            " WHERE id = :id"
        ),
        {"id": row["id"], "key": key, "payload": json.dumps(payload), "action": action, "at": at},
    )


def _stub_amounts(bind: sa.Connection, stub_id: str) -> tuple[int, int]:
    gross, net = bind.execute(
        sa.text("SELECT gross_cents, net_cents FROM public.pay_stubs WHERE id = CAST(:id AS uuid)"),
        {"id": stub_id},
    ).one()
    return int(gross), int(net)


def _new_pay_change(bind: sa.Connection, lines: list[Row], key: str, group: list[Row]) -> None:
    """Rule 13a.1: a pay change for a copy that had only deduction lines."""
    first = lines[0]["payload"]
    gross, net = _stub_amounts(bind, first["pay_stub_id"])
    previous_gross, previous_net = _stub_amounts(bind, first["previous_pay_stub_id"])
    gross_change = change_cents(gross, previous_gross)
    payload = {
        "kind": "pay_change",
        "affects": "w4",
        "pay_stub_id": first["pay_stub_id"],
        "pay_date": first["pay_date"],
        "previous_pay_stub_id": first["previous_pay_stub_id"],
        "previous_pay_date": first["previous_pay_date"],
        "gross_cents": gross,
        "previous_gross_cents": previous_gross,
        "gross_change_cents": gross_change,
        "net_cents": net,
        "previous_net_cents": previous_net,
        "net_change_cents": change_cents(net, previous_net),
        "deductions": _deductions(lines),
    }
    action, at = _action(group)
    bind.execute(
        sa.text(
            "INSERT INTO public.check_in_findings (id, user_id, check_in_id, kind, severity, key,"
            " payload, user_action, user_action_at, created_at) VALUES (:id, :user_id,"
            " :check_in_id, 'pay_change', CAST(:severity AS public.finding_severity), :key,"
            " CAST(:payload AS jsonb), CAST(:action AS public.finding_action), :at, :created_at)"
        ),
        {
            "id": uuid.uuid4(),
            "user_id": lines[0]["user_id"],
            "check_in_id": lines[0]["check_in_id"],
            "severity": "warning" if gross_change < 0 else "info",
            "key": key,
            "payload": json.dumps(payload),
            "action": action,
            "at": at,
            "created_at": group[0]["created_at"],
        },
    )


def _deductions(lines: list[Row]) -> list[Row]:
    ordered = sorted(lines, key=lambda row: LINE_ORDER.index(row["payload"]["line"]))
    return [
        {
            name: row["payload"][name]
            for name in ("line", "label", "amount_cents", "previous_cents", "change_cents")
        }
        for row in ordered
    ]


def _fold_paycheck_changes(bind: sa.Connection, paychecks: dict[str, str]) -> None:
    """Rule 13a.1."""
    groups: dict[tuple[uuid.UUID, str], list[Row]] = defaultdict(list)
    for row in _findings(bind, ("pay_change", "deduction_change")):
        stub = row["payload"].get("pay_stub_id")
        if stub in paychecks:
            groups[(row["check_in_id"], paychecks[stub])].append(row)
    for (_, paycheck), group in groups.items():
        newest_stub = group[-1]["payload"]["pay_stub_id"]
        newest = [row for row in group if row["payload"]["pay_stub_id"] == newest_stub]
        head = next((row for row in newest if row["kind"] == "pay_change"), None)
        lines = [row for row in newest if row["kind"] == "deduction_change"]
        key = f"pay_change:{paycheck}"
        _delete(bind, [row for row in group if row is not head])
        if head is None:
            _new_pay_change(bind, lines, key, group)
        else:
            _keep(bind, head, key, {**head["payload"], "deductions": _deductions(lines)}, group)


def _merge_election_mismatches(bind: sa.Connection, paychecks: dict[str, str]) -> None:
    """Rule 13a.2."""
    groups: dict[tuple[uuid.UUID, str, uuid.UUID | None, str], list[Row]] = defaultdict(list)
    for row in _findings(bind, ("election_mismatch",)):
        payload = row["payload"]
        stub = payload.get("pay_stub_id")
        if stub in paychecks:
            calculator = payload["calculator"]
            groups[(row["check_in_id"], calculator, row["decision_id"], paychecks[stub])].append(
                row
            )
    for (_, calculator, decision, paycheck), group in groups.items():
        newest = group[-1]
        _delete(bind, group[:-1])
        key = f"election_mismatch:{calculator}:{decision}:{paycheck}"
        _keep(bind, newest, key, newest["payload"], group)


def upgrade() -> None:
    bind = op.get_bind()
    paychecks = _paycheck_ids(bind)
    _fold_paycheck_changes(bind, paychecks)
    _merge_election_mismatches(bind, paychecks)
    op.execute("DELETE FROM public.check_in_findings WHERE kind::text = 'deduction_change'")
    _rebuild_kinds(KINDS_AFTER)


def downgrade() -> None:
    _rebuild_kinds(KINDS_BEFORE)
    bind = op.get_bind()
    # Pay changes written since this revision; anything else is left as it is.
    for row in _findings(bind, ("pay_change",)):
        payload = dict(row["payload"])
        if "deductions" not in payload:
            continue
        deductions = payload.pop("deductions")
        stubs = {
            name: payload[name]
            for name in ("pay_stub_id", "pay_date", "previous_pay_stub_id", "previous_pay_date")
        }
        for line in deductions:
            bind.execute(
                sa.text(
                    "INSERT INTO public.check_in_findings (user_id, check_in_id, kind, severity,"
                    " key, payload, user_action, user_action_at, created_at) VALUES (:user_id,"
                    " :check_in_id, 'deduction_change', 'info', :key, CAST(:payload AS jsonb),"
                    " CAST(:action AS public.finding_action), :at, :created_at)"
                ),
                {
                    "user_id": row["user_id"],
                    "check_in_id": row["check_in_id"],
                    "key": f"deduction_change:{payload['pay_stub_id']}:{line['line']}",
                    "payload": json.dumps(
                        {
                            "kind": "deduction_change",
                            "affects": LINE_AFFECTS[line["line"]],
                            **stubs,
                            **line,
                        }
                    ),
                    "action": row["user_action"],
                    "at": row["user_action_at"],
                    "created_at": row["created_at"],
                },
            )
        if payload["gross_change_cents"] == 0:
            _delete(bind, [row])
        else:
            bind.execute(
                sa.text(
                    "UPDATE public.check_in_findings SET payload = CAST(:payload AS jsonb)"
                    " WHERE id = :id"
                ),
                {"id": row["id"], "payload": json.dumps(payload)},
            )
