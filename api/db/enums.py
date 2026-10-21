"""Postgres enum types (spec 001, Enums) as Python ``StrEnum``s.

Each member's value is the database label. ``pg_enum`` builds the SQLAlchemy
type the models use; migrations create the types themselves, so the models
never emit ``CREATE TYPE``. Adding a value is a migration.
"""

from __future__ import annotations

from enum import StrEnum

from sqlalchemy.dialects.postgresql import ENUM


class PayFrequency(StrEnum):
    WEEKLY = "weekly"
    BIWEEKLY = "biweekly"
    SEMIMONTHLY = "semimonthly"
    MONTHLY = "monthly"


class FilingStatus(StrEnum):
    SINGLE = "single"
    MARRIED_FILING_JOINTLY = "married_filing_jointly"
    HEAD_OF_HOUSEHOLD = "head_of_household"


class HealthcareUsage(StrEnum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"


class SyncProvider(StrEnum):
    PLAID = "plaid"
    CSV = "csv"


class SyncStatus(StrEnum):
    ACTIVE = "active"
    LOGIN_REQUIRED = "login_required"
    ERROR = "error"


class AccountKind(StrEnum):
    CHECKING = "checking"
    SAVINGS = "savings"
    CREDIT = "credit"
    INVESTMENT = "investment"
    RETIREMENT = "retirement"


class AccountRole(StrEnum):
    SPENDING = "spending"
    EMERGENCY_FUND = "emergency_fund"
    RETIREMENT = "retirement"


class CategorySource(StrEnum):
    RULE = "rule"
    USER = "user"
    LLM = "llm"


class RuleMatch(StrEnum):
    EXACT = "exact"
    PREFIX = "prefix"


class RuleSource(StrEnum):
    SEED = "seed"
    USER = "user"


class JobKind(StrEnum):
    SYNC_INITIAL = "sync.initial"
    SYNC_INCREMENTAL = "sync.incremental"
    CATEGORIZE_RUN = "categorize.run"
    INGEST_EXTRACT = "ingest.extract"
    RECURRING_DETECT = "recurring.detect"
    CHECKIN_MONTHLY = "checkin.monthly"
    SCHEDULE_TICK = "schedule.tick"


class JobStatus(StrEnum):
    QUEUED = "queued"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    DEAD = "dead"


class LlmPurpose(StrEnum):
    EXTRACT = "extract"
    CATEGORIZE = "categorize"
    EXPLAIN = "explain"


class LlmStatus(StrEnum):
    OK = "ok"
    REFUSAL = "refusal"
    SCHEMA_ERROR = "schema_error"
    API_ERROR = "api_error"
    BUDGET_BLOCKED = "budget_blocked"


# Postgres type name for each enum created by 0002_core, in creation order.
CORE_ENUMS: dict[str, type[StrEnum]] = {
    "pay_frequency": PayFrequency,
    "filing_status": FilingStatus,
    "healthcare_usage": HealthcareUsage,
    "sync_provider": SyncProvider,
    "sync_status": SyncStatus,
    "account_kind": AccountKind,
    "account_role": AccountRole,
    "category_source": CategorySource,
    "rule_match": RuleMatch,
    "rule_source": RuleSource,
    "job_kind": JobKind,
    "job_status": JobStatus,
    "llm_purpose": LlmPurpose,
    "llm_status": LlmStatus,
}


def pg_enum(enum: type[StrEnum], name: str) -> ENUM:
    """The column type for ``enum``, stored by value, never created by SQLAlchemy."""
    return ENUM(
        enum,
        name=name,
        values_callable=lambda members: [member.value for member in members],
        create_type=False,
        validate_strings=True,
    )
