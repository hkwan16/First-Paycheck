"""Field types shared by calculators and the API models that feed them."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from decimal import Decimal
from types import MappingProxyType
from typing import Annotated, Any, Final, Literal

from pydantic import (
    AfterValidator,
    Field,
    GetCoreSchemaHandler,
    GetJsonSchemaHandler,
    ValidationInfo,
)
from pydantic.json_schema import JsonSchemaValue

__all__ = [
    "MAX_CENTS",
    "MAX_PERIOD_CENTS",
    "MAX_YEARLY_CENTS",
    "STORED",
    "Cents",
    "EntryLimit",
    "PayPeriods",
    "Percent",
    "PositiveCents",
    "PositivePercent",
    "ResultPercent",
    "Salary",
    "SignedCents",
    "dollars",
    "is_stored",
    "monthly",
    "per_paycheck",
    "yearly",
]

# A sanity bound well inside bigint: $1 billion. A larger amount a user types
# is a typo, and refusing it here keeps it from overflowing a column later.
MAX_CENTS = 100_000_000_000

# Entry limits (spec 007 rule 2a, issue 238): what a person may type, tighter
# than what a calculator can compute with, so every input within them gives a
# result that fits its type. $10,000,000 a year; $1,000,000 a month or a paycheck.
MAX_YEARLY_CENTS = 1_000_000_000
MAX_PERIOD_CENTS = 100_000_000

# The validation context for reading a stored decision's inputs (spec 007 rule
# 2b): the calculators' own invariants hold, the entry limits do not, so a
# version saved under an older limit still reads.
STORED: Final[Mapping[str, bool]] = MappingProxyType({"stored": True})


def is_stored(context: object) -> bool:
    """Whether a validation runs over a stored decision's inputs (``STORED``)."""
    return isinstance(context, Mapping) and bool(context.get("stored"))


def dollars(cents: int) -> str:
    """Cents as a person reads them in a refusal: 440000 is "$4,400.00"."""
    sign = "-" if cents < 0 else ""
    whole, part = divmod(abs(cents), 100)
    return f"{sign}${whole:,}.{part:02d}"


@dataclass(frozen=True)
class EntryLimit:
    """``Annotated`` metadata: the most a person may enter in a field.

    Over the limit, ``sentence`` is the field's error (a ``ValueError``, so the
    API sends it as it is: spec 008 rule 22a), except under ``STORED``.
    ``{plan}`` in the sentence is the name of the health plan the field belongs
    to. The JSON schema's ``maximum`` is the limit, so the client's mirror can
    be checked against ``openapi.json``.
    """

    maximum: int
    sentence: str

    def __get_pydantic_core_schema__(self, source: Any, handler: GetCoreSchemaHandler) -> Any:
        return AfterValidator(self._check).__get_pydantic_core_schema__(source, handler)

    def __get_pydantic_json_schema__(
        self, schema: Any, handler: GetJsonSchemaHandler
    ) -> JsonSchemaValue:
        json_schema = handler(schema)
        json_schema["maximum"] = self.maximum
        return json_schema

    def _check(self, value: int, info: ValidationInfo) -> int:
        if value > self.maximum and not is_stored(info.context):
            plan = info.data.get("name") if isinstance(info.data, Mapping) else None
            raise ValueError(self.sentence.replace("{plan}", plan or "This plan"))
        return value


def yearly(what: str) -> EntryLimit:
    """A yearly amount: "Enter a salary up to $10,000,000.00 a year." """
    return EntryLimit(MAX_YEARLY_CENTS, f"{what} up to {dollars(MAX_YEARLY_CENTS)} a year.")


def monthly(what: str) -> EntryLimit:
    """A monthly amount: "Enter essential spending up to $1,000,000.00 a month." """
    return EntryLimit(MAX_PERIOD_CENTS, f"{what} up to {dollars(MAX_PERIOD_CENTS)} a month.")


def per_paycheck(what: str) -> EntryLimit:
    """A per-paycheck amount: "Enter a health premium up to $1,000,000.00 a paycheck." """
    return EntryLimit(MAX_PERIOD_CENTS, f"{what} up to {dollars(MAX_PERIOD_CENTS)} a paycheck.")


# Integer cents. Strict, so 2708.33 and "270833" are refused, never coerced.
Cents = Annotated[int, Field(strict=True, ge=0, le=MAX_CENTS)]
PositiveCents = Annotated[int, Field(strict=True, gt=0, le=MAX_CENTS)]
# An amount that can fall below zero, such as a net cost an employer's HSA
# contribution more than covers.
SignedCents = Annotated[int, Field(strict=True, ge=-MAX_CENTS, le=MAX_CENTS)]
# The yearly salary the 401(k), health plan and W-4 calculators read and PUT
# /profile saves (spec 006 rule 13a).
Salary = Annotated[PositiveCents, yearly("Enter a salary")]

# Paychecks per year: monthly, semimonthly, biweekly, weekly.
PayPeriods = Literal[12, 24, 26, 52]

_HUNDREDTH = Decimal("0.01")


def _two_places(value: Decimal) -> Decimal:
    # Stored and returned with exactly two places: "6" and "6.0" both become "6.00".
    return value.quantize(_HUNDREDTH)


# A percentage from 0 to 100 with at most two decimal places, as a Decimal
# (never a float); JSON carries it as a string.
Percent = Annotated[
    Decimal,
    Field(ge=0, le=100, max_digits=5, decimal_places=2),
    AfterValidator(_two_places),
]
# A rate a calculator reports, with exactly two places ("5.00").
ResultPercent = Annotated[Decimal, AfterValidator(_two_places)]
PositivePercent = Annotated[
    Decimal,
    Field(gt=0, le=100, max_digits=5, decimal_places=2),
    AfterValidator(_two_places),
]
