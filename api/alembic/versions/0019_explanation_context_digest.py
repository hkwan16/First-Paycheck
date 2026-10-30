"""explanations.context_digest: what an explanation was written from (spec 008
rule 19a, issue 161).

* ``context_digest`` is the SHA-256 (lowercase hex) of the explain context a
  run's drafts were written from and checked against. A read compares it with
  the context the decision would be explained from now; a mismatch makes the
  explanation out of date.
* Null on every row written before this revision: what those were written from
  is unknown, so they read as out of date. Nothing is backfilled.

No new table or function: ``explanations`` keeps the owner policy and grants of
``0004_decisions`` (SELECT, INSERT), which cover the new column. The downgrade
drops the column; explanations then read as they did before issue 161.

Revision ID: 0019_explanation_context_digest
Revises: 0018_check_in_last_run_at
Create Date: 2026-10-30
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0019_explanation_context_digest"
down_revision: str | None = "0018_check_in_last_run_at"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("explanations", sa.Column("context_digest", sa.Text(), nullable=True))
    op.create_check_constraint(
        op.f("ck_explanations_context_digest_sha256"),
        "explanations",
        "context_digest ~ '^[0-9a-f]{64}$'",
    )


def downgrade() -> None:
    op.drop_constraint(op.f("ck_explanations_context_digest_sha256"), "explanations", type_="check")
    op.drop_column("explanations", "context_digest")
