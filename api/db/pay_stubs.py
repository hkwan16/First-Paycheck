"""The one way to read confirmed pay stubs, and the supersede a confirm runs
(spec 005 rules 22a-22e, issue 190).

A stub is current until a newer confirm of the same paycheck, or of an upload
that replaced its document, supersedes it. Every reader starts from
``current_pay_stubs()``, so a stub confirmed twice counts once;
``tests/unit/test_boundaries.py`` fails on a query of ``PayStub`` anywhere else.
Everything here runs in the caller's user session, under row-level security.
"""

from __future__ import annotations

import datetime as dt
import uuid

from sqlalchemy import Select, Text, Update, and_, func, literal, or_, select, text, update
from sqlalchemy.orm import Session, aliased

from db.models import PAY_STUB_SUPERSEDED_FK, Document, PayStub, employer_key

__all__ = [
    "NEWEST_FIRST",
    "add_confirmed",
    "current_pay_stubs",
    "latest_pay_date",
    "paid_between_count",
]

# GET /pay-stubs order (spec 005 rule 24); id breaks a tie inside one transaction.
NEWEST_FIRST = (PayStub.pay_date.desc(), PayStub.created_at.desc(), PayStub.id.desc())


def _supersede(stub: PayStub) -> Update:
    """Rule 22b: mark the current stub of ``stub``'s paycheck (rule 22a), and the
    current stub of any document ``stub``'s document replaced, directly or along
    a chain of replacements, as superseded by ``stub``."""
    replaced = (
        select(Document.id)
        .where(Document.replaced_by_id == stub.document_id)
        .cte("replaced", recursive=True)
    )
    earlier = aliased(Document)
    replaced = replaced.union(
        select(earlier.id).join(replaced, earlier.replaced_by_id == replaced.c.id)
    )
    same_paycheck = and_(
        PayStub.employer_key == employer_key(literal(stub.employer_name, Text)),
        PayStub.pay_date == stub.pay_date,
        PayStub.period_start == stub.period_start,
        PayStub.period_end == stub.period_end,
    )
    return (
        update(PayStub)
        .where(
            PayStub.superseded_by_id.is_(None),
            or_(same_paycheck, PayStub.document_id.in_(select(replaced.c.id))),
        )
        .values(superseded_by_id=stub.id)
        .execution_options(synchronize_session=False)
    )


def current_pay_stubs() -> Select[PayStub]:
    """The user's stubs nothing superseded (rule 22c); compose filters and order on it."""
    return select(PayStub).where(PayStub.superseded_by_id.is_(None))


def latest_pay_date(session: Session) -> dt.date | None:
    """The newest current stub's pay date: the next pay date's anchor (spec 007 rule 16)."""
    return session.scalar(
        current_pay_stubs().with_only_columns(
            func.max(PayStub.pay_date), maintain_column_froms=True
        )
    )


def paid_between_count(session: Session, first: dt.date, last: dt.date) -> int:
    """How many current stubs were paid from ``first`` to ``last`` (spec 007 rule 26)."""
    count = session.scalar(
        current_pay_stubs()
        .where(PayStub.pay_date.between(first, last))
        .with_only_columns(func.count(), maintain_column_froms=True)
    )
    return int(count or 0)


def add_confirmed(session: Session, stub: PayStub) -> None:
    """Insert a newly confirmed ``stub`` and supersede what it takes the place
    of (rule 22b).

    One user's confirms run one at a time (rule 22c): the advisory lock makes a
    second confirm of a copy wait, then see this one's stub and supersede it,
    rather than collide on ``uq_pay_stubs_current_paycheck``. The old rows are
    marked with the new id before the new row exists (the unique index would
    refuse it while they are current), so the reference is deferred; it is
    checked here, once the new row is flushed, rather than at commit.
    """
    session.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"),
        {"key": f"pay_stubs:{stub.user_id}"},
    )
    stub.id = uuid.uuid4()
    session.execute(_supersede(stub))
    session.add(stub)
    session.flush()
    # IMMEDIATE checks what is pending now; DEFERRED again for any later
    # confirm in the same transaction (tests run several in one).
    session.execute(text(f"SET CONSTRAINTS {PAY_STUB_SUPERSEDED_FK} IMMEDIATE"))
    session.execute(text(f"SET CONSTRAINTS {PAY_STUB_SUPERSEDED_FK} DEFERRED"))
