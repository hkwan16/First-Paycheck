"""The spending categories (spec 003). The single source: the LLM schema, the
seed loader and the routes all validate against this list."""

from __future__ import annotations

from collections.abc import Mapping
from types import MappingProxyType
from typing import Literal, get_args

from calc.spending import Bucket

Category = Literal[
    "income",
    "transfer",
    "housing",
    "utilities",
    "phone_internet",
    "groceries",
    "dining",
    "transport",
    "subscriptions",
    "insurance",
    "healthcare",
    "shopping",
    "entertainment",
    "travel",
    "personal_care",
    "education",
    "gifts_donations",
    "fees",
    "taxes",
    "debt_payment",
    "savings_investment",
    "other",
]

CATEGORIES: tuple[str, ...] = get_args(Category)

# The spending bucket of every category (spec 007 rule 20), for the summary.
CATEGORY_BUCKETS: Mapping[str, Bucket] = MappingProxyType(
    {
        "income": "income",
        "transfer": "transfer",
        "housing": "essentials",
        "utilities": "essentials",
        "phone_internet": "essentials",
        "groceries": "essentials",
        "dining": "flexible",
        "transport": "essentials",
        "subscriptions": "flexible",
        "insurance": "essentials",
        "healthcare": "essentials",
        "shopping": "flexible",
        "entertainment": "flexible",
        "travel": "flexible",
        "personal_care": "flexible",
        "education": "flexible",
        "gifts_donations": "flexible",
        "fees": "other",
        "taxes": "other",
        "debt_payment": "other",
        "savings_investment": "savings",
        "other": "other",
    }
)
