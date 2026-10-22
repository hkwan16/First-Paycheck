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
    LOAN = "loan"
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
    # Render the plan PDF (spec 016); added by 0013_plan_export_job.
    PLAN_EXPORT = "plan.export"


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


class DocumentType(StrEnum):
    PAY_STUB = "pay_stub"
    OFFER_LETTER = "offer_letter"
    BENEFITS = "benefits"


class DocumentStatus(StrEnum):
    UPLOADED = "uploaded"
    EXTRACTING = "extracting"
    PROPOSED = "proposed"
    CONFIRMED = "confirmed"
    MANUAL_ENTRY_REQUIRED = "manual_entry_required"
    FAILED = "failed"


class DocumentStatusReason(StrEnum):
    """Why a document is ``manual_entry_required`` or ``failed`` (spec 004 rule 22)."""

    REFUSED = "refused"
    NO_READABLE_PAGE = "no_readable_page"
    BUDGET = "budget"
    EXTRACTION_FAILED = "extraction_failed"
    UNREADABLE_FILE = "unreadable_file"
    EXPIRED = "expired"
    NO_MODEL = "no_model"


class PlanKind(StrEnum):
    HDHP = "hdhp"
    PPO = "ppo"
    HMO = "hmo"


class CalculatorKind(StrEnum):
    EMERGENCY_FUND = "emergency_fund"
    K401_MATCH = "k401_match"
    HEALTH_PLANS = "health_plans"
    W4 = "w4"


class GoalKind(StrEnum):
    EMERGENCY_FUND = "emergency_fund"
    CUSTOM = "custom"


class GoalStatus(StrEnum):
    """Where a goal stands (spec 011 rule 15)."""

    ACTIVE = "active"
    PAUSED = "paused"
    REACHED = "reached"


class CalendarKind(StrEnum):
    ENROLLMENT_DEADLINE = "enrollment_deadline"
    TAX_SEASON = "tax_season"
    OPEN_ENROLLMENT = "open_enrollment"
    GOAL_TARGET = "goal_target"
    # A saved election should show up on the next pay stub (spec 007 rule 14).
    ELECTION_CHECK = "election_check"
    # An emergency fund decision's first contribution and its review (spec 011
    # rule 12); added by 0008_goals_and_birth_year.
    GOAL_CONTRIBUTION = "goal_contribution"
    GOAL_REVIEW = "goal_review"
    # Hand the employer the W-4 a saved decision describes (spec 014 rule 18);
    # added by 0009_w4_calendar_kind.
    W4_SUBMIT = "w4_submit"


class CalendarStatus(StrEnum):
    UPCOMING = "upcoming"
    DONE = "done"
    DISMISSED = "dismissed"


class RecurringCadence(StrEnum):
    WEEKLY = "weekly"
    MONTHLY = "monthly"
    YEARLY = "yearly"


class RecurringStatus(StrEnum):
    """The detector's view of a charge (spec 009 rules 11-14)."""

    ACTIVE = "active"
    NEW = "new"
    CHANGED = "changed"
    STOPPED = "stopped"


class RecurringUserStatus(StrEnum):
    """What the user said about a charge (spec 009 rule 17)."""

    CONFIRMED = "confirmed"
    IGNORED = "ignored"
    CANCELLED = "cancelled"


class CheckinTrigger(StrEnum):
    SCHEDULE = "schedule"
    SYNC = "sync"
    MANUAL = "manual"


class CheckinStatus(StrEnum):
    OPEN = "open"
    COMPLETED = "completed"


class FindingKind(StrEnum):
    ELECTION_MISMATCH = "election_mismatch"
    GOAL_OFF_PACE = "goal_off_pace"
    RECURRING_NEW = "recurring_new"
    RECURRING_CHANGED = "recurring_changed"
    RECURRING_STOPPED = "recurring_stopped"
    PAY_CHANGE = "pay_change"
    DEDUCTION_CHANGE = "deduction_change"
    UPCOMING_DEADLINE = "upcoming_deadline"


class FindingSeverity(StrEnum):
    INFO = "info"
    WARNING = "warning"
    ALERT = "alert"


class FindingAction(StrEnum):
    """What the user did with a finding; null undoes it (0012_checkin_findings, spec 015)."""

    DONE = "done"
    DISMISSED = "dismissed"


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


# Enums created by 0003_documents, in creation order.
DOCUMENT_ENUMS: dict[str, type[StrEnum]] = {
    "document_type": DocumentType,
    "document_status": DocumentStatus,
    "document_status_reason": DocumentStatusReason,
    "plan_kind": PlanKind,
}


# Enums created by 0004_decisions, in creation order.
DECISION_ENUMS: dict[str, type[StrEnum]] = {
    "calculator_kind": CalculatorKind,
    "goal_kind": GoalKind,
    "calendar_kind": CalendarKind,
    "calendar_status": CalendarStatus,
}


# Enums created by 0005_checkins, in creation order.
CHECKIN_ENUMS: dict[str, type[StrEnum]] = {
    "recurring_cadence": RecurringCadence,
    "recurring_status": RecurringStatus,
    "recurring_user_status": RecurringUserStatus,
    "checkin_trigger": CheckinTrigger,
    "checkin_status": CheckinStatus,
    "finding_kind": FindingKind,
    "finding_severity": FindingSeverity,
    "finding_action": FindingAction,
}


# Enums created by 0008_goals_and_birth_year, in creation order.
GOAL_ENUMS: dict[str, type[StrEnum]] = {
    "goal_status": GoalStatus,
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
