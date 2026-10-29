"""documents.replaced_by_id: a replacement upload retires the document it
replaces (spec 004 rules 24-31).

* ``replaced_by_id`` is null until ``POST /docs`` with ``replaces`` names the
  document; then it holds the new document's id. ``GET /docs`` lists only
  documents where it is null.
* ``(replaced_by_id, user_id)`` references ``documents (id, user_id)``, so a
  document is only ever replaced by one of the same user's, even on a
  connection that bypasses row-level security. NO ACTION on delete: rows are
  deleted only when ``auth.users`` cascades, which removes both ends in one
  statement.
* ``UNIQUE (replaced_by_id)``: an upload replaces at most one document.
* ``replaced_by_id <> id``, and a replaced document has had its file deleted
  (``deleted_at`` set), so retention never acts on it again.

No new table or function: ``documents`` keeps the owner policy and grants of
``0003_documents`` (SELECT, INSERT, UPDATE), which cover the new column. The
downgrade drops the column; replaced documents then list again, with no file.

Revision ID: 0017_document_replaced_by
Revises: 0016_rule_match_contains
Create Date: 2026-10-29
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0017_document_replaced_by"
down_revision: str | None = "0016_rule_match_contains"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("documents", sa.Column("replaced_by_id", sa.Uuid(), nullable=True))
    op.create_foreign_key(
        op.f("fk_documents_replaced_by_id_documents"),
        "documents",
        "documents",
        ["replaced_by_id", "user_id"],
        ["id", "user_id"],
    )
    op.create_unique_constraint(
        op.f("uq_documents_replaced_by_id"), "documents", ["replaced_by_id"]
    )
    op.create_check_constraint(
        op.f("ck_documents_replaced_by_other"), "documents", "replaced_by_id <> id"
    )
    op.create_check_constraint(
        op.f("ck_documents_replaced_means_deleted"),
        "documents",
        "replaced_by_id IS NULL OR deleted_at IS NOT NULL",
    )


def downgrade() -> None:
    op.drop_constraint(op.f("ck_documents_replaced_means_deleted"), "documents", type_="check")
    op.drop_constraint(op.f("ck_documents_replaced_by_other"), "documents", type_="check")
    op.drop_constraint(op.f("uq_documents_replaced_by_id"), "documents", type_="unique")
    op.drop_constraint(
        op.f("fk_documents_replaced_by_id_documents"), "documents", type_="foreignkey"
    )
    op.drop_column("documents", "replaced_by_id")
