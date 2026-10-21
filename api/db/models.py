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
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from db.enums import (
    AccountKind,
    AccountRole,
    CategorySource,
    FilingStatus,
    HealthcareUsage,
    JobKind,
    JobStatus,
    LlmPurpose,
    LlmStatus,
    PayFrequency,
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
