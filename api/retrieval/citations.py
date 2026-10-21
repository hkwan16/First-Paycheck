"""Curated IRS passages per calculator and tax year (spec 008 rule 5)."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.orm import Session

from db.enums import CalculatorKind
from db.models import IrsCitation

__all__ = ["Citation", "by_key", "for_calculator"]


@dataclass(frozen=True)
class Citation:
    key: str
    title: str
    url: str
    passage: str
    source: str
    tax_year: int


def for_calculator(
    session: Session, calculator: CalculatorKind | str, tax_year: int
) -> list[Citation]:
    """Every seeded citation for ``calculator`` in ``tax_year``, ordered by key."""
    rows = session.scalars(
        select(IrsCitation)
        .where(
            IrsCitation.calculator == CalculatorKind(calculator),
            IrsCitation.tax_year == tax_year,
        )
        .order_by(IrsCitation.key)
    )
    return [
        Citation(
            key=row.key,
            title=row.title,
            url=row.url,
            passage=row.passage,
            source=row.source,
            tax_year=row.tax_year,
        )
        for row in rows
    ]


def by_key(citations: Sequence[Citation], keys: Sequence[str]) -> list[Citation]:
    """The citations named by ``keys``, in that order; unknown keys are skipped."""
    known = {citation.key: citation for citation in citations}
    return [known[key] for key in keys if key in known]
