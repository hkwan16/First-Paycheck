"""SQLAlchemy models (spec 001). Alembic autogenerate and ``alembic check``
compare against ``Base.metadata``.

Row-level security, grants, triggers and functions are not visible here; they
are written by hand in the migrations. Every user-owned table carries
``user_id`` and is reached only through ``user_session`` (app/db.py).
"""

from __future__ import annotations

import datetime as dt
import uuid
from decimal import Decimal
from typing import Any

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    Column,
    Computed,
    Date,
    DateTime,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    Integer,
    LargeBinary,
    MetaData,
    Numeric,
    SmallInteger,
    Table,
    Text,
    UniqueConstraint,
    Uuid,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, TSVECTOR
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from db.enums import (
    AccountKind,
    AccountRole,
    CalculatorKind,
    CalendarKind,
    CalendarStatus,
    CategorySource,
    CheckinStatus,
    CheckinTrigger,
    DocumentStatus,
    DocumentStatusReason,
    DocumentType,
    FilingStatus,
    FindingAction,
    FindingKind,
    FindingSeverity,
    GoalKind,
    GoalStatus,
    HealthcareUsage,
    JobKind,
    JobStatus,
    LlmPurpose,
    LlmStatus,
    PayFrequency,
    PlanKind,
    RecurringCadence,
    RecurringStatus,
    RecurringUserStatus,
    RuleMatch,
    RuleSource,
    SyncProvider,
    SyncStatus,
    pg_enum,
)

# Deterministic constraint names so autogenerate output is stable.
NAMING_CONVENTION = {
    "ix": "ix_%(column_0_label)s",
    "uq": "uq_%(table_name)s_%(column_0_N_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}


class Base(DeclarativeBase):
    metadata = MetaData(naming_convention=NAMING_CONVENTION)


# Supabase's auth.users, declared only so foreign keys resolve. Migrations
# never create it (tests install a shim) and alembic/env.py excludes the
# auth schema from autogenerate.
AUTH_USERS = Table(
    "users",
    Base.metadata,
    Column("id", Uuid, primary_key=True),
    schema="auth",
)

_NOW = func.now()
_UUID = text("gen_random_uuid()")


def _owner(*, nullable: bool = False) -> Mapped[Any]:
    return mapped_column(Uuid, ForeignKey("auth.users.id", ondelete="CASCADE"), nullable=nullable)


def _created_at() -> Mapped[dt.datetime]:
    return mapped_column(DateTime(timezone=True), server_default=_NOW)


def _updated_at() -> Mapped[dt.datetime]:
    # Maintained by the set_updated_at() trigger.
    return mapped_column(DateTime(timezone=True), server_default=_NOW)


def _id() -> Mapped[uuid.UUID]:
    return mapped_column(Uuid, primary_key=True, server_default=_UUID)


class Profile(Base):
    __tablename__ = "profiles"
    __table_args__ = (
        CheckConstraint("salary_cents > 0", name="salary_positive"),
        CheckConstraint("jsonb_typeof(other_jobs) = 'array'", name="other_jobs_array"),
        CheckConstraint("dependents >= 0", name="dependents_non_negative"),
        CheckConstraint("jsonb_typeof(match_tiers) = 'array'", name="match_tiers_array"),
        CheckConstraint("vesting_years >= 0", name="vesting_years_non_negative"),
        # The upper bound (the current year) is the route's: a CHECK cannot read the clock.
        CheckConstraint("birth_year >= 1900", name="birth_year_after_1900"),
    )

    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("auth.users.id", ondelete="CASCADE"), primary_key=True
    )
    salary_cents: Mapped[int | None] = mapped_column(BigInteger)
    pay_frequency: Mapped[PayFrequency | None] = mapped_column(
        pg_enum(PayFrequency, "pay_frequency")
    )
    filing_status: Mapped[FilingStatus | None] = mapped_column(
        pg_enum(FilingStatus, "filing_status")
    )
    other_jobs: Mapped[list[Any]] = mapped_column(JSONB, server_default=text("'[]'::jsonb"))
    dependents: Mapped[int] = mapped_column(SmallInteger, server_default=text("0"))
    expected_healthcare_usage: Mapped[HealthcareUsage | None] = mapped_column(
        pg_enum(HealthcareUsage, "healthcare_usage")
    )
    start_date: Mapped[dt.date | None] = mapped_column(Date)
    match_tiers: Mapped[list[Any]] = mapped_column(JSONB, server_default=text("'[]'::jsonb"))
    vesting_years: Mapped[int | None] = mapped_column(SmallInteger)
    # Spec 006 open question 2: the client derives age as tax_year - birth_year.
    birth_year: Mapped[int | None] = mapped_column(SmallInteger)
    created_at: Mapped[dt.datetime] = _created_at()
    updated_at: Mapped[dt.datetime] = _updated_at()


class SyncItem(Base):
    __tablename__ = "sync_items"
    __table_args__ = (
        UniqueConstraint("id", "user_id"),
        CheckConstraint(
            "(provider = 'plaid') = (access_token_enc IS NOT NULL)", name="plaid_has_token"
        ),
        Index(
            "uq_sync_items_provider_item",
            "provider",
            "provider_item_id",
            unique=True,
            postgresql_where=text("provider_item_id IS NOT NULL"),
        ),
        Index("ix_sync_items_user_id", "user_id"),
    )

    id: Mapped[uuid.UUID] = _id()
    user_id: Mapped[uuid.UUID] = _owner()
    provider: Mapped[SyncProvider] = mapped_column(pg_enum(SyncProvider, "sync_provider"))
    provider_item_id: Mapped[str | None] = mapped_column(Text)
    institution_name: Mapped[str | None] = mapped_column(Text)
    # Fernet ciphertext (sync/crypto.py). Never returned by any route.
    access_token_enc: Mapped[bytes | None] = mapped_column(LargeBinary)
    cursor: Mapped[str | None] = mapped_column(Text)
    status: Mapped[SyncStatus] = mapped_column(
        pg_enum(SyncStatus, "sync_status"), server_default=text("'active'")
    )
    last_synced_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[dt.datetime] = _created_at()
    updated_at: Mapped[dt.datetime] = _updated_at()


class Account(Base):
    __tablename__ = "accounts"
    __table_args__ = (
        UniqueConstraint("id", "user_id"),
        UniqueConstraint("sync_item_id", "provider_account_id"),
        ForeignKeyConstraint(
            ["sync_item_id", "user_id"],
            ["sync_items.id", "sync_items.user_id"],
            ondelete="CASCADE",
        ),
        CheckConstraint("mask ~ '^[0-9]{2,4}$'", name="mask_digits"),
        Index(
            "uq_accounts_one_emergency_fund",
            "user_id",
            unique=True,
            postgresql_where=text("role = 'emergency_fund'"),
        ),
        Index("ix_accounts_user_id", "user_id"),
    )

    id: Mapped[uuid.UUID] = _id()
    user_id: Mapped[uuid.UUID] = _owner()
    sync_item_id: Mapped[uuid.UUID] = mapped_column(Uuid)
    provider_account_id: Mapped[str] = mapped_column(Text)
    kind: Mapped[AccountKind] = mapped_column(pg_enum(AccountKind, "account_kind"))
    name: Mapped[str] = mapped_column(Text)
    mask: Mapped[str | None] = mapped_column(Text)
    role: Mapped[AccountRole | None] = mapped_column(pg_enum(AccountRole, "account_role"))
    is_active: Mapped[bool] = mapped_column(Boolean, server_default=text("true"))
    created_at: Mapped[dt.datetime] = _created_at()
    updated_at: Mapped[dt.datetime] = _updated_at()


class Transaction(Base):
    __tablename__ = "transactions"
    __table_args__ = (
        UniqueConstraint("account_id", "provider_txn_id"),
        ForeignKeyConstraint(
            ["account_id", "user_id"],
            ["accounts.id", "accounts.user_id"],
            ondelete="CASCADE",
        ),
        CheckConstraint(
            "(category IS NULL) = (category_source IS NULL)",
            name="category_source_set_with_category",
        ),
        CheckConstraint("confidence BETWEEN 0 AND 1", name="confidence_range"),
        CheckConstraint(
            "(category_source IS NOT DISTINCT FROM 'llm') = (confidence IS NOT NULL)",
            name="confidence_only_for_llm",
        ),
        # Cursor pagination reads (user_id, posted_at DESC, id DESC); a b-tree
        # serves that order by scanning this index backwards.
        Index("ix_transactions_user_posted", "user_id", "posted_at", "id"),
        Index("ix_transactions_user_merchant_norm", "user_id", "merchant_norm"),
        Index("ix_transactions_user_category", "user_id", "category"),
    )

    id: Mapped[uuid.UUID] = _id()
    user_id: Mapped[uuid.UUID] = _owner()
    account_id: Mapped[uuid.UUID] = mapped_column(Uuid)
    provider_txn_id: Mapped[str] = mapped_column(Text)
    posted_at: Mapped[dt.date] = mapped_column(Date)
    # > 0 is money out (Plaid's convention, spec 001 rule 21).
    amount_cents: Mapped[int] = mapped_column(BigInteger)
    merchant_raw: Mapped[str] = mapped_column(Text)
    merchant_clean: Mapped[str | None] = mapped_column(Text)
    merchant_norm: Mapped[str] = mapped_column(Text)
    category: Mapped[str | None] = mapped_column(Text)
    category_source: Mapped[CategorySource | None] = mapped_column(
        pg_enum(CategorySource, "category_source")
    )
    confidence: Mapped[Decimal | None] = mapped_column(Numeric(4, 3))
    pending: Mapped[bool] = mapped_column(Boolean, server_default=text("false"))
    created_at: Mapped[dt.datetime] = _created_at()
    updated_at: Mapped[dt.datetime] = _updated_at()


class BalanceSnapshot(Base):
    """Append-only: one row per account per sync."""

    __tablename__ = "balance_snapshots"
    __table_args__ = (
        # Also serves "latest balance per account" by scanning backwards.
        UniqueConstraint("account_id", "as_of"),
        ForeignKeyConstraint(
            ["account_id", "user_id"],
            ["accounts.id", "accounts.user_id"],
            ondelete="CASCADE",
        ),
    )

    id: Mapped[uuid.UUID] = _id()
    user_id: Mapped[uuid.UUID] = _owner()
    account_id: Mapped[uuid.UUID] = mapped_column(Uuid)
    as_of: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True))
    balance_cents: Mapped[int] = mapped_column(BigInteger)
    created_at: Mapped[dt.datetime] = _created_at()


class Holding(Base):
    __tablename__ = "holdings"
    __table_args__ = (
        UniqueConstraint("account_id", "as_of", "security_id"),
        ForeignKeyConstraint(
            ["account_id", "user_id"],
            ["accounts.id", "accounts.user_id"],
            ondelete="CASCADE",
        ),
    )

    id: Mapped[uuid.UUID] = _id()
    user_id: Mapped[uuid.UUID] = _owner()
    account_id: Mapped[uuid.UUID] = mapped_column(Uuid)
    as_of: Mapped[dt.date] = mapped_column(Date)
    security_id: Mapped[str] = mapped_column(Text)
    name: Mapped[str] = mapped_column(Text)
    ticker: Mapped[str | None] = mapped_column(Text)
    quantity: Mapped[Decimal] = mapped_column(Numeric(24, 8))
    value_cents: Mapped[int] = mapped_column(BigInteger)
    cost_basis_cents: Mapped[int | None] = mapped_column(BigInteger)
    created_at: Mapped[dt.datetime] = _created_at()
    updated_at: Mapped[dt.datetime] = _updated_at()


class CategoryRule(Base):
    __tablename__ = "category_rules"
    __table_args__ = (
        UniqueConstraint("user_id", "merchant_norm", "match", postgresql_nulls_not_distinct=True),
        CheckConstraint("merchant_norm <> ''", name="merchant_norm_not_empty"),
        CheckConstraint("(user_id IS NULL) = (source = 'seed')", name="seed_rows_have_no_owner"),
    )

    id: Mapped[uuid.UUID] = _id()
    # NULL for seed rows, which every user can read and none can write.
    user_id: Mapped[uuid.UUID | None] = _owner(nullable=True)
    merchant_norm: Mapped[str] = mapped_column(Text)
    match: Mapped[RuleMatch] = mapped_column(pg_enum(RuleMatch, "rule_match"))
    category: Mapped[str] = mapped_column(Text)
    source: Mapped[RuleSource] = mapped_column(pg_enum(RuleSource, "rule_source"))
    created_at: Mapped[dt.datetime] = _created_at()
    updated_at: Mapped[dt.datetime] = _updated_at()


class Job(Base):
    __tablename__ = "jobs"
    __table_args__ = (
        CheckConstraint(
            "(kind = 'schedule.tick') = (user_id IS NULL)", name="system_jobs_have_no_owner"
        ),
        CheckConstraint("progress BETWEEN 0 AND 100", name="progress_range"),
        CheckConstraint("attempts >= 0", name="attempts_non_negative"),
        Index(
            "uq_jobs_idempotency_key",
            "user_id",
            "idempotency_key",
            unique=True,
            postgresql_where=text("idempotency_key IS NOT NULL"),
        ),
        Index(
            "ix_jobs_queued_run_after",
            "run_after",
            postgresql_where=text("status = 'queued'"),
        ),
        Index(
            "ix_jobs_running_heartbeat",
            "heartbeat_at",
            postgresql_where=text("status = 'running'"),
        ),
        # The parent key of plan_exports' same-user foreign key (0013_plan_export_job).
        UniqueConstraint("id", "user_id"),
    )

    id: Mapped[uuid.UUID] = _id()
    # NULL only for system jobs (schedule.tick).
    user_id: Mapped[uuid.UUID | None] = _owner(nullable=True)
    kind: Mapped[JobKind] = mapped_column(pg_enum(JobKind, "job_kind"))
    status: Mapped[JobStatus] = mapped_column(
        pg_enum(JobStatus, "job_status"), server_default=text("'queued'")
    )
    progress: Mapped[int] = mapped_column(SmallInteger, server_default=text("0"))
    # Ids only: never document bytes, extracted text, tokens or account numbers.
    payload: Mapped[dict[str, Any]] = mapped_column(JSONB, server_default=text("'{}'::jsonb"))
    result: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    last_error: Mapped[str | None] = mapped_column(Text)
    attempts: Mapped[int] = mapped_column(SmallInteger, server_default=text("0"))
    run_after: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), server_default=_NOW)
    heartbeat_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
    started_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
    idempotency_key: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[dt.datetime] = _created_at()
    updated_at: Mapped[dt.datetime] = _updated_at()


class LlmCall(Base):
    """Append-only cost ledger. Counts, cost and status only, never text."""

    __tablename__ = "llm_calls"
    __table_args__ = (
        CheckConstraint("input_tokens >= 0", name="input_tokens_non_negative"),
        CheckConstraint("output_tokens >= 0", name="output_tokens_non_negative"),
        CheckConstraint("cache_read_tokens >= 0", name="cache_read_tokens_non_negative"),
        CheckConstraint("cost_microcents >= 0", name="cost_non_negative"),
        CheckConstraint("latency_ms >= 0", name="latency_non_negative"),
        Index("ix_llm_calls_user_created", "user_id", "created_at"),
    )

    id: Mapped[uuid.UUID] = _id()
    user_id: Mapped[uuid.UUID] = _owner()
    purpose: Mapped[LlmPurpose] = mapped_column(pg_enum(LlmPurpose, "llm_purpose"))
    model: Mapped[str] = mapped_column(Text)
    prompt_version: Mapped[str] = mapped_column(Text)
    input_tokens: Mapped[int] = mapped_column(Integer, server_default=text("0"))
    output_tokens: Mapped[int] = mapped_column(Integer, server_default=text("0"))
    cache_read_tokens: Mapped[int] = mapped_column(Integer, server_default=text("0"))
    # Millionths of a cent.
    cost_microcents: Mapped[int] = mapped_column(BigInteger, server_default=text("0"))
    latency_ms: Mapped[int] = mapped_column(Integer)
    status: Mapped[LlmStatus] = mapped_column(pg_enum(LlmStatus, "llm_status"))
    job_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("jobs.id", ondelete="SET NULL")
    )
    created_at: Mapped[dt.datetime] = _created_at()


class PlanExport(Base):
    """A rendered plan PDF, kept 7 days (spec 016). Only ``export/store.py`` touches it."""

    __tablename__ = "plan_exports"
    __table_args__ = (
        ForeignKeyConstraint(
            ["job_id", "user_id"], ["jobs.id", "jobs.user_id"], ondelete="CASCADE"
        ),
        CheckConstraint("octet_length(bytes) > 0", name="bytes_not_empty"),
        CheckConstraint("content_type = 'application/pdf'", name="content_type_pdf"),
        Index("ix_plan_exports_created_at", "created_at"),
    )

    job_id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True)
    user_id: Mapped[uuid.UUID] = _owner()
    # Named ``data`` in Python so the attribute does not shadow the builtin.
    data: Mapped[bytes] = mapped_column("bytes", LargeBinary)
    content_type: Mapped[str] = mapped_column(Text)
    created_at: Mapped[dt.datetime] = _created_at()


# ---------------------------------------------------------------- documents (0003)

_CONTENT_TYPES = "content_type IN ('application/pdf', 'image/png', 'image/jpeg')"


class Document(Base):
    """One upload, kept after its bytes are deleted (specs 001, 004)."""

    __tablename__ = "documents"
    __table_args__ = (
        UniqueConstraint("id", "user_id"),
        CheckConstraint(_CONTENT_TYPES, name="content_type_allowed"),
        CheckConstraint("size_bytes > 0", name="size_positive"),
        CheckConstraint("redaction_count >= 0", name="redaction_count_non_negative"),
        CheckConstraint("page_count > 0", name="page_count_positive"),
        CheckConstraint(
            "(status = 'confirmed') = (confirmed_at IS NOT NULL)",
            name="confirmed_at_when_confirmed",
        ),
        CheckConstraint(
            "(status IN ('failed', 'manual_entry_required')) = (status_reason IS NOT NULL)",
            name="status_reason_when_stuck",
        ),
        CheckConstraint("jsonb_typeof(proposal) = 'object'", name="proposal_object"),
        # GET /docs reads (user_id, created_at DESC) by scanning this index backwards.
        Index("ix_documents_user_created", "user_id", "created_at"),
    )

    id: Mapped[uuid.UUID] = _id()
    user_id: Mapped[uuid.UUID] = _owner()
    type: Mapped[DocumentType] = mapped_column(pg_enum(DocumentType, "document_type"))
    status: Mapped[DocumentStatus] = mapped_column(
        pg_enum(DocumentStatus, "document_status"), server_default=text("'uploaded'")
    )
    status_reason: Mapped[DocumentStatusReason | None] = mapped_column(
        pg_enum(DocumentStatusReason, "document_status_reason")
    )
    content_type: Mapped[str] = mapped_column(Text)
    size_bytes: Mapped[int] = mapped_column(Integer)
    page_count: Mapped[int | None] = mapped_column(Integer)
    # The reviewable proposal (ingest/proposal.py); redacted text only.
    proposal: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    extract_job_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("jobs.id", ondelete="SET NULL")
    )
    redaction_count: Mapped[int] = mapped_column(Integer, server_default=text("0"))
    confirmed_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
    # Set when the blob is deleted (on confirm or by retention).
    deleted_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[dt.datetime] = _created_at()
    updated_at: Mapped[dt.datetime] = _updated_at()


class DocumentBlob(Base):
    """Raw upload bytes until confirmation. Only ``ingest/store.py`` touches it."""

    __tablename__ = "document_blobs"
    __table_args__ = (
        ForeignKeyConstraint(
            ["document_id", "user_id"],
            ["documents.id", "documents.user_id"],
            ondelete="CASCADE",
        ),
        CheckConstraint(_CONTENT_TYPES, name="content_type_allowed"),
        CheckConstraint("size_bytes = octet_length(bytes)", name="size_matches_bytes"),
        CheckConstraint("size_bytes > 0", name="size_positive"),
    )

    document_id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True)
    user_id: Mapped[uuid.UUID] = _owner()
    # Named ``data`` in Python so the attribute does not shadow the builtin.
    data: Mapped[bytes] = mapped_column("bytes", LargeBinary)
    content_type: Mapped[str] = mapped_column(Text)
    size_bytes: Mapped[int] = mapped_column(Integer)
    created_at: Mapped[dt.datetime] = _created_at()


PAY_STUB_DEDUCTIONS = (
    "federal_withholding_cents",
    "social_security_cents",
    "medicare_cents",
    "state_tax_cents",
    "retirement_contribution_cents",
    "medical_premium_cents",
    "other_deductions_cents",
)


def _deduction() -> Mapped[int]:
    return mapped_column(BigInteger, server_default=text("0"))


class PayStub(Base):
    """Confirmed fields from one pay stub; written only by POST /docs/{id}/confirm."""

    __tablename__ = "pay_stubs"
    __table_args__ = (
        UniqueConstraint("document_id"),
        ForeignKeyConstraint(["document_id", "user_id"], ["documents.id", "documents.user_id"]),
        CheckConstraint("period_start <= period_end", name="period_ordered"),
        CheckConstraint("gross_cents > 0", name="gross_positive"),
        CheckConstraint("net_cents >= 0", name="net_non_negative"),
        *(
            CheckConstraint(f"{column} >= 0", name=f"{column.removesuffix('_cents')}_non_negative")
            for column in PAY_STUB_DEDUCTIONS
        ),
        # The database backstop for the confirm gate (spec amendment 17).
        CheckConstraint(
            "gross_cents - " + " - ".join(PAY_STUB_DEDUCTIONS) + " = net_cents",
            name="pay_stub_balances",
        ),
        # GET /pay-stubs reads (user_id, pay_date DESC) by scanning this index backwards.
        Index("ix_pay_stubs_user_pay_date", "user_id", "pay_date"),
    )

    id: Mapped[uuid.UUID] = _id()
    user_id: Mapped[uuid.UUID] = _owner()
    document_id: Mapped[uuid.UUID] = mapped_column(Uuid)
    employer_name: Mapped[str | None] = mapped_column(Text)
    pay_frequency: Mapped[PayFrequency | None] = mapped_column(
        pg_enum(PayFrequency, "pay_frequency")
    )
    pay_date: Mapped[dt.date] = mapped_column(Date)
    # Spec amendment 13: the tax year follows the pay date.
    tax_year: Mapped[int] = mapped_column(
        SmallInteger, Computed("(EXTRACT(year FROM pay_date))::smallint", persisted=True)
    )
    period_start: Mapped[dt.date] = mapped_column(Date)
    period_end: Mapped[dt.date] = mapped_column(Date)
    gross_cents: Mapped[int] = mapped_column(BigInteger)
    federal_withholding_cents: Mapped[int] = _deduction()
    social_security_cents: Mapped[int] = _deduction()
    medicare_cents: Mapped[int] = _deduction()
    state_tax_cents: Mapped[int] = _deduction()
    retirement_contribution_cents: Mapped[int] = _deduction()
    medical_premium_cents: Mapped[int] = _deduction()
    other_deductions_cents: Mapped[int] = _deduction()
    net_cents: Mapped[int] = mapped_column(BigInteger)
    created_at: Mapped[dt.datetime] = _created_at()


class BenefitsPlan(Base):
    """A confirmed health plan option (from a benefits summary, or typed by hand)."""

    __tablename__ = "benefits_plans"
    __table_args__ = (
        ForeignKeyConstraint(["document_id", "user_id"], ["documents.id", "documents.user_id"]),
        CheckConstraint("name <> ''", name="name_not_empty"),
        CheckConstraint("premium_per_period_cents >= 0", name="premium_non_negative"),
        CheckConstraint("deductible_cents >= 0", name="deductible_non_negative"),
        CheckConstraint("oop_max_cents >= 0", name="oop_max_non_negative"),
        CheckConstraint("deductible_cents <= oop_max_cents", name="deductible_within_oop_max"),
        CheckConstraint("coinsurance_pct BETWEEN 0 AND 100", name="coinsurance_range"),
        CheckConstraint("employer_hsa_cents >= 0", name="employer_hsa_non_negative"),
        CheckConstraint("position >= 0", name="position_non_negative"),
        Index("ix_benefits_plans_user_id", "user_id"),
        Index(
            "uq_benefits_plans_document_position",
            "document_id",
            "position",
            unique=True,
            postgresql_where=text("document_id IS NOT NULL"),
        ),
    )

    id: Mapped[uuid.UUID] = _id()
    user_id: Mapped[uuid.UUID] = _owner()
    # Null when the plan was entered by hand.
    document_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    # The plan's place in its summary's list, from 0 (spec 013 rule 14).
    position: Mapped[int] = mapped_column(SmallInteger, server_default=text("0"))
    name: Mapped[str] = mapped_column(Text)
    kind: Mapped[PlanKind] = mapped_column(pg_enum(PlanKind, "plan_kind"))
    premium_per_period_cents: Mapped[int] = mapped_column(BigInteger)
    deductible_cents: Mapped[int] = mapped_column(BigInteger)
    oop_max_cents: Mapped[int] = mapped_column(BigInteger)
    # The member's share after the deductible, in percent.
    coinsurance_pct: Mapped[Decimal] = mapped_column(Numeric(5, 2))
    employer_hsa_cents: Mapped[int] = mapped_column(BigInteger, server_default=text("0"))
    enrollment_deadline: Mapped[dt.date | None] = mapped_column(Date)
    created_at: Mapped[dt.datetime] = _created_at()
    updated_at: Mapped[dt.datetime] = _updated_at()


class BenefitsChunk(Base):
    """Redacted benefits text in 400-word chunks, searchable by Postgres full text."""

    __tablename__ = "benefits_chunks"
    __table_args__ = (
        UniqueConstraint("document_id", "chunk_index"),
        ForeignKeyConstraint(
            ["document_id", "user_id"],
            ["documents.id", "documents.user_id"],
            ondelete="CASCADE",
        ),
        CheckConstraint("chunk_index >= 0", name="chunk_index_non_negative"),
        Index("ix_benefits_chunks_search", "search", postgresql_using="gin"),
    )

    id: Mapped[uuid.UUID] = _id()
    user_id: Mapped[uuid.UUID] = _owner()
    document_id: Mapped[uuid.UUID] = mapped_column(Uuid)
    chunk_index: Mapped[int] = mapped_column(Integer)
    text: Mapped[str] = mapped_column(Text)
    search: Mapped[str] = mapped_column(
        TSVECTOR, Computed("to_tsvector('english'::regconfig, text)", persisted=True)
    )
    created_at: Mapped[dt.datetime] = _created_at()


class RateLimitCounter(Base):
    """Requests per user, bucket and fixed window (``app/ratelimit.py``)."""

    __tablename__ = "rate_limit_counters"
    __table_args__ = (CheckConstraint("count > 0", name="count_positive"),)

    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("auth.users.id", ondelete="CASCADE"), primary_key=True
    )
    bucket: Mapped[str] = mapped_column(Text, primary_key=True)
    window_start: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), primary_key=True)
    count: Mapped[int] = mapped_column(Integer)
    created_at: Mapped[dt.datetime] = _created_at()


# ---------------------------------------------------------------- decisions (0004)


class Decision(Base):
    """A saved calculator result: append-only and versioned (spec 007).

    ``POST /decisions`` is the only writer. Triggers written in the migration
    check the parent's version and reject every UPDATE and DELETE except the
    cascade from deleting the owner's account. ``current_decisions`` (a view)
    holds the rows nothing supersedes.
    """

    __tablename__ = "decisions"
    __table_args__ = (
        UniqueConstraint("id", "user_id"),
        # Also serves a calculator's version history.
        UniqueConstraint("user_id", "calculator", "version"),
        ForeignKeyConstraint(
            ["supersedes_id", "user_id"],
            ["decisions.id", "decisions.user_id"],
            ondelete="CASCADE",
        ),
        CheckConstraint("version >= 1", name="version_positive"),
        CheckConstraint(
            "(version = 1) = (supersedes_id IS NULL)", name="first_version_has_no_parent"
        ),
        CheckConstraint("jsonb_typeof(inputs) = 'object'", name="inputs_object"),
        CheckConstraint("jsonb_typeof(result) = 'object'", name="result_object"),
        # No ON DELETE action: a check-in a decision points at is never deleted
        # alone, and account deletion removes both in one statement.
        ForeignKeyConstraint(["check_in_id", "user_id"], ["check_ins.id", "check_ins.user_id"]),
        Index(
            "uq_decisions_supersedes_id",
            "supersedes_id",
            unique=True,
            postgresql_where=text("supersedes_id IS NOT NULL"),
        ),
    )

    id: Mapped[uuid.UUID] = _id()
    user_id: Mapped[uuid.UUID] = _owner()
    calculator: Mapped[CalculatorKind] = mapped_column(pg_enum(CalculatorKind, "calculator_kind"))
    # The calculator's input and result models as JSON: money in integer cents.
    inputs: Mapped[dict[str, Any]] = mapped_column(JSONB)
    result: Mapped[dict[str, Any]] = mapped_column(JSONB)
    version: Mapped[int] = mapped_column(Integer)
    supersedes_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    # Set when a check-in finding led to this version.
    check_in_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    created_at: Mapped[dt.datetime] = _created_at()


def _decision_fk() -> ForeignKeyConstraint:
    return ForeignKeyConstraint(
        ["decision_id", "user_id"], ["decisions.id", "decisions.user_id"], ondelete="CASCADE"
    )


class Goal(Base):
    __tablename__ = "goals"
    __table_args__ = (
        _decision_fk(),
        # Postgres 15's column list: unlinking clears account_id and keeps the
        # goal's owner. SQLAlchemy's DDL compiler cannot emit it, so the
        # migration writes this key by hand; reflection reads it back as is.
        ForeignKeyConstraint(
            ["account_id", "user_id"],
            ["accounts.id", "accounts.user_id"],
            ondelete="SET NULL (account_id)",
        ),
        CheckConstraint("target_amount_cents > 0", name="target_positive"),
        CheckConstraint("monthly_contribution_cents >= 0", name="contribution_non_negative"),
        CheckConstraint("(status = 'reached') = (reached_at IS NOT NULL)", name="reached_has_time"),
        Index("ix_goals_user_id", "user_id"),
        # One emergency fund per user (spec 011 rule 9).
        Index(
            "uq_goals_user_emergency_fund",
            "user_id",
            unique=True,
            postgresql_where=text("kind = 'emergency_fund'"),
        ),
    )

    id: Mapped[uuid.UUID] = _id()
    user_id: Mapped[uuid.UUID] = _owner()
    kind: Mapped[GoalKind] = mapped_column(pg_enum(GoalKind, "goal_kind"))
    target_amount_cents: Mapped[int] = mapped_column(BigInteger)
    monthly_contribution_cents: Mapped[int] = mapped_column(BigInteger)
    account_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    decision_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    target_date: Mapped[dt.date | None] = mapped_column(Date)
    status: Mapped[GoalStatus] = mapped_column(
        pg_enum(GoalStatus, "goal_status"), server_default=text("'active'")
    )
    reached_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[dt.datetime] = _created_at()
    updated_at: Mapped[dt.datetime] = _updated_at()


class CalendarEvent(Base):
    """A dated checkpoint derived from a decision or a plan (spec 007 rule 14)."""

    __tablename__ = "calendar_events"
    __table_args__ = (
        _decision_fk(),
        CheckConstraint("title <> ''", name="title_not_empty"),
        Index("ix_calendar_events_user_due", "user_id", "due_at"),
        Index("ix_calendar_events_decision_id", "decision_id"),
    )

    id: Mapped[uuid.UUID] = _id()
    user_id: Mapped[uuid.UUID] = _owner()
    kind: Mapped[CalendarKind] = mapped_column(pg_enum(CalendarKind, "calendar_kind"))
    title: Mapped[str] = mapped_column(Text)
    due_at: Mapped[dt.date] = mapped_column(Date)
    decision_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    status: Mapped[CalendarStatus] = mapped_column(
        pg_enum(CalendarStatus, "calendar_status"), server_default=text("'upcoming'")
    )
    created_at: Mapped[dt.datetime] = _created_at()
    updated_at: Mapped[dt.datetime] = _updated_at()


# Defined outside the class: Explanation's ``text`` column shadows the function there.
_JSON_ARRAY = text("'[]'::jsonb")
_JSON_OBJECT = text("'{}'::jsonb")
_CLOCK_TIMESTAMP = text("clock_timestamp()")


class Explanation(Base):
    """One explanation attempt, or the fallback that ends a failed run (spec 008).

    Append-only. ``created_at`` defaults to ``clock_timestamp()`` so the rows
    of one run, written in one transaction, keep their order.
    """

    __tablename__ = "explanations"
    __table_args__ = (
        _decision_fk(),
        CheckConstraint("num_nonnulls(decision_id, finding_id) = 1", name="one_subject"),
        CheckConstraint("attempt BETWEEN 1 AND 3", name="attempt_range"),
        CheckConstraint("retries IN (0, 1)", name="retries_range"),
        CheckConstraint("NOT (verified AND fallback)", name="verified_or_fallback"),
        CheckConstraint("jsonb_typeof(numbers) = 'array'", name="numbers_array"),
        CheckConstraint("jsonb_typeof(what_ifs) = 'array'", name="what_ifs_array"),
        CheckConstraint("jsonb_typeof(citations) = 'array'", name="citations_array"),
        CheckConstraint("jsonb_typeof(verification) = 'object'", name="verification_object"),
        ForeignKeyConstraint(
            ["finding_id", "user_id"],
            ["check_in_findings.id", "check_in_findings.user_id"],
            ondelete="CASCADE",
        ),
        Index("ix_explanations_decision_created", "decision_id", "created_at"),
        Index("ix_explanations_finding_created", "finding_id", "created_at"),
    )

    id: Mapped[uuid.UUID] = _id()
    user_id: Mapped[uuid.UUID] = _owner()
    decision_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    # A check-in finding.
    finding_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    attempt: Mapped[int] = mapped_column(SmallInteger)
    retries: Mapped[int] = mapped_column(SmallInteger)
    concept: Mapped[str] = mapped_column(Text)
    text: Mapped[str] = mapped_column(Text)
    # [{"value": "$600.00", "label": "..."}]
    numbers: Mapped[list[Any]] = mapped_column(JSONB, server_default=_JSON_ARRAY)
    what_ifs: Mapped[list[Any]] = mapped_column(JSONB, server_default=_JSON_ARRAY)
    # irs_citations keys, in the order the explanation cites them.
    citations: Mapped[list[Any]] = mapped_column(JSONB, server_default=_JSON_ARRAY)
    prompt_version: Mapped[str] = mapped_column(Text)
    verified: Mapped[bool] = mapped_column(Boolean)
    fallback: Mapped[bool] = mapped_column(Boolean)
    # The verifier's counts (spec 008 rule 14).
    verification: Mapped[dict[str, Any]] = mapped_column(JSONB, server_default=_JSON_OBJECT)
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=_CLOCK_TIMESTAMP
    )


class IrsCitation(Base):
    """A curated IRS passage per calculator and tax year (spec 008). No owner:
    readable by every signed-in user, written only by the seed loader."""

    __tablename__ = "irs_citations"
    __table_args__ = (
        UniqueConstraint("calculator", "key", "tax_year"),
        CheckConstraint("url LIKE 'https://%'", name="url_https"),
        CheckConstraint("key <> ''", name="key_not_empty"),
        CheckConstraint("passage <> ''", name="passage_not_empty"),
    )

    id: Mapped[uuid.UUID] = _id()
    calculator: Mapped[CalculatorKind] = mapped_column(pg_enum(CalculatorKind, "calculator_kind"))
    key: Mapped[str] = mapped_column(Text)
    title: Mapped[str] = mapped_column(Text)
    url: Mapped[str] = mapped_column(Text)
    passage: Mapped[str] = mapped_column(Text)
    # The IRS document's name, for example "Notice 2025-67".
    source: Mapped[str] = mapped_column(Text)
    tax_year: Mapped[int] = mapped_column(SmallInteger)
    verified_on: Mapped[dt.date] = mapped_column(Date)
    created_at: Mapped[dt.datetime] = _created_at()
    updated_at: Mapped[dt.datetime] = _updated_at()


# ---------------------------------------------------------------- check-ins (0005)


class RecurringCharge(Base):
    """A detected subscription or bill (spec 009). ``status`` belongs to the
    detector, ``user_status`` and renames of ``merchant_clean`` to the user."""

    __tablename__ = "recurring_charges"
    __table_args__ = (
        UniqueConstraint("user_id", "merchant_norm", "cadence"),
        CheckConstraint("typical_amount_cents > 0", name="typical_positive"),
        CheckConstraint("first_seen <= last_seen", name="seen_in_order"),
        CheckConstraint("merchant_norm <> ''", name="merchant_norm_not_empty"),
        CheckConstraint("merchant_clean <> ''", name="merchant_clean_not_empty"),
    )

    id: Mapped[uuid.UUID] = _id()
    user_id: Mapped[uuid.UUID] = _owner()
    merchant_norm: Mapped[str] = mapped_column(Text)
    # Display name: set on detection, then changed only by the user.
    merchant_clean: Mapped[str] = mapped_column(Text)
    cadence: Mapped[RecurringCadence] = mapped_column(
        pg_enum(RecurringCadence, "recurring_cadence")
    )
    # Money out, so always positive.
    typical_amount_cents: Mapped[int] = mapped_column(BigInteger)
    first_seen: Mapped[dt.date] = mapped_column(Date)
    last_seen: Mapped[dt.date] = mapped_column(Date)
    status: Mapped[RecurringStatus] = mapped_column(
        pg_enum(RecurringStatus, "recurring_status"), server_default=text("'new'")
    )
    user_status: Mapped[RecurringUserStatus | None] = mapped_column(
        pg_enum(RecurringUserStatus, "recurring_user_status")
    )
    created_at: Mapped[dt.datetime] = _created_at()
    updated_at: Mapped[dt.datetime] = _updated_at()


class CheckIn(Base):
    """One monthly or data-triggered review (M8)."""

    __tablename__ = "check_ins"
    __table_args__ = (
        UniqueConstraint("id", "user_id"),
        CheckConstraint("EXTRACT(day FROM period) = 1", name="period_first_of_month"),
        CheckConstraint(
            "(status = 'completed') = (completed_at IS NOT NULL)", name="completed_when_done"
        ),
        # The monthly enqueue is idempotent: one scheduled check-in per month.
        Index(
            "uq_check_ins_scheduled_period",
            "user_id",
            "period",
            unique=True,
            postgresql_where=text("triggered_by = 'schedule'"),
        ),
    )

    id: Mapped[uuid.UUID] = _id()
    user_id: Mapped[uuid.UUID] = _owner()
    # First day of the reviewed month.
    period: Mapped[dt.date] = mapped_column(Date)
    triggered_by: Mapped[CheckinTrigger] = mapped_column(pg_enum(CheckinTrigger, "checkin_trigger"))
    status: Mapped[CheckinStatus] = mapped_column(
        pg_enum(CheckinStatus, "checkin_status"), server_default=text("'open'")
    )
    completed_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[dt.datetime] = _created_at()
    updated_at: Mapped[dt.datetime] = _updated_at()


class CheckInFinding(Base):
    """A typed finding of one check-in; its payload shape is set in M8."""

    __tablename__ = "check_in_findings"
    __table_args__ = (
        UniqueConstraint("id", "user_id"),
        ForeignKeyConstraint(
            ["check_in_id", "user_id"],
            ["check_ins.id", "check_ins.user_id"],
            ondelete="CASCADE",
        ),
        _decision_fk(),
        CheckConstraint("jsonb_typeof(payload) = 'object'", name="payload_object"),
        CheckConstraint("(user_action IS NULL) = (user_action_at IS NULL)", name="action_has_time"),
        Index("ix_check_in_findings_check_in_id", "check_in_id"),
        Index("ix_check_in_findings_decision_id", "decision_id"),
        # One finding per key and check-in; the key lookup across check-ins (0012).
        CheckConstraint("key <> ''", name="key_not_empty"),
        UniqueConstraint("check_in_id", "key"),
        Index("ix_check_in_findings_user_key", "user_id", "key"),
    )

    id: Mapped[uuid.UUID] = _id()
    user_id: Mapped[uuid.UUID] = _owner()
    check_in_id: Mapped[uuid.UUID] = mapped_column(Uuid)
    kind: Mapped[FindingKind] = mapped_column(pg_enum(FindingKind, "finding_kind"))
    severity: Mapped[FindingSeverity] = mapped_column(pg_enum(FindingSeverity, "finding_severity"))
    # What the finding reports, for example "pay_change:<stub id>" (spec 015 rule 12).
    key: Mapped[str] = mapped_column(Text)
    decision_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    payload: Mapped[dict[str, Any]] = mapped_column(JSONB)
    # Null undoes the user's action (spec amendment 14).
    user_action: Mapped[FindingAction | None] = mapped_column(
        pg_enum(FindingAction, "finding_action")
    )
    user_action_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[dt.datetime] = _created_at()
    updated_at: Mapped[dt.datetime] = _updated_at()
