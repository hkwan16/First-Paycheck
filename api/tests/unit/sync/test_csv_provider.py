"""sync/csv_provider.py: reading a bank's CSV export (spec 010 rules 7-15, parsing examples)."""

from __future__ import annotations

import datetime as dt

import pytest

from db.enums import AccountKind
from sync.csv_provider import (
    MAX_ROWS,
    AmountSign,
    CsvInvalid,
    CsvProblem,
    CsvProvider,
    parse_csv,
    parse_money,
)

FILE_A = (
    "Date,Description,Amount,Balance\n"
    "2026-10-01,NETFLIX.COM,-15.49,984.51\n"
    '10/02/2026,ACME PAYROLL,"1,996.04","2,980.55"\n'
    "2026-10-03,BLUE BOTTLE COFFEE,(4.50),2976.05\n"
)


def problems(text: str | bytes, sign: AmountSign = AmountSign.NEGATIVE_IS_OUT) -> list[CsvProblem]:
    data = text.encode() if isinstance(text, str) else text
    with pytest.raises(CsvInvalid) as caught:
        parse_csv(data, sign)
    return caught.value.problems


def test_amount_column_bank_convention() -> None:
    parsed = parse_csv(FILE_A.encode())
    assert [row.amount_cents for row in parsed.rows] == [1549, -199604, 450]
    assert [row.posted_at for row in parsed.rows] == [
        dt.date(2026, 10, 1),
        dt.date(2026, 10, 2),
        dt.date(2026, 10, 3),
    ]
    assert [row.description for row in parsed.rows] == [
        "NETFLIX.COM",
        "ACME PAYROLL",
        "BLUE BOTTLE COFFEE",
    ]
    assert [row.row for row in parsed.rows] == [2, 3, 4]
    assert parsed.balance_cents == 297605


def test_positive_is_out_option() -> None:
    parsed = parse_csv(FILE_A.encode(), AmountSign.POSITIVE_IS_OUT)
    assert [row.amount_cents for row in parsed.rows] == [-1549, 199604, -450]


def test_debit_and_credit_columns() -> None:
    parsed = parse_csv(
        b"Posted Date,Payee,Debit,Credit\n"
        b"2026-10-01,NETFLIX.COM,15.49,\n"
        b"2026-10-02,ACME PAYROLL,,1996.04\n"
    )
    assert [row.amount_cents for row in parsed.rows] == [1549, -199604]
    assert parsed.balance_cents is None


def test_row_errors_are_numbered() -> None:
    found = problems(
        "Date,Description,Amount,Balance\n"
        "2026-10-01,NETFLIX.COM,-15.49,984.51\n"
        "2026-13-01,BAD DATE,-1.00\n"
        "2026-10-03,,-2.00\n"
        "2026-10-04,TOO PRECISE,-1.005\n"
    )
    assert [(problem.row, problem.column) for problem in found] == [
        (3, "date"),
        (4, "description"),
        (5, "amount"),
    ]


def test_missing_columns() -> None:
    found = problems("When,What,HowMuch\n2026-10-01,X,1.00\n")
    assert [(problem.row, problem.column) for problem in found] == [
        (1, "date"),
        (1, "description"),
        (1, "amount"),
    ]


def test_identical_rows_get_distinct_stable_ids() -> None:
    data = b"Date,Description,Amount\n2026-10-01,COFFEE,-4.50\n2026-10-01,COFFEE,-4.50\n"
    first = [row.provider_txn_id for row in parse_csv(data).rows]
    again = [row.provider_txn_id for row in parse_csv(data).rows]
    assert first == again
    assert len(set(first)) == 2
    assert all(txn_id.startswith("csv-") and len(txn_id) == 36 for txn_id in first)


def test_debit_and_credit_both_filled() -> None:
    found = problems("Date,Description,Debit,Credit\n2026-10-01,X,1.00,2.00\n")
    assert [(problem.row, problem.column) for problem in found] == [(2, "amount")]


def test_newest_first_balance() -> None:
    header, *rows = FILE_A.splitlines()
    parsed = parse_csv("\n".join([header, *reversed(rows)]).encode())
    assert parsed.balance_cents == 297605


# ---------------------------------------------------------------- rules without an example


@pytest.mark.parametrize(
    ("text", "cents"),
    [
        ("12", 1200),
        ("-12.5", -1250),
        ("$1,234.56", 123456),
        ("(45.00)", -4500),
        ("+3.10", 310),
        (" -$7.05 ", -705),
        (".5", 50),
        ("0", 0),
        ("1,234,567.89", 123456789),
    ],
)
def test_money_accepted(text: str, cents: int) -> None:
    assert parse_money(text) == cents


@pytest.mark.parametrize(
    "text", ["12.345", "1,23", "12-", "abc", "", "$", "(-5.00)", "1.2.3", "12,34.00", "--1"]
)
def test_money_rejected(text: str) -> None:
    assert parse_money(text) is None


def test_header_names_are_case_and_space_insensitive() -> None:
    parsed = parse_csv(
        b"  TRANSACTION DATE , Merchant ,AMOUNT, Running Balance\n2026-10-01,X,-1,9\n"
    )
    assert [(row.description, row.amount_cents) for row in parsed.rows] == [("X", 100)]
    assert parsed.balance_cents == 900


def test_unknown_columns_are_ignored_and_blank_rows_skipped() -> None:
    parsed = parse_csv(
        b"Date,Memo,Description,Amount,Category\n"
        b"2026-10-01,note,X,-1.00,Food\n"
        b",,,,\n"
        b"\n"
        b"2026-10-05,,Y,-2.00,\n"
    )
    assert [(row.row, row.description) for row in parsed.rows] == [(2, "X"), (5, "Y")]


def test_byte_order_mark_is_ignored() -> None:
    parsed = parse_csv(b"\xef\xbb\xbf" + FILE_A.encode())
    assert len(parsed.rows) == 3


@pytest.mark.parametrize(
    ("data", "message"),
    [
        (b"", "empty"),
        (b"Date,Description,Amount\n", "no transactions"),
        (b"Date,Description,Amount\n2026-10-01,Caf\xe9,-1.00\n", "UTF-8"),
    ],
)
def test_whole_file_problems(data: bytes, message: str) -> None:
    [problem] = problems(data)
    assert (problem.row, problem.column) == (None, None)
    assert message in problem.message


def test_header_conflicts() -> None:
    both_forms = problems("Date,Description,Amount,Debit,Credit\n2026-10-01,X,1,,\n")
    assert [problem.column for problem in both_forms] == ["amount"]
    two_dates = problems("Date,Posted Date,Description,Amount\n2026-10-01,2026-10-01,X,1\n")
    assert [(problem.row, problem.column) for problem in two_dates] == [(1, "date")]
    debit_only = problems("Date,Description,Debit\n2026-10-01,X,1\n")
    assert [problem.column for problem in debit_only] == ["amount"]


def test_row_level_rules() -> None:
    found = problems(
        "Date,Description,Debit,Credit,Balance\n"
        "02/30/2026,X,1.00,,\n"  # not a real date
        "2026-10-01,X,,,\n"  # neither debit nor credit
        "2026-10-01,X,-1.00,,\n"  # negative debit
        f"2026-10-01,{'x' * 501},1.00,,\n"  # description too long
        "2026-10-01,X,1.00,,lots\n"  # balance not money
        "30/10/2026,X,1.00,,\n"  # day first
    )
    assert [(problem.row, problem.column) for problem in found] == [
        (2, "date"),
        (3, "amount"),
        (4, "amount"),
        (5, "description"),
        (6, "balance"),
        (7, "date"),
    ]


def test_at_most_fifty_problems_are_listed() -> None:
    rows = "".join(f"2026-10-01,X,bad{n}\n" for n in range(60))
    with pytest.raises(CsvInvalid) as caught:
        parse_csv(f"Date,Description,Amount\n{rows}".encode())
    assert len(caught.value.problems) == 50
    assert caught.value.total == 60


def test_too_many_rows() -> None:
    rows = "2026-10-01,X,-1.00\n" * (MAX_ROWS + 1)
    [problem] = problems(f"Date,Description,Amount\n{rows}")
    assert "50,000" in problem.message


def test_provider_reads_one_page() -> None:
    parsed = parse_csv(FILE_A.encode())
    provider = CsvProvider(parsed, name="Credit union", kind=AccountKind.CHECKING)
    [account] = provider.fetch_accounts()
    assert (account.provider_account_id, account.name, account.kind, account.mask) == (
        "csv",
        "Credit union",
        AccountKind.CHECKING,
        None,
    )
    page = provider.fetch_transactions(None)
    assert page.has_more is False
    assert (page.modified, page.removed) == ([], [])
    assert page.next_cursor == parsed.cursor
    assert parsed.cursor.startswith("csv-")
    assert [txn.amount_cents for txn in page.added] == [1549, -199604, 450]
    assert {txn.provider_account_id for txn in page.added} == {"csv"}
    assert all(txn.merchant_clean is None and not txn.pending for txn in page.added)
    assert [balance.balance_cents for balance in provider.fetch_balances()] == [297605]
    assert provider.fetch_holdings() == []


def test_provider_without_balance() -> None:
    parsed = parse_csv(b"Date,Description,Amount\n2026-10-01,X,-1\n")
    provider = CsvProvider(parsed, name="X", kind=AccountKind.SAVINGS)
    assert provider.fetch_balances() == []
