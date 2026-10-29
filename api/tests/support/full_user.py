"""A user with at least one row in every user-owned table (spec 017 example 1).

``populate_every_table`` writes as the owning user, under RLS, through the
factories and the stores the app uses. ``user_tables`` lists the tables it must
cover from the catalog, so a table added later without a row here makes the
account-deletion test fail instead of passing unchecked.
"""

from __future__ import annotations

import datetime as dt
import uuid
from dataclasses import dataclass
from decimal import Decimal

from pydantic import SecretStr
from sqlalchemy import Connection, column, func, select, table, text

from app import ratelimit
from app.config import get_settings
from app.db import user_session_for
from db.enums import (
    AccountKind,
    CalculatorKind,
    CalendarKind,
    JobKind,
    LlmPurpose,
    LlmStatus,
    PlanKind,
    RuleMatch,
    RuleSource,
)
from db.models import (
    BenefitsChunk,
    BenefitsPlan,
    CategoryRule,
    Explanation,
    LlmCall,
    Profile,
)
from export import store as export_store
from sync.crypto import cipher_from_settings
from tests.support.factories import (
    make_account,
    make_calendar_event,
    make_check_in,
    make_decision,
    make_document,
    make_finding,
    make_goal,
    make_holding,
    make_item,
    make_job,
    make_pay_stub,
    make_recurring_charge,
    make_snapshot,
    make_transaction,
)

NOW = dt.datetime(2026, 10, 21, 15, 0, tzinfo=dt.UTC)
K401_INPUTS = {"contribution_pct": "4.00"}


def user_tables(connection: Connection) -> list[str]:
    """Every base table in ``public`` with a ``user_id`` column."""
    return list(
        connection.execute(
            text(
                "SELECT c.table_name FROM information_schema.columns c"
                " JOIN information_schema.tables t"
                "   ON t.table_schema = c.table_schema AND t.table_name = c.table_name"
                " WHERE c.table_schema = 'public' AND c.column_name = 'user_id'"
                "   AND t.table_type = 'BASE TABLE'"
                " ORDER BY 1"
            )
        ).scalars()
    )


def row_counts(connection: Connection, user_id: uuid.UUID) -> dict[str, int]:
    """Rows ``user_id`` owns in each user table (read as the test's superuser)."""
    counts = {}
    for name in user_tables(connection):
        rows = table(name, column("user_id"), schema="public")
        counts[name] = int(
            connection.execute(
                select(func.count()).select_from(rows).where(rows.c.user_id == user_id)
            ).scalar_one()
        )
    return counts


@dataclass(frozen=True)
class FullUser:
    plaid_token: str
    plaid_item: uuid.UUID
    queued_job: uuid.UUID


def populate_every_table(connection: Connection, user_id: uuid.UUID) -> FullUser:
    """Write at least one row for ``user_id`` in every user table."""
    token = f"access-sandbox-{user_id.hex[:8]}"
    item = make_item(
        connection,
        user_id,
        access_token_enc=cipher_from_settings(get_settings()).encrypt(SecretStr(token)),
    )
    checking = make_account(connection, user_id, item)
    brokerage = make_account(connection, user_id, item, kind=AccountKind.INVESTMENT, name="Broker")
    make_transaction(connection, user_id, checking)
    make_snapshot(connection, user_id, checking)
    make_holding(connection, user_id, brokerage)

    stub_document = make_document(connection, user_id, with_blob=False)
    make_pay_stub(connection, user_id, stub_document)
    replacement = make_document(connection, user_id)  # with its blob
    # Retired by the upload above (spec 004 rule 24): the same-user key must cascade too.
    make_document(connection, user_id, with_blob=False, deleted_at=NOW, replaced_by_id=replacement)
    benefits_document = make_document(connection, user_id, type="benefits", with_blob=False)

    v1 = make_decision(connection, user_id, CalculatorKind.K401_MATCH, K401_INPUTS, created_at=NOW)
    v2 = make_decision(
        connection,
        user_id,
        CalculatorKind.K401_MATCH,
        K401_INPUTS,
        created_at=NOW,
        version=2,
        supersedes_id=v1,
    )
    make_goal(connection, user_id, account_id=checking, decision_id=v2)
    make_calendar_event(
        connection, user_id, due_at=NOW.date(), kind=CalendarKind.ELECTION_CHECK, decision_id=v2
    )
    make_recurring_charge(connection, user_id)
    check_in = make_check_in(connection, user_id)
    make_finding(connection, user_id, check_in)
    queued = make_job(connection, user_id, kind=JobKind.PLAN_EXPORT)

    with user_session_for(user_id, bind=connection) as session:
        session.add(Profile(user_id=user_id, salary_cents=6_500_000))
        session.add(
            CategoryRule(
                user_id=user_id,
                merchant_norm="blue bottle",
                match=RuleMatch.EXACT,
                category="FOOD_AND_DRINK",
                source=RuleSource.USER,
            )
        )
        session.add(
            BenefitsPlan(
                user_id=user_id,
                document_id=benefits_document,
                name="Gold PPO",
                kind=PlanKind.PPO,
                premium_per_period_cents=6_250,
                deductible_cents=50_000,
                oop_max_cents=300_000,
                coinsurance_pct=Decimal("10.00"),
            )
        )
        session.add(
            BenefitsChunk(
                user_id=user_id,
                document_id=benefits_document,
                chunk_index=0,
                text="The plan matches 100% of the first 4% you contribute.",
            )
        )
        session.add(
            Explanation(
                user_id=user_id,
                decision_id=v2,
                attempt=1,
                retries=0,
                concept="employer match",
                text="Contributing 4% earns the full match.",
                prompt_version="explain/v1",
                verified=True,
                fallback=False,
            )
        )
        session.add(
            LlmCall(
                user_id=user_id,
                purpose=LlmPurpose.EXPLAIN,
                model="claude-test",
                prompt_version="explain/v1",
                latency_ms=10,
                status=LlmStatus.OK,
            )
        )
        export_job = make_job(connection, user_id, kind=JobKind.PLAN_EXPORT)
        export_store.put(
            session, job_id=export_job, user_id=user_id, data=b"%PDF-1.7\n", created_at=NOW
        )
        ratelimit.consume(session, user_id, ratelimit.UPLOADS, now=NOW)
    return FullUser(plaid_token=token, plaid_item=item, queued_job=queued)
