"""sync/recurring.py: detection and status rules (spec 009), from the spec's examples."""

from __future__ import annotations

import datetime as dt

import pytest

from db.enums import RecurringCadence, RecurringStatus
from sync.recurring import (
    Charge,
    DetectedCharge,
    StoredCharge,
    detect,
    is_overdue,
    next_status,
    undetected_status,
)

TODAY = dt.date(2026, 10, 21)
NEW, ACTIVE, CHANGED, STOPPED = (
    RecurringStatus.NEW,
    RecurringStatus.ACTIVE,
    RecurringStatus.CHANGED,
    RecurringStatus.STOPPED,
)
MONTHLY, WEEKLY, YEARLY = RecurringCadence.MONTHLY, RecurringCadence.WEEKLY, RecurringCadence.YEARLY


def d(text: str) -> dt.date:
    """``"07-03"`` is 2026-07-03; a full ISO date is taken as is."""
    return dt.date.fromisoformat(text if len(text) == 10 else f"2026-{text}")


def charges(raw: str, *series: tuple[str, int], clean: str | None = None) -> list[Charge]:
    from sync.categorize import normalize_merchant

    return [
        Charge(
            merchant_norm=normalize_merchant(raw),
            merchant_raw=raw,
            merchant_clean=clean,
            posted_at=d(day),
            amount_cents=amount,
        )
        for day, amount in series
    ]


NETFLIX = charges(
    "NETFLIX.COM",
    ("07-03", 1549),
    ("08-03", 1549),
    ("09-03", 1549),
    ("10-03", 1549),
)
YOGA = charges(
    "CORE POWER YOGA", ("09-01", 2000), ("09-08", 2000), ("09-15", 2000), ("09-22", 2000)
)


def only(found: list[DetectedCharge]) -> DetectedCharge:
    assert len(found) == 1, found
    return found[0]


# ---------------------------------------------------------------- detection examples


def test_monthly_subscription_detected() -> None:
    found = only(detect(NETFLIX, TODAY))
    assert found == DetectedCharge(
        merchant_norm="netflix.com",
        merchant_clean="NETFLIX.COM",
        cadence=MONTHLY,
        typical_amount_cents=1549,
        first_seen=d("07-03"),
        last_seen=d("10-03"),
        occurrences=4,
        overdue=False,
    )


def test_weekly_class_detected() -> None:
    found = only(detect(YOGA, d("09-25")))
    assert (found.cadence, found.typical_amount_cents, found.occurrences) == (WEEKLY, 2000, 4)
    assert not found.overdue


def test_three_weekly_charges_are_not_enough() -> None:
    assert detect(YOGA[:3], d("09-25")) == []


def test_yearly_membership_detected() -> None:
    prime = charges("AMAZON PRIME", ("2025-02-14", 13900), ("2026-02-14", 13900))
    found = only(detect(prime, TODAY))
    assert (found.cadence, found.typical_amount_cents, found.overdue) == (YEARLY, 13900, False)


def test_two_monthly_charges_are_not_enough() -> None:
    assert detect(charges("SPOTIFY", ("09-05", 1199), ("10-05", 1199)), TODAY) == []


def test_one_off_amount_left_out() -> None:
    bills = charges(
        "PG&E",
        ("07-12", 8200),
        ("08-12", 9100),
        ("09-11", 8700),
        ("09-20", 25000),
        ("10-12", 8900),
    )
    found = only(detect(bills, TODAY))
    assert (found.cadence, found.typical_amount_cents, found.occurrences) == (MONTHLY, 8900, 4)
    assert (found.first_seen, found.last_seen) == (d("07-12"), d("10-12"))


def test_skipped_month_still_recurring() -> None:
    days = ("03-01", "04-01", "05-01", "06-01", "08-01", "09-01", "10-01")
    found = only(detect(charges("GYM", *((day, 4999) for day in days)), TODAY))
    assert (found.cadence, found.occurrences) == (MONTHLY, 7)


def test_ride_share_is_not_recurring() -> None:
    rides = [
        *charges("Uber 063015 SF**POOL**", ("08-12", 540), ("09-11", 540), ("10-11", 540)),
        *charges("Uber 072515 SF**POOL**", ("07-26", 633), ("08-25", 633), ("09-24", 633)),
    ]
    assert {charge.merchant_norm for charge in rides} == {"uber sf pool"}
    assert detect(rides, TODAY) == []


def test_refunds_and_income_ignored() -> None:
    noise = [
        *charges("NETFLIX.COM", ("10-05", -1549)),
        *charges("ACME PAYROLL", ("10-15", -199604)),
    ]
    assert detect([*NETFLIX, *noise], TODAY) == detect(NETFLIX, TODAY)


def test_overdue_boundary() -> None:
    assert not only(detect(NETFLIX, d("11-11"))).overdue
    assert only(detect(NETFLIX, d("11-12"))).overdue


def test_price_change_followed() -> None:
    days = ("05-03", "06-03", "07-03", "08-03")
    netflix = charges(
        "NETFLIX.COM", *((day, 1549) for day in days), ("09-03", 1699), ("10-03", 1699)
    )
    found = only(detect(netflix, TODAY))
    assert (found.cadence, found.typical_amount_cents) == (MONTHLY, 1699)
    assert (found.first_seen, found.occurrences) == (d("05-03"), 6)


# ---------------------------------------------------------------- rules without an example


def test_empty_merchant_is_never_recurring() -> None:
    blank = charges("#1234", ("07-03", 500), ("08-03", 500), ("09-03", 500))
    assert blank[0].merchant_norm == ""
    assert detect(blank, TODAY) == []


@pytest.mark.parametrize(("gap", "recurring"), [(26, False), (27, True), (33, True), (34, False)])
def test_monthly_band_edges(gap: int, recurring: bool) -> None:
    start = dt.date(2026, 6, 1)
    days = [start + dt.timedelta(days=gap * index) for index in range(3)]
    series = charges("WATER CO", *((day.isoformat(), 3000) for day in days))
    assert bool(detect(series, days[-1])) is recurring


@pytest.mark.parametrize(("gap", "recurring"), [(5, False), (6, True), (8, True), (9, False)])
def test_weekly_band_edges(gap: int, recurring: bool) -> None:
    start = dt.date(2026, 9, 1)
    days = [start + dt.timedelta(days=gap * index) for index in range(4)]
    series = charges("CLASS", *((day.isoformat(), 1500) for day in days))
    assert bool(detect(series, days[-1])) is recurring


@pytest.mark.parametrize(
    ("gap", "recurring"), [(349, False), (350, True), (380, True), (381, False)]
)
def test_yearly_band_edges(gap: int, recurring: bool) -> None:
    start = dt.date(2025, 1, 10)
    series = charges(
        "DOMAIN RENEWAL",
        (start.isoformat(), 1200),
        ((start + dt.timedelta(days=gap)).isoformat(), 1200),
    )
    assert bool(detect(series, start + dt.timedelta(days=gap))) is recurring


def test_three_quarters_of_gaps_must_fit() -> None:
    # Gaps 30, 30, 30, 10, 20: three of five fit, and 4 * 3 = 12 < 3 * 5 = 15.
    days = ("06-01", "07-01", "07-31", "08-30", "09-09", "09-29")
    assert detect(charges("PHONE", *((day, 6000) for day in days)), TODAY) == []


def test_same_day_duplicate_counts_as_an_off_band_gap() -> None:
    days = ("06-01", "07-01", "07-31", "07-31", "08-30")
    found = only(detect(charges("PHONE", *((day, 6000) for day in days)), TODAY))
    assert found.occurrences == 5


def test_display_name_prefers_the_newest_clean_name() -> None:
    series = [
        *charges("UBER   EATS 01", ("07-03", 1500), clean="Uber Eats"),
        *charges("UBER   EATS 02", ("08-03", 1500), clean=None),
        *charges("UBER   EATS 03", ("09-03", 1500), clean="Uber Eats Pass"),
        *charges("UBER   EATS 04", ("10-03", 1500), clean=None),
    ]
    assert only(detect(series, TODAY)).merchant_clean == "Uber Eats Pass"
    raw_only = charges("  SOME   GYM  ", ("08-03", 900), ("09-03", 900), ("10-03", 900))
    assert only(detect(raw_only, TODAY)).merchant_clean == "SOME GYM"


def test_merchants_are_detected_separately_and_in_order() -> None:
    found = detect([*YOGA, *NETFLIX], d("10-04"))
    assert [charge.merchant_norm for charge in found] == ["core power yoga", "netflix.com"]
    assert found[0].overdue  # yoga's last class was 12 days earlier


def test_input_order_does_not_matter() -> None:
    mixed = [*NETFLIX, *YOGA]
    # Interleave the two merchants, newest first.
    shuffled = [mixed[index] for index in (7, 3, 6, 2, 5, 1, 4, 0)]
    assert detect(shuffled, TODAY) == detect(mixed, TODAY)


@pytest.mark.parametrize(
    ("cadence", "last_seen", "today", "overdue"),
    [
        (WEEKLY, "10-11", "10-21", False),
        (WEEKLY, "10-10", "10-21", True),
        (MONTHLY, "09-12", "10-21", False),
        (MONTHLY, "09-11", "10-21", True),
        (YEARLY, "2025-09-06", "2026-10-21", False),
        (YEARLY, "2025-09-05", "2026-10-21", True),
    ],
)
def test_is_overdue(cadence: RecurringCadence, last_seen: str, today: str, overdue: bool) -> None:
    assert is_overdue(cadence, d(last_seen), d(today)) is overdue


# ---------------------------------------------------------------- status


def detected(typical: int = 1549, overdue: bool = False) -> DetectedCharge:
    return DetectedCharge(
        merchant_norm="netflix.com",
        merchant_clean="Netflix",
        cadence=MONTHLY,
        typical_amount_cents=typical,
        first_seen=d("07-03"),
        last_seen=d("10-03"),
        occurrences=4,
        overdue=overdue,
    )


def stored(status: RecurringStatus, typical: int = 1549, last_seen: str = "10-03") -> StoredCharge:
    return StoredCharge(
        cadence=MONTHLY, typical_amount_cents=typical, last_seen=d(last_seen), status=status
    )


@pytest.mark.parametrize(
    ("before", "now", "after"),
    [
        (None, detected(), NEW),
        (None, detected(overdue=True), STOPPED),
        (stored(ACTIVE), detected(typical=1699), CHANGED),
        (stored(ACTIVE), detected(typical=1599), ACTIVE),
        (stored(NEW), detected(typical=1699), NEW),
        (stored(CHANGED, typical=1699), detected(typical=1699), CHANGED),
        (stored(STOPPED), detected(), NEW),
        (stored(ACTIVE), detected(overdue=True), STOPPED),
        (stored(NEW), detected(overdue=True), STOPPED),
        (stored(STOPPED), detected(overdue=True), STOPPED),
    ],
)
def test_next_status(
    before: StoredCharge | None, now: DetectedCharge, after: RecurringStatus
) -> None:
    assert next_status(before, now) is after


@pytest.mark.parametrize(
    ("before", "after"),
    [
        (stored(ACTIVE, last_seen="09-03"), STOPPED),
        (stored(ACTIVE, last_seen="10-03"), ACTIVE),
        (stored(NEW, last_seen="10-03"), NEW),
        (stored(CHANGED, last_seen="09-03"), STOPPED),
    ],
)
def test_undetected_status(before: StoredCharge, after: RecurringStatus) -> None:
    assert undetected_status(before, TODAY) is after
