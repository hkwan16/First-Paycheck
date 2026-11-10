"""Confirming the same pay stub more than once, through the confirm route (issue 190).

``confirm_stub`` makes a ``proposed`` pay stub document with its file and
confirms it with ``POST /docs/{id}/confirm``, the way a person does after the
worker read it; ``replace`` retires a document for another the way ``POST /docs``
with ``replaces`` does (spec 004 rules 24-25). The stubs are the Acme stub
(spec 005 rules 22a-22e, hand-worked examples "One stub per paycheck") unless a
test says otherwise.
"""

from __future__ import annotations

import uuid
from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy import Connection, text

from app.db import user_session_for
from db.enums import DocumentStatus
from tests.conftest import FixtureUser
from tests.support.factories import make_document

# The Acme stub as the Confirm screen sends it: paid 2026-10-15 for October 1-15.
ACME: dict[str, Any] = {
    "employer_name": "Acme Corp",
    "pay_frequency": "semimonthly",
    "pay_date": "2026-10-15",
    "period_start": "2026-10-01",
    "period_end": "2026-10-15",
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

# The synthetic stub-01 (tests/support/factories.py:STUB_01) as Confirm sends it:
# $3,653.85 every two weeks, paid 2026-04-10; 9,500,010 a year (spec 005 rule 24a).
STUB_01: dict[str, Any] = {
    "employer_name": "Acme Corp",
    "pay_frequency": "biweekly",
    "pay_date": "2026-04-10",
    "period_start": "2026-03-23",
    "period_end": "2026-04-05",
    "gross_cents": 365_385,
    "federal_withholding_cents": 27_244,
    "social_security_cents": 22_654,
    "medicare_cents": 5_298,
    "state_tax_cents": 16_442,
    "retirement_contribution_cents": 10_962,
    "medical_premium_cents": 2_500,
    "other_deductions_cents": 5_199,
    "net_cents": 275_086,
}

# A stub confirmed with the wrong pay period (the second half of October), which
# a Replace then corrects to ACME; before issue 190 it was the newest of the two.
LATE_OCTOBER: dict[str, Any] = {
    **ACME,
    "pay_date": "2026-10-31",
    "period_start": "2026-10-16",
    "period_end": "2026-10-31",
    "gross_cents": 300_000,
    # 5.00% to the 401(k), where ACME shows 0.00%.
    "retirement_contribution_cents": 15_000,
    # 300,000 - (71,229 of ACME's deductions + 15,000).
    "net_cents": 213_771,
}


def proposed_document(connection: Connection, user: FixtureUser) -> uuid.UUID:
    """A pay stub document the worker has read: ``proposed``, with its file."""
    return make_document(connection, user.id, status=DocumentStatus.PROPOSED, proposal={})


def confirm(client: TestClient, document_id: uuid.UUID, **fields: Any) -> uuid.UUID:
    """Confirm the document with the Acme stub's values (``fields`` override them)."""
    response = client.post(f"/docs/{document_id}/confirm", json={"pay_stub": {**ACME, **fields}})
    assert response.status_code == 200, response.text
    return uuid.UUID(response.json()["pay_stub"]["id"])


def confirm_stub(
    client: TestClient, connection: Connection, user: FixtureUser, **fields: Any
) -> uuid.UUID:
    """Upload-and-confirm in one step: a new document, confirmed; the new stub's id."""
    return confirm(client, proposed_document(connection, user), **fields)


def replace(connection: Connection, user: FixtureUser, old: uuid.UUID, new: uuid.UUID) -> None:
    """Retire ``old`` for ``new`` as ``POST /docs`` with ``replaces = old`` does."""
    with user_session_for(user.id, bind=connection) as session:
        session.execute(
            text(
                "UPDATE documents SET replaced_by_id = :new,"
                " deleted_at = coalesce(deleted_at, now()) WHERE id = :old"
            ),
            {"old": old, "new": new},
        )


def document_of(connection: Connection, stub_id: uuid.UUID) -> uuid.UUID:
    """The document a stub was confirmed from."""
    return uuid.UUID(
        str(
            connection.execute(
                text("SELECT document_id FROM pay_stubs WHERE id = :id"), {"id": stub_id}
            ).scalar_one()
        )
    )


def replaced_late_october(
    client: TestClient, connection: Connection, user: FixtureUser, **fields: Any
) -> tuple[uuid.UUID, uuid.UUID]:
    """LATE_OCTOBER confirmed, then replaced by an upload confirmed as ACME.

    Returns ``(old, new)``. The old stub has the later pay date, so before
    issue 190 it was "the newest stub" every newest-stub reader picked.
    ``fields`` change both stubs (another pay schedule, say).
    """
    old = confirm_stub(client, connection, user, **{**LATE_OCTOBER, **fields})
    document = proposed_document(connection, user)
    replace(connection, user, document_of(connection, old), document)
    return old, confirm(client, document, **fields)
