"""document_status_reason gains ``no_model``.

A worker without a gateway (no ANTHROPIC_API_KEY) hands an uploaded document
to manual entry with this reason instead of failing the job (spec 004 rule
22). Postgres can add an enum value in place; removing one means rebuilding
the type, which the downgrade does after mapping the rows that used it.

Revision ID: 0011_no_model_reason
Revises: 0008_goals_and_birth_year
Create Date: 2026-10-21
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0011_no_model_reason"
down_revision: str | None = "0008_goals_and_birth_year"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

OLD_VALUES = (
    "refused",
    "no_readable_page",
    "budget",
    "extraction_failed",
    "unreadable_file",
    "expired",
)


def upgrade() -> None:
    op.execute("ALTER TYPE document_status_reason ADD VALUE IF NOT EXISTS 'no_model'")


def downgrade() -> None:
    op.execute(
        "UPDATE public.documents SET status_reason = 'extraction_failed' "
        "WHERE status_reason = 'no_model'"
    )
    op.execute("ALTER TYPE document_status_reason RENAME TO document_status_reason_old")
    values = ", ".join(f"'{v}'" for v in OLD_VALUES)
    op.execute(f"CREATE TYPE document_status_reason AS ENUM ({values})")
    op.execute(
        "ALTER TABLE public.documents ALTER COLUMN status_reason TYPE document_status_reason "
        "USING status_reason::text::document_status_reason"
    )
    op.execute("DROP TYPE document_status_reason_old")
