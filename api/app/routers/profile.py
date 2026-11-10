"""The user's profile: what the calculators need to know (spec 005 rules 24c-25a).

``birth_year`` settles spec 006 open question 2: the client sends the 401(k)
calculator ``age = tax_year - birth_year`` (the age reached by December 31 of
the tax year); ``calc/`` keeps taking ``age`` as an input.
"""

from __future__ import annotations

import datetime as dt
import uuid
from typing import Any, Self

from fastapi import APIRouter
from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app.auth import CurrentUser
from app.deps import Now, UserSession
from app.errors import AppError, NotFound, error_responses
from app.pay_schedule import PaySchedule, pay_schedule
from app.salary_review import SalaryReview, load_salary_review
from app.types import UtcDateTime
from calc.k401 import MAX_TIERS, MatchTier, tiers_ascending
from calc.types import PositiveCents
from db.enums import FilingStatus, HealthcareUsage, PayFrequency
from db.models import Profile
from db.pay_stubs import find_pay_stub

router = APIRouter(prefix="/profile", tags=["profile"])

MIN_BIRTH_YEAR = 1900


class OtherJob(BaseModel):
    """Another job's wages, for withholding (the W-4 multiple-jobs step)."""

    model_config = ConfigDict(extra="forbid")

    annual_wages_cents: PositiveCents


class ProfileFields(BaseModel):
    model_config = ConfigDict(extra="forbid")

    salary_cents: PositiveCents | None = None
    # The stub the salary was last compared with (spec 005 rule 24c).
    salary_pay_stub_id: uuid.UUID | None = None
    pay_frequency: PayFrequency | None = None
    filing_status: FilingStatus | None = None
    other_jobs: list[OtherJob] = Field(default_factory=list, max_length=5)
    dependents: int = Field(default=0, ge=0, le=20, strict=True)
    expected_healthcare_usage: HealthcareUsage | None = None
    start_date: dt.date | None = None
    match_tiers: list[MatchTier] = Field(default_factory=list, max_length=MAX_TIERS)
    vesting_years: int | None = Field(default=None, ge=0, le=10, strict=True)
    # The year the user was born; at most the current year (checked by the route).
    birth_year: int | None = Field(default=None, ge=MIN_BIRTH_YEAR, strict=True)

    @model_validator(mode="after")
    def _tiers_ascending(self) -> Self:
        tiers_ascending(self.match_tiers)
        return self


class ProfileIn(ProfileFields):
    """The whole profile; a field left out is reset to its default."""


class ProfileOut(ProfileFields):
    # Null until the profile is first saved.
    updated_at: UtcDateTime | None
    pay_schedule: PaySchedule | None = Field(
        description=(
            "The pay schedule every calculator uses (spec 005 rule 25a): the newest "
            "confirmed stub's, else pay_frequency; null without either. Computed on read."
        )
    )
    salary_review: SalaryReview | None = Field(
        description=(
            "Set when the newest confirmed stub's yearly pay differs from salary_cents and "
            "from the stub salary_pay_stub_id names (spec 005 rule 24c): the person chooses "
            "which salary to use. Computed on read."
        )
    )


def _out(session: Session, profile: Profile | None) -> ProfileOut:
    saved = (
        {}
        if profile is None
        else {name: getattr(profile, name) for name in ProfileFields.model_fields}
    )
    return ProfileOut.model_validate(
        {
            **saved,
            "updated_at": None if profile is None else profile.updated_at,
            "pay_schedule": pay_schedule(session, profile),
            "salary_review": load_salary_review(session, profile),
        }
    )


@router.get("", responses=error_responses(401))
def get_profile(session: UserSession, user: CurrentUser) -> ProfileOut:
    """The saved profile, or the defaults when nothing is saved yet."""
    return _out(session, session.get(Profile, user.id))


@router.put("", responses=error_responses(401, 404, 422))
def put_profile(body: ProfileIn, session: UserSession, user: CurrentUser, now: Now) -> ProfileOut:
    """Replace the profile."""
    if body.birth_year is not None and body.birth_year > now.year:
        raise AppError(
            f"The birth year must be at most {now.year}", code="validation_error", status_code=422
        )
    if (
        body.salary_pay_stub_id is not None
        and find_pay_stub(session, body.salary_pay_stub_id) is None
    ):
        raise NotFound("Pay stub not found")
    values: dict[str, Any] = body.model_dump(exclude={"other_jobs", "match_tiers"})
    # The jsonb columns hold JSON: percentages as two-place strings.
    values["other_jobs"] = [job.model_dump(mode="json") for job in body.other_jobs]
    values["match_tiers"] = [tier.model_dump(mode="json") for tier in body.match_tiers]
    statement = (
        insert(Profile)
        .values(user_id=user.id, **values)
        .on_conflict_do_update(index_elements=[Profile.user_id], set_=values)
        .returning(Profile)
    )
    profile = session.scalars(statement, execution_options={"populate_existing": True}).one()
    return _out(session, profile)
