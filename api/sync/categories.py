"""The spending categories (spec 003). The single source: the LLM schema, the
seed loader and the routes all validate against this list."""

from __future__ import annotations

from typing import Literal, get_args

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
