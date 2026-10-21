"""Recurring-charge detection (spec 009).

``detect`` and the two status functions are pure: they take transaction rows
and stored charges and return what should be stored. ``run_detection`` is
the thin writer the ``recurring.detect`` job calls in one user session.
Amount arithmetic (median, tolerance, change) is ``calc.recurring``.
"""

from __future__ import annotations

import datetime as dt
import uuid
from collections import defaultdict
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from itertools import pairwise
from typing import Any

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from calc.recurring import median_cents, moved_more_than, within_pct
from db.enums import RecurringCadence, RecurringStatus
from db.models import Account, RecurringCharge, Transaction

__all__ = [
    "BANDS",
    "Band",
    "Charge",
    "DetectedCharge",
    "DetectionResult",
    "StoredCharge",
    "detect",
    "is_overdue",
    "next_status",
    "run_detection",
    "undetected_status",
]

# Rule 5: a charge belongs to the series within 15% of the merchant's median.
SERIES_TOLERANCE_PCT = 15
# Rule 12: an active charge whose typical amount moves more than 5% changed.
CHANGE_PCT = 5
# Rule 9: the typical amount is the median of this many newest charges.
TYPICAL_OF_NEWEST = 3


@dataclass(frozen=True)
class Band:
    """Gaps of ``min_gap``-``max_gap`` days (inclusive), at least ``min_charges`` charges."""

    cadence: RecurringCadence
    min_gap: int
    max_gap: int
    min_charges: int

    def fits(self, gap: int) -> bool:
        return self.min_gap <= gap <= self.max_gap

    @property
    def overdue_after_days(self) -> int:
        """Rule 10: the longest gap plus the band's width."""
        return self.max_gap + (self.max_gap - self.min_gap)


BANDS: dict[RecurringCadence, Band] = {
    RecurringCadence.WEEKLY: Band(RecurringCadence.WEEKLY, 6, 8, 4),
    RecurringCadence.MONTHLY: Band(RecurringCadence.MONTHLY, 27, 33, 3),
    RecurringCadence.YEARLY: Band(RecurringCadence.YEARLY, 350, 380, 2),
}


@dataclass(frozen=True)
class Charge:
    """One transaction as detection sees it."""

    merchant_norm: str
    merchant_raw: str
    merchant_clean: str | None
    posted_at: dt.date
    amount_cents: int


@dataclass(frozen=True)
class DetectedCharge:
    merchant_norm: str
    merchant_clean: str
    cadence: RecurringCadence
    typical_amount_cents: int
    first_seen: dt.date
    last_seen: dt.date
    occurrences: int
    overdue: bool


@dataclass(frozen=True)
class StoredCharge:
    """What ``next_status`` needs from a stored ``recurring_charges`` row."""

    cadence: RecurringCadence
    typical_amount_cents: int
    last_seen: dt.date
    status: RecurringStatus


def is_overdue(cadence: RecurringCadence, last_seen: dt.date, today: dt.date) -> bool:
    return (today - last_seen).days > BANDS[cadence].overdue_after_days


def _qualifies(charge: Charge) -> bool:
    # Rule 1: money out from a merchant with a name.
    return charge.amount_cents > 0 and charge.merchant_norm != ""


def _cadence(series: Sequence[Charge]) -> Band | None:
    gaps = [(later.posted_at - earlier.posted_at).days for earlier, later in pairwise(series)]
    if not gaps:
        return None
    for band in BANDS.values():
        in_band = sum(1 for gap in gaps if band.fits(gap))
        # Rule 6: at least three quarters of the gaps fall in one band.
        if 4 * in_band >= 3 * len(gaps):
            return band
    return None


def _display_name(series: Sequence[Charge]) -> str:
    for charge in reversed(series):
        if charge.merchant_clean and charge.merchant_clean.strip():
            return " ".join(charge.merchant_clean.split())
    return " ".join(series[-1].merchant_raw.split())


def _detect_one(group: Sequence[Charge], today: dt.date) -> DetectedCharge | None:
    reference = median_cents([charge.amount_cents for charge in group])
    series = [c for c in group if within_pct(c.amount_cents, reference, SERIES_TOLERANCE_PCT)]
    band = _cadence(series)
    if band is None or len(series) < band.min_charges:
        return None
    newest = [charge.amount_cents for charge in series[-TYPICAL_OF_NEWEST:]]
    last_seen = series[-1].posted_at
    return DetectedCharge(
        merchant_norm=series[0].merchant_norm,
        merchant_clean=_display_name(series),
        cadence=band.cadence,
        typical_amount_cents=median_cents(newest),
        first_seen=series[0].posted_at,
        last_seen=last_seen,
        occurrences=len(series),
        overdue=is_overdue(band.cadence, last_seen, today),
    )


def detect(charges: Iterable[Charge], today: dt.date) -> list[DetectedCharge]:
    """Every recurring series in ``charges``, ordered by ``merchant_norm`` (rules 1-10)."""
    groups: defaultdict[str, list[Charge]] = defaultdict(list)
    for charge in charges:
        if _qualifies(charge):
            groups[charge.merchant_norm].append(charge)
    found: list[DetectedCharge] = []
    for merchant_norm in sorted(groups):
        # Rule 2: by date, then amount, so the input order never matters.
        group = sorted(
            groups[merchant_norm],
            key=lambda c: (c.posted_at, c.amount_cents, c.merchant_raw, c.merchant_clean or ""),
        )
        detected = _detect_one(group, today)
        if detected is not None:
            found.append(detected)
    return found


def next_status(stored: StoredCharge | None, detected: DetectedCharge) -> RecurringStatus:
    """Rule 12: the status of a detected series given its stored row."""
    if detected.overdue:
        return RecurringStatus.STOPPED
    if stored is None or stored.status is RecurringStatus.STOPPED:
        return RecurringStatus.NEW
    if stored.status is RecurringStatus.ACTIVE and moved_more_than(
        detected.typical_amount_cents, stored.typical_amount_cents, CHANGE_PCT
    ):
        return RecurringStatus.CHANGED
    return stored.status


def undetected_status(stored: StoredCharge, today: dt.date) -> RecurringStatus:
    """Rule 14: a stored charge whose merchant still has charges but no series."""
    if is_overdue(stored.cadence, stored.last_seen, today):
        return RecurringStatus.STOPPED
    return stored.status


# ---------------------------------------------------------------- writer


@dataclass(frozen=True)
class DetectionResult:
    detected: int = 0
    new: int = 0
    changed: int = 0
    stopped: int = 0
    deleted: int = 0

    def as_job_result(self) -> dict[str, Any]:
        return {
            "detected": self.detected,
            "new": self.new,
            "changed": self.changed,
            "stopped": self.stopped,
            "deleted": self.deleted,
        }


def _stored(row: RecurringCharge) -> StoredCharge:
    return StoredCharge(
        cadence=row.cadence,
        typical_amount_cents=row.typical_amount_cents,
        last_seen=row.last_seen,
        status=row.status,
    )


def _read_charges(session: Session) -> list[Charge]:
    rows = session.execute(
        select(
            Transaction.merchant_norm,
            Transaction.merchant_raw,
            Transaction.merchant_clean,
            Transaction.posted_at,
            Transaction.amount_cents,
        )
        .join(
            Account,
            (Account.id == Transaction.account_id) & (Account.user_id == Transaction.user_id),
        )
        .where(
            Transaction.pending.is_(False),
            Account.is_active.is_(True),
            Transaction.amount_cents > 0,
            Transaction.merchant_norm != "",
        )
    )
    return [
        Charge(
            merchant_norm=merchant_norm,
            merchant_raw=merchant_raw,
            merchant_clean=merchant_clean,
            posted_at=posted_at,
            amount_cents=amount_cents,
        )
        for merchant_norm, merchant_raw, merchant_clean, posted_at, amount_cents in rows
    ]


def run_detection(session: Session, user_id: uuid.UUID, today: dt.date) -> DetectionResult:
    """Detect the user's charges and bring ``recurring_charges`` up to date
    (rules 11-15). ``session`` is the user's, under RLS."""
    # Two runs for one user never interleave: the second waits for the first
    # to commit, then reads its rows.
    session.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"),
        {"key": f"recurring.detect:{user_id}"},
    )
    charges = _read_charges(session)
    merchants = {charge.merchant_norm for charge in charges}
    stored = {
        (row.merchant_norm, row.cadence): row
        for row in session.scalars(select(RecurringCharge).order_by(RecurringCharge.id))
    }
    entered: dict[RecurringStatus, int] = defaultdict(int)
    found = detect(charges, today)
    for detected in found:
        row = stored.pop((detected.merchant_norm, detected.cadence), None)
        status = next_status(None if row is None else _stored(row), detected)
        if row is None:
            row = RecurringCharge(
                user_id=user_id,
                merchant_norm=detected.merchant_norm,
                merchant_clean=detected.merchant_clean,
                cadence=detected.cadence,
            )
            session.add(row)
            previous = None
        else:
            previous = row.status
        row.typical_amount_cents = detected.typical_amount_cents
        row.first_seen = detected.first_seen
        row.last_seen = detected.last_seen
        row.status = status
        if status is not previous:
            entered[status] += 1
    deleted = 0
    for row in stored.values():
        if row.merchant_norm not in merchants:
            session.delete(row)
            deleted += 1
            continue
        status = undetected_status(_stored(row), today)
        if status is not row.status:
            row.status = status
            entered[status] += 1
    session.flush()
    return DetectionResult(
        detected=len(found),
        new=entered[RecurringStatus.NEW],
        changed=entered[RecurringStatus.CHANGED],
        stopped=entered[RecurringStatus.STOPPED],
        deleted=deleted,
    )
