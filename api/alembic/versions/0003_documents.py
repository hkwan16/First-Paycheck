"""Documents: uploads, their raw bytes, confirmed pay stubs, benefits plans and
benefits text chunks, plus the per-user rate-limit counters (specs 001, 004, 005).

Every table is under the owner policy from ``db.rls.enable_rls`` with grants
trimmed to what the API and the worker do:

* ``documents``: no DELETE. A document row outlives its bytes.
* ``document_blobs``: SELECT, INSERT, DELETE. Only ``ingest/store.py`` uses it.
* ``pay_stubs`` and ``benefits_chunks``: append-only (SELECT, INSERT).
* ``benefits_plans``: full, for hand-entered plans later.
* ``rate_limit_counters``: SELECT, INSERT, UPDATE (the upsert).

Retention (``store.expire_unconfirmed``) runs on the privileged connection.
Enum values are literal so this revision never changes when ``db/enums.py`` grows.

Revision ID: 0003_documents
Revises: 0006_webhook_fn
Create Date: 2026-10-21
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

from db.rls import enable_rls

revision: str = "0003_documents"
down_revision: str | None = "0006_webhook_fn"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

ENUMS: dict[str, tuple[str, ...]] = {
    "document_type": ("pay_stub", "offer_letter", "benefits"),
    "document_status": (
        "uploaded",
        "extracting",
        "proposed",
        "confirmed",
        "manual_entry_required",
        "failed",
    ),
    "document_status_reason": (
        "refused",
        "no_readable_page",
        "budget",
        "extraction_failed",
        "unreadable_file",
        "expired",
    ),
    "plan_kind": ("hdhp", "ppo", "hmo"),
}

PRIVILEGES: dict[str, tuple[str, ...]] = {
    "documents": ("SELECT", "INSERT", "UPDATE"),
    "document_blobs": ("SELECT", "INSERT", "DELETE"),
    "pay_stubs": ("SELECT", "INSERT"),
    "benefits_plans": ("SELECT", "INSERT", "UPDATE", "DELETE"),
    "benefits_chunks": ("SELECT", "INSERT"),
    "rate_limit_counters": ("SELECT", "INSERT", "UPDATE"),
}

UPDATED_AT_TABLES = ("documents", "benefits_plans")

PAY_STUB_BALANCES = (
    "gross_cents - federal_withholding_cents - social_security_cents - medicare_cents"
    " - state_tax_cents - retirement_contribution_cents - medical_premium_cents"
    " - other_deductions_cents = net_cents"
)


def upgrade() -> None:
    for name, values in ENUMS.items():
        postgresql.ENUM(*values, name=name).create(op.get_bind())
    _create_tables()
    for table in UPDATED_AT_TABLES:
        op.execute(
            f"CREATE TRIGGER {table}_set_updated_at BEFORE UPDATE ON public.{table}"
            " FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()"
        )
    for table, privileges in PRIVILEGES.items():
        enable_rls(table, privileges=privileges)


def _create_tables() -> None:
    op.create_table(
        "rate_limit_counters",
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("bucket", sa.Text(), nullable=False),
        sa.Column("window_start", sa.DateTime(timezone=True), nullable=False),
        sa.Column("count", sa.Integer(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint("count > 0", name=op.f("ck_rate_limit_counters_count_positive")),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["auth.users.id"],
            name=op.f("fk_rate_limit_counters_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint(
            "user_id", "bucket", "window_start", name=op.f("pk_rate_limit_counters")
        ),
    )
    op.create_table(
        "documents",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column(
            "type",
            postgresql.ENUM(
                "pay_stub", "offer_letter", "benefits", name="document_type", create_type=False
            ),
            nullable=False,
        ),
        sa.Column(
            "status",
            postgresql.ENUM(
                "uploaded",
                "extracting",
                "proposed",
                "confirmed",
                "manual_entry_required",
                "failed",
                name="document_status",
                create_type=False,
            ),
            server_default=sa.text("'uploaded'"),
            nullable=False,
        ),
        sa.Column(
            "status_reason",
            postgresql.ENUM(
                "refused",
                "no_readable_page",
                "budget",
                "extraction_failed",
                "unreadable_file",
                "expired",
                name="document_status_reason",
                create_type=False,
            ),
            nullable=True,
        ),
        sa.Column("content_type", sa.Text(), nullable=False),
        sa.Column("size_bytes", sa.Integer(), nullable=False),
        sa.Column("page_count", sa.Integer(), nullable=True),
        sa.Column("proposal", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("extract_job_id", sa.Uuid(), nullable=True),
        sa.Column("redaction_count", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column("confirmed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "(status = 'confirmed') = (confirmed_at IS NOT NULL)",
            name=op.f("ck_documents_confirmed_at_when_confirmed"),
        ),
        sa.CheckConstraint(
            "(status IN ('failed', 'manual_entry_required')) = (status_reason IS NOT NULL)",
            name=op.f("ck_documents_status_reason_when_stuck"),
        ),
        sa.CheckConstraint(
            "content_type IN ('application/pdf', 'image/png', 'image/jpeg')",
            name=op.f("ck_documents_content_type_allowed"),
        ),
        sa.CheckConstraint(
            "jsonb_typeof(proposal) = 'object'", name=op.f("ck_documents_proposal_object")
        ),
        sa.CheckConstraint("page_count > 0", name=op.f("ck_documents_page_count_positive")),
        sa.CheckConstraint(
            "redaction_count >= 0", name=op.f("ck_documents_redaction_count_non_negative")
        ),
        sa.CheckConstraint("size_bytes > 0", name=op.f("ck_documents_size_positive")),
        sa.ForeignKeyConstraint(
            ["extract_job_id"],
            ["jobs.id"],
            name=op.f("fk_documents_extract_job_id_jobs"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["auth.users.id"],
            name=op.f("fk_documents_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_documents")),
        sa.UniqueConstraint("id", "user_id", name=op.f("uq_documents_id_user_id")),
    )
    op.create_index(
        "ix_documents_user_created", "documents", ["user_id", "created_at"], unique=False
    )
    op.create_table(
        "benefits_chunks",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("document_id", sa.Uuid(), nullable=False),
        sa.Column("chunk_index", sa.Integer(), nullable=False),
        sa.Column("text", sa.Text(), nullable=False),
        sa.Column(
            "search",
            postgresql.TSVECTOR(),
            sa.Computed("to_tsvector('english'::regconfig, text)", persisted=True),
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "chunk_index >= 0", name=op.f("ck_benefits_chunks_chunk_index_non_negative")
        ),
        sa.ForeignKeyConstraint(
            ["document_id", "user_id"],
            ["documents.id", "documents.user_id"],
            name=op.f("fk_benefits_chunks_document_id_documents"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["auth.users.id"],
            name=op.f("fk_benefits_chunks_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_benefits_chunks")),
        sa.UniqueConstraint(
            "document_id", "chunk_index", name=op.f("uq_benefits_chunks_document_id_chunk_index")
        ),
    )
    op.create_index(
        "ix_benefits_chunks_search",
        "benefits_chunks",
        ["search"],
        unique=False,
        postgresql_using="gin",
    )
    op.create_table(
        "benefits_plans",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("document_id", sa.Uuid(), nullable=True),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column(
            "kind",
            postgresql.ENUM("hdhp", "ppo", "hmo", name="plan_kind", create_type=False),
            nullable=False,
        ),
        sa.Column("premium_per_period_cents", sa.BigInteger(), nullable=False),
        sa.Column("deductible_cents", sa.BigInteger(), nullable=False),
        sa.Column("oop_max_cents", sa.BigInteger(), nullable=False),
        sa.Column("coinsurance_pct", sa.Numeric(precision=5, scale=2), nullable=False),
        sa.Column(
            "employer_hsa_cents", sa.BigInteger(), server_default=sa.text("0"), nullable=False
        ),
        sa.Column("enrollment_deadline", sa.Date(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint("name <> ''", name=op.f("ck_benefits_plans_name_not_empty")),
        sa.CheckConstraint(
            "coinsurance_pct BETWEEN 0 AND 100", name=op.f("ck_benefits_plans_coinsurance_range")
        ),
        sa.CheckConstraint(
            "deductible_cents <= oop_max_cents",
            name=op.f("ck_benefits_plans_deductible_within_oop_max"),
        ),
        sa.CheckConstraint(
            "deductible_cents >= 0", name=op.f("ck_benefits_plans_deductible_non_negative")
        ),
        sa.CheckConstraint(
            "employer_hsa_cents >= 0", name=op.f("ck_benefits_plans_employer_hsa_non_negative")
        ),
        sa.CheckConstraint(
            "oop_max_cents >= 0", name=op.f("ck_benefits_plans_oop_max_non_negative")
        ),
        sa.CheckConstraint(
            "premium_per_period_cents >= 0", name=op.f("ck_benefits_plans_premium_non_negative")
        ),
        sa.ForeignKeyConstraint(
            ["document_id", "user_id"],
            ["documents.id", "documents.user_id"],
            name=op.f("fk_benefits_plans_document_id_documents"),
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["auth.users.id"],
            name=op.f("fk_benefits_plans_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_benefits_plans")),
    )
    op.create_index("ix_benefits_plans_user_id", "benefits_plans", ["user_id"], unique=False)
    op.create_table(
        "document_blobs",
        sa.Column("document_id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("bytes", sa.LargeBinary(), nullable=False),
        sa.Column("content_type", sa.Text(), nullable=False),
        sa.Column("size_bytes", sa.Integer(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "content_type IN ('application/pdf', 'image/png', 'image/jpeg')",
            name=op.f("ck_document_blobs_content_type_allowed"),
        ),
        sa.CheckConstraint(
            "size_bytes = octet_length(bytes)", name=op.f("ck_document_blobs_size_matches_bytes")
        ),
        sa.CheckConstraint("size_bytes > 0", name=op.f("ck_document_blobs_size_positive")),
        sa.ForeignKeyConstraint(
            ["document_id", "user_id"],
            ["documents.id", "documents.user_id"],
            name=op.f("fk_document_blobs_document_id_documents"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["auth.users.id"],
            name=op.f("fk_document_blobs_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("document_id", name=op.f("pk_document_blobs")),
    )
    op.create_table(
        "pay_stubs",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("document_id", sa.Uuid(), nullable=False),
        sa.Column("employer_name", sa.Text(), nullable=True),
        sa.Column(
            "pay_frequency",
            postgresql.ENUM(
                "weekly",
                "biweekly",
                "semimonthly",
                "monthly",
                name="pay_frequency",
                create_type=False,
            ),
            nullable=True,
        ),
        sa.Column("pay_date", sa.Date(), nullable=False),
        sa.Column(
            "tax_year",
            sa.SmallInteger(),
            sa.Computed("(EXTRACT(year FROM pay_date))::smallint", persisted=True),
            nullable=False,
        ),
        sa.Column("period_start", sa.Date(), nullable=False),
        sa.Column("period_end", sa.Date(), nullable=False),
        sa.Column("gross_cents", sa.BigInteger(), nullable=False),
        sa.Column(
            "federal_withholding_cents",
            sa.BigInteger(),
            server_default=sa.text("0"),
            nullable=False,
        ),
        sa.Column(
            "social_security_cents", sa.BigInteger(), server_default=sa.text("0"), nullable=False
        ),
        sa.Column("medicare_cents", sa.BigInteger(), server_default=sa.text("0"), nullable=False),
        sa.Column("state_tax_cents", sa.BigInteger(), server_default=sa.text("0"), nullable=False),
        sa.Column(
            "retirement_contribution_cents",
            sa.BigInteger(),
            server_default=sa.text("0"),
            nullable=False,
        ),
        sa.Column(
            "medical_premium_cents", sa.BigInteger(), server_default=sa.text("0"), nullable=False
        ),
        sa.Column(
            "other_deductions_cents", sa.BigInteger(), server_default=sa.text("0"), nullable=False
        ),
        sa.Column("net_cents", sa.BigInteger(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "federal_withholding_cents >= 0",
            name=op.f("ck_pay_stubs_federal_withholding_non_negative"),
        ),
        sa.CheckConstraint(
            PAY_STUB_BALANCES,
            name=op.f("ck_pay_stubs_pay_stub_balances"),
        ),
        sa.CheckConstraint("gross_cents > 0", name=op.f("ck_pay_stubs_gross_positive")),
        sa.CheckConstraint(
            "medical_premium_cents >= 0", name=op.f("ck_pay_stubs_medical_premium_non_negative")
        ),
        sa.CheckConstraint("medicare_cents >= 0", name=op.f("ck_pay_stubs_medicare_non_negative")),
        sa.CheckConstraint("net_cents >= 0", name=op.f("ck_pay_stubs_net_non_negative")),
        sa.CheckConstraint(
            "other_deductions_cents >= 0", name=op.f("ck_pay_stubs_other_deductions_non_negative")
        ),
        sa.CheckConstraint("period_start <= period_end", name=op.f("ck_pay_stubs_period_ordered")),
        sa.CheckConstraint(
            "retirement_contribution_cents >= 0",
            name=op.f("ck_pay_stubs_retirement_contribution_non_negative"),
        ),
        sa.CheckConstraint(
            "social_security_cents >= 0", name=op.f("ck_pay_stubs_social_security_non_negative")
        ),
        sa.CheckConstraint(
            "state_tax_cents >= 0", name=op.f("ck_pay_stubs_state_tax_non_negative")
        ),
        sa.ForeignKeyConstraint(
            ["document_id", "user_id"],
            ["documents.id", "documents.user_id"],
            name=op.f("fk_pay_stubs_document_id_documents"),
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["auth.users.id"],
            name=op.f("fk_pay_stubs_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_pay_stubs")),
        sa.UniqueConstraint("document_id", name=op.f("uq_pay_stubs_document_id")),
    )
    op.create_index(
        "ix_pay_stubs_user_pay_date", "pay_stubs", ["user_id", "pay_date"], unique=False
    )


def downgrade() -> None:
    # Dropping a table drops its indexes, triggers and policies with it.
    for table in (
        "pay_stubs",
        "document_blobs",
        "benefits_plans",
        "benefits_chunks",
        "documents",
        "rate_limit_counters",
    ):
        op.drop_table(table)
    for name in reversed(ENUMS):
        postgresql.ENUM(name=name).drop(op.get_bind())
