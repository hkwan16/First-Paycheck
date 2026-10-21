"""Row builders for tests. Each one writes as the owning user, under RLS, the
way the API and the worker do, so a builder can never create a row its user
could not create."""

from __future__ import annotations

import datetime as dt
import uuid
from decimal import Decimal
from typing import Any

from sqlalchemy import Connection

from app.db import user_session_for
from db.enums import (
    AccountKind,
    CalculatorKind,
    CalendarKind,
    CategorySource,
    CheckinTrigger,
    DocumentType,
    FindingKind,
    FindingSeverity,
    GoalKind,
    JobKind,
    PayFrequency,
    RecurringCadence,
    SyncProvider,
)
from db.models import (
    Account,
    BalanceSnapshot,
    CalendarEvent,
    CheckIn,
    CheckInFinding,
    Decision,
    Document,
    Goal,
    Holding,
    Job,
    PayStub,
    RecurringCharge,
    SyncItem,
    Transaction,
)
from ingest import store
from sync.categorize import normalize_merchant


def make_item(
    connection: Connection,
    user_id: uuid.UUID,
    *,
    provider_item_id: str | None = None,
    institution_name: str = "First Platypus Bank",
    access_token_enc: bytes = b"not-a-real-ciphertext",
    cursor: str | None = None,
) -> uuid.UUID:
    with user_session_for(user_id, bind=connection) as session:
        item = SyncItem(
            user_id=user_id,
            provider=SyncProvider.PLAID,
            provider_item_id=provider_item_id or f"item-{uuid.uuid4().hex[:12]}",
            institution_name=institution_name,
            access_token_enc=access_token_enc,
            cursor=cursor,
        )
        session.add(item)
        session.flush()
        return item.id


def make_account(
    connection: Connection,
    user_id: uuid.UUID,
    item_id: uuid.UUID,
    *,
    kind: AccountKind = AccountKind.CHECKING,
    name: str = "Plaid Checking",
    provider_account_id: str | None = None,
    mask: str | None = "0000",
    **fields: Any,
) -> uuid.UUID:
    with user_session_for(user_id, bind=connection) as session:
        account = Account(
            user_id=user_id,
            sync_item_id=item_id,
            provider_account_id=provider_account_id or f"acct-{uuid.uuid4().hex[:12]}",
            kind=kind,
            name=name,
            mask=mask,
            **fields,
        )
        session.add(account)
        session.flush()
        return account.id


def make_transaction(
    connection: Connection,
    user_id: uuid.UUID,
    account_id: uuid.UUID,
    *,
    merchant_raw: str = "NETFLIX.COM #1234",
    amount_cents: int = 1599,
    posted_at: dt.date = dt.date(2026, 10, 1),
    category: str | None = None,
    category_source: CategorySource | None = None,
    confidence: Decimal | None = None,
    provider_txn_id: str | None = None,
    pending: bool = False,
) -> uuid.UUID:
    with user_session_for(user_id, bind=connection) as session:
        txn = Transaction(
            pending=pending,
            user_id=user_id,
            account_id=account_id,
            provider_txn_id=provider_txn_id or f"txn-{uuid.uuid4().hex[:12]}",
            posted_at=posted_at,
            amount_cents=amount_cents,
            merchant_raw=merchant_raw,
            merchant_norm=normalize_merchant(merchant_raw),
            category=category,
            category_source=category_source,
            confidence=confidence,
        )
        session.add(txn)
        session.flush()
        return txn.id


def make_snapshot(
    connection: Connection,
    user_id: uuid.UUID,
    account_id: uuid.UUID,
    *,
    balance_cents: int = 100_000,
    as_of: dt.datetime | None = None,
) -> uuid.UUID:
    with user_session_for(user_id, bind=connection) as session:
        snapshot = BalanceSnapshot(
            user_id=user_id,
            account_id=account_id,
            as_of=as_of or dt.datetime(2026, 10, 1, 12, tzinfo=dt.UTC),
            balance_cents=balance_cents,
        )
        session.add(snapshot)
        session.flush()
        return snapshot.id


def make_holding(
    connection: Connection, user_id: uuid.UUID, account_id: uuid.UUID, **fields: Any
) -> uuid.UUID:
    values: dict[str, Any] = {
        "as_of": dt.date(2026, 10, 1),
        "security_id": "sec-vti",
        "name": "Vanguard Total Stock Market ETF",
        "ticker": "VTI",
        "quantity": Decimal("3.5"),
        "value_cents": 98_000,
        "cost_basis_cents": 90_000,
        **fields,
    }
    with user_session_for(user_id, bind=connection) as session:
        holding = Holding(user_id=user_id, account_id=account_id, **values)
        session.add(holding)
        session.flush()
        return holding.id


SAMPLE_PDF = b"%PDF-1.4\n% a stand-in body; factories never parse it\n"


def make_document(
    connection: Connection,
    user_id: uuid.UUID,
    *,
    type: str = "pay_stub",
    data: bytes = SAMPLE_PDF,
    content_type: str = "application/pdf",
    with_blob: bool = True,
    **fields: Any,
) -> uuid.UUID:
    """A ``documents`` row (status ``uploaded`` unless ``fields`` say otherwise),
    with its blob stored through ``ingest.store`` unless ``with_blob`` is False."""
    with user_session_for(user_id, bind=connection) as session:
        document = Document(
            user_id=user_id,
            type=DocumentType(type),
            content_type=content_type,
            size_bytes=len(data),
            **fields,
        )
        session.add(document)
        session.flush()
        if with_blob:
            store.put(
                session,
                document_id=document.id,
                user_id=user_id,
                data=data,
                content_type=content_type,
            )
        return document.id


# The Confirm mockup's stub (spec 005, hand-worked example 1).
MOCKUP_STUB: dict[str, Any] = {
    "employer_name": "Acme Corp",
    "pay_frequency": PayFrequency.SEMIMONTHLY,
    "pay_date": dt.date(2026, 10, 15),
    "period_start": dt.date(2026, 10, 1),
    "period_end": dt.date(2026, 10, 15),
    "gross_cents": 270_833,
    "federal_withholding_cents": 29_776,
    "social_security_cents": 16_792,
    "medicare_cents": 3_927,
    "state_tax_cents": 9_814,
    "retirement_contribution_cents": 0,
    "medical_premium_cents": 6_250,
    "other_deductions_cents": 4_670,
    "net_cents": 199_604,
}


def make_pay_stub(
    connection: Connection, user_id: uuid.UUID, document_id: uuid.UUID, **fields: Any
) -> uuid.UUID:
    with user_session_for(user_id, bind=connection) as session:
        stub = PayStub(user_id=user_id, document_id=document_id, **{**MOCKUP_STUB, **fields})
        session.add(stub)
        session.flush()
        return stub.id


def make_job(
    connection: Connection,
    user_id: uuid.UUID,
    *,
    kind: JobKind = JobKind.CATEGORIZE_RUN,
    payload: dict[str, Any] | None = None,
) -> uuid.UUID:
    with user_session_for(user_id, bind=connection) as session:
        job = Job(user_id=user_id, kind=kind, payload=payload or {})
        session.add(job)
        session.flush()
        return job.id


def make_recurring_charge(
    connection: Connection,
    user_id: uuid.UUID,
    *,
    merchant_norm: str = "netflix.com",
    merchant_clean: str = "NETFLIX.COM",
    cadence: RecurringCadence = RecurringCadence.MONTHLY,
    typical_amount_cents: int = 1549,
    first_seen: dt.date = dt.date(2026, 7, 3),
    last_seen: dt.date = dt.date(2026, 10, 3),
    **fields: Any,
) -> uuid.UUID:
    with user_session_for(user_id, bind=connection) as session:
        charge = RecurringCharge(
            user_id=user_id,
            merchant_norm=merchant_norm,
            merchant_clean=merchant_clean,
            cadence=cadence,
            typical_amount_cents=typical_amount_cents,
            first_seen=first_seen,
            last_seen=last_seen,
            **fields,
        )
        session.add(charge)
        session.flush()
        return charge.id


def make_decision(
    connection: Connection,
    user_id: uuid.UUID,
    calculator: CalculatorKind,
    inputs: dict[str, Any],
    *,
    created_at: dt.datetime,
    result: dict[str, Any] | None = None,
    version: int = 1,
    supersedes_id: uuid.UUID | None = None,
) -> uuid.UUID:
    """A saved decision with a chosen ``created_at``. ``POST /decisions`` is the only
    writer in the product; tests that need a decision of a given date write it here."""
    with user_session_for(user_id, bind=connection) as session:
        decision = Decision(
            user_id=user_id,
            calculator=calculator,
            inputs=inputs,
            result=result or {},
            version=version,
            supersedes_id=supersedes_id,
            created_at=created_at,
        )
        session.add(decision)
        session.flush()
        return decision.id


def make_goal(
    connection: Connection,
    user_id: uuid.UUID,
    *,
    kind: GoalKind = GoalKind.EMERGENCY_FUND,
    target_amount_cents: int = 547_000,
    monthly_contribution_cents: int = 30_000,
    **fields: Any,
) -> uuid.UUID:
    with user_session_for(user_id, bind=connection) as session:
        goal = Goal(
            user_id=user_id,
            kind=kind,
            target_amount_cents=target_amount_cents,
            monthly_contribution_cents=monthly_contribution_cents,
            **fields,
        )
        session.add(goal)
        session.flush()
        return goal.id


def make_check_in(
    connection: Connection,
    user_id: uuid.UUID,
    *,
    period: dt.date = dt.date(2026, 11, 1),
    triggered_by: CheckinTrigger = CheckinTrigger.SCHEDULE,
    **fields: Any,
) -> uuid.UUID:
    with user_session_for(user_id, bind=connection) as session:
        check_in = CheckIn(user_id=user_id, period=period, triggered_by=triggered_by, **fields)
        session.add(check_in)
        session.flush()
        return check_in.id


def make_finding(
    connection: Connection,
    user_id: uuid.UUID,
    check_in_id: uuid.UUID,
    *,
    key: str | None = None,
    kind: FindingKind = FindingKind.PAY_CHANGE,
    severity: FindingSeverity = FindingSeverity.INFO,
    payload: dict[str, Any] | None = None,
    **fields: Any,
) -> uuid.UUID:
    with user_session_for(user_id, bind=connection) as session:
        finding = CheckInFinding(
            user_id=user_id,
            check_in_id=check_in_id,
            kind=kind,
            severity=severity,
            key=key or f"{kind.value}:{uuid.uuid4()}",
            payload=payload or {},
            **fields,
        )
        session.add(finding)
        session.flush()
        return finding.id


def make_calendar_event(
    connection: Connection,
    user_id: uuid.UUID,
    *,
    due_at: dt.date,
    kind: CalendarKind = CalendarKind.GOAL_REVIEW,
    title: str = "Review your emergency fund progress",
    **fields: Any,
) -> uuid.UUID:
    with user_session_for(user_id, bind=connection) as session:
        event = CalendarEvent(user_id=user_id, kind=kind, title=title, due_at=due_at, **fields)
        session.add(event)
        session.flush()
        return event.id
