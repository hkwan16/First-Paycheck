"""documents.review_draft: progress through a Confirm review survives a reload
(spec 005 rules 23c-23e, issue 229).

* ``review_draft`` is null until ``PUT /docs/{id}/review`` saves what the
  person has entered and confirmed so far (``{"fields": [...]}``), and null
  again once the document is confirmed, replaced, read again or expired. It is
  not confirmed data: only ``POST /docs/{id}/confirm`` writes a pay stub or
  plans, from its own body.
* ``jsonb_typeof(review_draft) = 'object'``, like ``proposal``: clearing it
  writes SQL NULL, never JSON null.

No new table or function: ``documents`` keeps the owner policy and grants of
``0003_documents`` (SELECT, INSERT, UPDATE), which cover the new column. The
downgrade drops the column; a review in progress then starts again from the
proposal, as it did before this revision.

Revision ID: 0022_document_review_draft
Revises: 0021_paycheck_change
Create Date: 2026-11-09
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0022_document_review_draft"
down_revision: str | None = "0021_paycheck_change"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "documents",
        sa.Column("review_draft", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    )
    op.create_check_constraint(
        op.f("ck_documents_review_draft_object"),
        "documents",
        "jsonb_typeof(review_draft) = 'object'",
    )


def downgrade() -> None:
    op.drop_constraint(op.f("ck_documents_review_draft_object"), "documents", type_="check")
    op.drop_column("documents", "review_draft")
