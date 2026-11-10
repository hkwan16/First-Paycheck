"""The salary check (spec 005 rule 24c, issue 221), worked examples."""

from __future__ import annotations

import datetime as dt
import uuid

from app.salary_review import SalaryReview, salary_review
from db.enums import PayFrequency
from db.models import PayStub


def stub(
    frequency: PayFrequency | None,
    gross_cents: int,
    pay_date: dt.date,
) -> PayStub:
    return PayStub(
        id=uuid.uuid4(), pay_frequency=frequency, gross_cents=gross_cents, pay_date=pay_date
    )


# stub-01: $3,653.85 every two weeks, 9,500,010 a year.
STUB_01 = stub(PayFrequency.BIWEEKLY, 365_385, dt.date(2026, 4, 10))
# The Acme stub: $2,708.33 twice a month, 6,499,992 a year.
ACME = stub(PayFrequency.SEMIMONTHLY, 270_833, dt.date(2026, 10, 15))
# Its next paycheck, at the same pay.
ACME_31 = stub(PayFrequency.SEMIMONTHLY, 270_833, dt.date(2026, 10, 31))

ISSUE_221 = SalaryReview(
    pay_stub_id=ACME.id,
    pay_stub_date=dt.date(2026, 10, 15),
    frequency=PayFrequency.SEMIMONTHLY,
    periods_per_year=24,
    gross_cents=270_833,
    annual_salary_cents=6_499_992,
    salary_cents=9_500_010,
)


def test_issue_221_a_newer_stub_on_another_schedule() -> None:
    assert salary_review(9_500_010, ACME, STUB_01) == ISSUE_221


def test_a_profile_saved_before_the_check_is_asked_once() -> None:
    assert salary_review(9_500_010, ACME, None) == ISSUE_221


def test_the_salary_the_stub_comes_to() -> None:
    assert salary_review(6_499_992, ACME, None) is None


def test_kept_after_answering() -> None:
    assert salary_review(9_500_010, ACME, ACME) is None


def test_the_next_paycheck_at_the_same_pay() -> None:
    """Typed $65,000.00 against the Acme stub's $64,999.92; the next stub pays the same."""
    assert salary_review(6_500_000, ACME_31, ACME) is None


def test_a_raise_asks_again() -> None:
    raise_ = stub(PayFrequency.SEMIMONTHLY, 291_667, dt.date(2026, 10, 31))
    assert salary_review(6_500_000, raise_, ACME) == SalaryReview(
        pay_stub_id=raise_.id,
        pay_stub_date=dt.date(2026, 10, 31),
        frequency=PayFrequency.SEMIMONTHLY,
        periods_per_year=24,
        gross_cents=291_667,
        annual_salary_cents=7_000_008,
        salary_cents=6_500_000,
    )


def test_no_salary_saved() -> None:
    assert salary_review(None, ACME, None) is None


def test_a_stub_with_no_schedule() -> None:
    no_schedule = stub(None, 270_833, dt.date(2026, 10, 15))
    assert salary_review(9_500_010, no_schedule, None) is None


def test_no_stub() -> None:
    assert salary_review(9_500_010, None, None) is None
