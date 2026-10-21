"""Every category has exactly one spending bucket (spec 007 rule 20)."""

from __future__ import annotations

from typing import get_args

from calc.spending import Bucket
from sync.categories import CATEGORIES, CATEGORY_BUCKETS


def test_every_category_has_a_bucket() -> None:
    assert set(CATEGORY_BUCKETS) == set(CATEGORIES)
    assert set(CATEGORY_BUCKETS.values()) <= set(get_args(Bucket))


def test_bucket_assignments() -> None:
    def members(bucket: str) -> set[str]:
        return {category for category, value in CATEGORY_BUCKETS.items() if value == bucket}

    assert members("income") == {"income"}
    assert members("transfer") == {"transfer"}
    assert members("savings") == {"savings_investment"}
    assert members("essentials") == {
        "housing",
        "utilities",
        "phone_internet",
        "groceries",
        "transport",
        "insurance",
        "healthcare",
    }
    assert members("flexible") == {
        "dining",
        "subscriptions",
        "shopping",
        "entertainment",
        "travel",
        "personal_care",
        "education",
        "gifts_donations",
    }
    assert members("other") == {"debt_payment", "fees", "taxes", "other"}
