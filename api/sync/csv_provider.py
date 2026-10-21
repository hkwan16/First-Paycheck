"""A bank's CSV export as a ``SyncProvider`` (spec 010 part B).

``parse_csv`` reads and checks the whole file first: every problem is
reported with its row number, and nothing reaches the pipeline unless the
file is clean. ``CsvProvider`` then serves the parsed rows to
``pipeline.run_sync`` as one account and one page, in Plaid's sign
convention (positive is money out, spec 001 rule 21).
"""

from __future__ import annotations

import csv
import datetime as dt
import hashlib
import io
import re
from collections import Counter
from collections.abc import Sequence
from dataclasses import dataclass, field
from decimal import Decimal
from enum import StrEnum

from db.enums import AccountKind
from sync.provider import (
    ProviderAccount,
    ProviderBalance,
    ProviderHolding,
    ProviderTransaction,
    TransactionPage,
)

__all__ = [
    "MAX_PROBLEMS",
    "MAX_ROWS",
    "PROVIDER_ACCOUNT_ID",
    "AmountSign",
    "CsvInvalid",
    "CsvProblem",
    "CsvProvider",
    "CsvRow",
    "ParsedCsv",
    "parse_csv",
    "parse_money",
]

MAX_ROWS = 50_000
MAX_PROBLEMS = 50
MAX_DESCRIPTION = 500
# One CSV item holds one account (rule 17).
PROVIDER_ACCOUNT_ID = "csv"

# Accepted header names for each column role (rule 8).
COLUMNS: dict[str, frozenset[str]] = {
    "date": frozenset({"date", "posted date", "posting date", "transaction date"}),
    "description": frozenset({"description", "name", "payee", "merchant"}),
    "amount": frozenset({"amount"}),
    "debit": frozenset({"debit", "withdrawal"}),
    "credit": frozenset({"credit", "deposit"}),
    "balance": frozenset({"balance", "running balance"}),
}
_ROLE_OF = {name: role for role, names in COLUMNS.items() for name in names}

_MONEY = re.compile(r"([+-])?\$?((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?|\.\d{1,2})")
_ISO_DATE = re.compile(r"\d{4}-\d{2}-\d{2}")
_US_DATE = re.compile(r"(\d{1,2})/(\d{1,2})/(\d{4})")


class AmountSign(StrEnum):
    """How the file's ``amount`` column is signed (rule 12)."""

    NEGATIVE_IS_OUT = "negative_is_out"
    POSITIVE_IS_OUT = "positive_is_out"


@dataclass(frozen=True)
class CsvProblem:
    # Counting the header as row 1; None for the whole file.
    row: int | None
    # The column role (date, description, amount, balance); None for the row or file.
    column: str | None
    message: str


class CsvInvalid(ValueError):
    """The file breaks a rule; ``problems`` holds the first ``MAX_PROBLEMS`` in file order."""

    def __init__(self, problems: Sequence[CsvProblem], total: int | None = None) -> None:
        self.problems = list(problems)
        self.total = len(self.problems) if total is None else total
        noun = "problem" if self.total == 1 else "problems"
        super().__init__(f"The CSV has {self.total} {noun}")


@dataclass(frozen=True)
class CsvRow:
    row: int
    posted_at: dt.date
    # Positive is money out.
    amount_cents: int
    description: str
    provider_txn_id: str
    balance_cents: int | None


@dataclass(frozen=True)
class ParsedCsv:
    rows: list[CsvRow]
    balance_cents: int | None
    # "csv-" and the file's SHA-256: the pipeline's cursor for this import.
    cursor: str


def parse_money(text: str) -> int | None:
    """Cents from a money cell (rule 11), exactly; None when it is not money."""
    value = text.strip()
    negative = value.startswith("(") and value.endswith(")")
    if negative:
        value = value[1:-1].strip()
    match = _MONEY.fullmatch(value)
    if match is None:
        return None
    sign, number = match.groups()
    if negative and sign is not None:
        return None
    cents = int(Decimal(number.replace(",", "")) * 100)
    return -cents if negative or sign == "-" else cents


def _parse_date(text: str) -> dt.date | None:
    value = text.strip()
    try:
        if _ISO_DATE.fullmatch(value):
            return dt.date.fromisoformat(value)
        us = _US_DATE.fullmatch(value)
        if us:
            month, day, year = (int(part) for part in us.groups())
            return dt.date(year, month, day)
    except ValueError:
        return None
    return None


def _decode(data: bytes) -> str:
    try:
        return data.decode("utf-8-sig")
    except UnicodeDecodeError:
        raise CsvInvalid([CsvProblem(None, None, "The file is not UTF-8 text")]) from None


def _header(cells: Sequence[str]) -> dict[str, int]:
    """Column role to index; raises with every header problem on row 1."""
    found: dict[str, list[int]] = {}
    for index, cell in enumerate(cells):
        role = _ROLE_OF.get(" ".join(cell.strip().lower().split()))
        if role is not None:
            found.setdefault(role, []).append(index)
    problems: list[CsvProblem] = []
    for role, indexes in found.items():
        if len(indexes) > 1:
            names = " and ".join(cells[index].strip() for index in indexes)
            problems.append(CsvProblem(1, role, f"Two columns are the {role}: {names}"))
    for role in ("date", "description"):
        if role not in found:
            names = ", ".join(sorted(COLUMNS[role]))
            problems.append(CsvProblem(1, role, f"No {role} column (one of: {names})"))
    has_amount = "amount" in found
    has_debit, has_credit = "debit" in found, "credit" in found
    if has_amount and (has_debit or has_credit):
        problems.append(
            CsvProblem(1, "amount", "Use either an amount column or debit and credit, not both")
        )
    elif not has_amount and not (has_debit and has_credit):
        problems.append(
            CsvProblem(1, "amount", "No amount column, and no pair of debit and credit columns")
        )
    if problems:
        order = list(COLUMNS)
        raise CsvInvalid(sorted(problems, key=lambda p: order.index(p.column or "date")))
    return {role: indexes[0] for role, indexes in found.items()}


@dataclass
class _Rows:
    sign: AmountSign
    columns: dict[str, int]
    rows: list[tuple[int, dt.date, int, str, int | None]] = field(default_factory=list)
    problems: list[CsvProblem] = field(default_factory=list)

    def cell(self, cells: Sequence[str], role: str) -> str:
        index = self.columns.get(role)
        if index is None or index >= len(cells):
            return ""
        return cells[index].strip()

    def amount(self, number: int, cells: Sequence[str]) -> int | None:
        if "amount" in self.columns:
            cents = parse_money(self.cell(cells, "amount"))
            if cents is None:
                self.problems.append(
                    CsvProblem(number, "amount", "Not an amount with at most two decimal places")
                )
                return None
            return -cents if self.sign is AmountSign.NEGATIVE_IS_OUT else cents
        debit, credit = self.cell(cells, "debit"), self.cell(cells, "credit")
        if bool(debit) == bool(credit):
            self.problems.append(
                CsvProblem(number, "amount", "Fill exactly one of debit and credit")
            )
            return None
        cents = parse_money(debit or credit)
        if cents is None or cents < 0:
            self.problems.append(
                CsvProblem(number, "amount", "Debit and credit are amounts of zero or more")
            )
            return None
        return cents if debit else -cents

    def add(self, number: int, cells: Sequence[str]) -> None:
        before = len(self.problems)
        posted_at = _parse_date(self.cell(cells, "date"))
        if posted_at is None:
            self.problems.append(
                CsvProblem(number, "date", "Not a date; use YYYY-MM-DD or MM/DD/YYYY")
            )
        description = " ".join(self.cell(cells, "description").split())
        if not description:
            self.problems.append(CsvProblem(number, "description", "The description is empty"))
        elif len(description) > MAX_DESCRIPTION:
            self.problems.append(
                CsvProblem(number, "description", f"Longer than {MAX_DESCRIPTION} characters")
            )
        amount = self.amount(number, cells)
        balance_text = self.cell(cells, "balance")
        balance = parse_money(balance_text) if balance_text else None
        if balance_text and balance is None:
            self.problems.append(
                CsvProblem(number, "balance", "Not an amount with at most two decimal places")
            )
        if len(self.problems) == before and posted_at is not None and amount is not None:
            self.rows.append((number, posted_at, amount, description, balance))


def _txn_ids(rows: Sequence[tuple[int, dt.date, int, str, int | None]]) -> list[str]:
    """Rule 15: stable ids, with the occurrence number telling identical rows apart."""
    seen: Counter[tuple[dt.date, int, str]] = Counter()
    ids = []
    for _, posted_at, amount, description, _ in rows:
        key = (posted_at, amount, description)
        seen[key] += 1
        digest = hashlib.sha256(
            f"{posted_at.isoformat()}|{amount}|{description}|{seen[key]}".encode()
        ).hexdigest()
        ids.append(f"csv-{digest[:32]}")
    return ids


def _balance(rows: Sequence[CsvRow]) -> int | None:
    """Rule 13: the balance on the newest row that has one."""
    with_balance = [row for row in rows if row.balance_cents is not None]
    if not with_balance:
        return None
    newest = max(row.posted_at for row in with_balance)
    candidates = [row for row in with_balance if row.posted_at == newest]
    oldest_first = rows[0].posted_at <= rows[-1].posted_at
    chosen = candidates[-1] if oldest_first else candidates[0]
    return chosen.balance_cents


def parse_csv(data: bytes, sign: AmountSign = AmountSign.NEGATIVE_IS_OUT) -> ParsedCsv:
    """The file's rows in the shared sign convention; raises ``CsvInvalid``."""
    text = _decode(data)
    if not text.strip():
        raise CsvInvalid([CsvProblem(None, None, "The file is empty")])
    reader = csv.reader(io.StringIO(text, newline=""))
    try:
        records = list(reader)
    except csv.Error as exc:
        raise CsvInvalid([CsvProblem(reader.line_num, None, f"Not valid CSV: {exc}")]) from None
    columns = _header(records[0])
    body = [
        (number, cells)
        for number, cells in enumerate(records[1:], start=2)
        if any(cell.strip() for cell in cells)
    ]
    if not body:
        raise CsvInvalid([CsvProblem(None, None, "The file has no transactions")])
    if len(body) > MAX_ROWS:
        raise CsvInvalid(
            [CsvProblem(None, None, f"The file has more than {MAX_ROWS:,} transactions")]
        )
    collected = _Rows(sign=sign, columns=columns)
    for number, cells in body:
        collected.add(number, cells)
    if collected.problems:
        raise CsvInvalid(collected.problems[:MAX_PROBLEMS], total=len(collected.problems))
    rows = [
        CsvRow(
            row=number,
            posted_at=posted_at,
            amount_cents=amount,
            description=description,
            provider_txn_id=txn_id,
            balance_cents=balance,
        )
        for (number, posted_at, amount, description, balance), txn_id in zip(
            collected.rows, _txn_ids(collected.rows), strict=True
        )
    ]
    return ParsedCsv(
        rows=rows,
        balance_cents=_balance(rows),
        cursor=f"csv-{hashlib.sha256(data).hexdigest()}",
    )


class CsvProvider:
    """One parsed file as a ``SyncProvider``: one account, one page, no holdings."""

    def __init__(self, parsed: ParsedCsv, *, name: str, kind: AccountKind) -> None:
        self._parsed = parsed
        self._account = ProviderAccount(
            provider_account_id=PROVIDER_ACCOUNT_ID, name=name, kind=kind, mask=None
        )

    def fetch_accounts(self) -> list[ProviderAccount]:
        return [self._account]

    def fetch_transactions(self, cursor: str | None) -> TransactionPage:
        return TransactionPage(
            added=[
                ProviderTransaction(
                    provider_txn_id=row.provider_txn_id,
                    provider_account_id=PROVIDER_ACCOUNT_ID,
                    posted_at=row.posted_at,
                    amount_cents=row.amount_cents,
                    merchant_raw=row.description,
                    merchant_clean=None,
                    pending=False,
                )
                for row in self._parsed.rows
            ],
            modified=[],
            removed=[],
            next_cursor=self._parsed.cursor,
            has_more=False,
        )

    def fetch_balances(self) -> list[ProviderBalance]:
        if self._parsed.balance_cents is None:
            return []
        return [
            ProviderBalance(
                provider_account_id=PROVIDER_ACCOUNT_ID, balance_cents=self._parsed.balance_cents
            )
        ]

    def fetch_holdings(self) -> list[ProviderHolding]:
        return []
