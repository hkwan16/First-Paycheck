"""PlaidProvider: Plaid JSON to provider DTOs (spec 002 rules 2-9, examples 1-2)."""

from __future__ import annotations

import datetime as dt
import json
from decimal import Decimal
from pathlib import Path
from typing import Any

import pytest
from pydantic import SecretStr

from db.enums import AccountKind
from jobs.errors import RetryLater
from sync.plaid.client import PlaidError
from sync.plaid.provider import PlaidProvider, account_kind, to_cents
from sync.provider import ItemLoginRequired, PaginationMutated

FIXTURES = Path(__file__).resolve().parents[2] / "fixtures" / "plaid"
TOKEN = SecretStr("access-sandbox-test-token")
FIRST_CURSOR = json.loads((FIXTURES / "transactions_sync_page1.json").read_text())["next_cursor"]


def fixture(name: str) -> dict[str, Any]:
    data: dict[str, Any] = json.loads((FIXTURES / f"{name}.json").read_text(), parse_float=Decimal)
    return data


def plaid_error(code: str, error_type: str = "ITEM_ERROR") -> PlaidError:
    return PlaidError(code=code, error_type=error_type, message=code.lower(), request_id="r1")


class FakeClient:
    """Serves fixtures the way PlaidClient returns parsed JSON."""

    def __init__(self, **overrides: Any) -> None:
        self.calls: list[tuple[str, Any]] = []
        self.overrides = overrides

    def _answer(self, name: str, default: Any) -> dict[str, Any]:
        answer = self.overrides.get(name, default)
        if isinstance(answer, list):
            answer = answer.pop(0)
        if isinstance(answer, Exception):
            raise answer
        result: dict[str, Any] = answer
        return result

    def accounts_get(self, access_token: SecretStr) -> dict[str, Any]:
        self.calls.append(("accounts_get", access_token.get_secret_value()))
        return self._answer("accounts_get", fixture("accounts_get"))

    def transactions_sync(self, access_token: SecretStr, cursor: str | None) -> dict[str, Any]:
        self.calls.append(("transactions_sync", cursor))
        page = "transactions_sync_page1" if cursor is None else "transactions_sync_page2"
        return self._answer("transactions_sync", fixture(page))

    def investments_holdings_get(self, access_token: SecretStr) -> dict[str, Any]:
        self.calls.append(("investments_holdings_get", None))
        return self._answer("investments_holdings_get", fixture("investments_holdings_get"))


def provider(client: FakeClient) -> PlaidProvider:
    return PlaidProvider(client, TOKEN)


@pytest.mark.parametrize(
    ("dollars", "cents"),
    [
        (Decimal("89.4"), 8940),
        (12, 1200),
        (Decimal("0.005"), 1),
        (Decimal("-0.005"), -1),
        (Decimal("4.335"), 434),
        (Decimal("-1234.567"), -123457),
        (Decimal("23631.9805"), 2363198),
    ],
)
def test_cents_from_plaid_amounts(dollars: Decimal | int, cents: int) -> None:
    assert to_cents(dollars) == cents


def test_floats_are_refused() -> None:
    with pytest.raises(TypeError, match="Decimal"):
        to_cents(4.335)  # type: ignore[arg-type]


@pytest.mark.parametrize(
    ("plaid_type", "subtype", "kind"),
    [
        ("depository", "checking", AccountKind.CHECKING),
        ("depository", "cd", AccountKind.SAVINGS),
        ("depository", "money market", AccountKind.SAVINGS),
        ("depository", "paypal", AccountKind.CHECKING),
        ("credit", "credit card", AccountKind.CREDIT),
        ("loan", "student", AccountKind.LOAN),
        ("loan", "mortgage", AccountKind.LOAN),
        ("loan", "auto", AccountKind.LOAN),
        ("loan", "home equity", AccountKind.LOAN),
        ("loan", "line of credit", AccountKind.LOAN),
        ("loan", None, AccountKind.LOAN),
        ("investment", "401k", AccountKind.RETIREMENT),
        ("investment", "roth 401k", AccountKind.RETIREMENT),
        ("investment", "brokerage", AccountKind.INVESTMENT),
        ("other", "other", None),
        ("brokerage", None, None),
    ],
)
def test_account_kind_mapping(
    plaid_type: str, subtype: str | None, kind: AccountKind | None
) -> None:
    assert account_kind(plaid_type, subtype) == kind


def test_accounts_and_balances_share_one_call() -> None:
    client = FakeClient()
    plaid = provider(client)
    accounts = plaid.fetch_accounts()
    balances = plaid.fetch_balances()

    assert [call[0] for call in client.calls] == ["accounts_get"]
    assert client.calls[0][1] == "access-sandbox-test-token"
    by_name = {account.name: account for account in accounts}
    assert "Plaid Rewards Ledger" not in by_name  # type "other" is skipped
    assert by_name["Plaid 401k"].kind is AccountKind.RETIREMENT
    assert by_name["Plaid Student Loan"].kind is AccountKind.LOAN
    assert by_name["Plaid Checking"].mask == "0000"
    cents = {b.provider_account_id: b.balance_cents for b in balances}
    assert cents["BxBXxLj1m4HMXBm9WZZmCWVbPjX16EHwv99vp"] == 11000
    assert cents["6PdjjRP6LmugpBy5NgQvUqpRXMWxzktg3rwrk"] == 2363198
    assert cents["Pp1Vpkl9w8sajvK6oEEKtr7vZxBnGpf7LxxLE"] == 100000
    # Neither current nor available: no snapshot for the skipped account.
    assert "Ek3XR7cQ1qcKG4qX6Mdyj9Nm7VNdZGs5y5Xx8" not in cents


def test_a_non_digit_mask_is_dropped() -> None:
    accounts = fixture("accounts_get")
    accounts["accounts"][0]["mask"] = "x0"
    plaid = provider(FakeClient(accounts_get=accounts))
    assert plaid.fetch_accounts()[0].mask is None


def test_transaction_pages() -> None:
    plaid = provider(FakeClient())
    first = plaid.fetch_transactions(None)
    assert first.has_more is True
    assert first.next_cursor == FIRST_CURSOR
    uber = first.added[0]
    assert (uber.amount_cents, uber.merchant_raw, uber.merchant_clean, uber.posted_at) == (
        633,
        "Uber 063015 SF**POOL**",
        "Uber",
        dt.date(2026, 10, 1),
    )
    starbucks = first.added[2]
    assert (starbucks.amount_cents, starbucks.pending) == (434, True)
    assert first.added[3].amount_cents == -50000

    second = plaid.fetch_transactions(first.next_cursor)
    assert second.has_more is False
    assert [t.amount_cents for t in second.added] == [-422, -250000, 8940]
    assert second.added[0].merchant_clean is None
    assert second.modified[0].amount_cents == 1325
    assert [r.provider_txn_id for r in second.removed] == ["Pp1Vpkl9w8sajvK6oEEKtr7vZxBnGpf7LxxPP"]


def test_holdings() -> None:
    holdings = provider(FakeClient()).fetch_holdings()
    assert [(h.ticker, h.value_cents, h.cost_basis_cents, h.as_of) for h in holdings] == [
        ("USD", 1, 100, dt.date(2026, 10, 20)),
        ("MIPTX", 63631, 2300, None),
    ]
    assert holdings[1].quantity == Decimal("23.56107")
    assert holdings[1].name == "Matthews Pacific Tiger Fund Insti Class"


@pytest.mark.parametrize(
    "code",
    [
        "PRODUCTS_NOT_SUPPORTED",
        "NO_INVESTMENT_ACCOUNTS",
        "PRODUCT_NOT_ENABLED",
        "INVALID_PRODUCT",
        "ADDITIONAL_CONSENT_REQUIRED",
    ],
)
def test_items_without_investments_have_no_holdings(code: str) -> None:
    client = FakeClient(investments_holdings_get=plaid_error(code))
    assert provider(client).fetch_holdings() == []


def test_product_not_ready_retries_later() -> None:
    client = FakeClient(transactions_sync=plaid_error("PRODUCT_NOT_READY"))
    with pytest.raises(RetryLater):
        provider(client).fetch_transactions(None)


def test_first_sync_before_data_is_ready_retries_later() -> None:
    empty = fixture("transactions_sync_page1")
    empty.update(added=[], has_more=False, transactions_update_status="NOT_READY")
    with pytest.raises(RetryLater):
        provider(FakeClient(transactions_sync=empty)).fetch_transactions(None)


def test_mutation_during_pagination_is_typed() -> None:
    error = plaid_error("TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION", "TRANSACTIONS_ERROR")
    with pytest.raises(PaginationMutated):
        provider(FakeClient(transactions_sync=error)).fetch_transactions("c1")


def test_login_required_is_typed() -> None:
    with pytest.raises(ItemLoginRequired):
        provider(FakeClient(accounts_get=plaid_error("ITEM_LOGIN_REQUIRED"))).fetch_accounts()


def test_other_errors_pass_through() -> None:
    error = plaid_error("INTERNAL_SERVER_ERROR", "API_ERROR")
    with pytest.raises(PlaidError, match="INTERNAL_SERVER_ERROR"):
        provider(FakeClient(transactions_sync=error)).fetch_transactions(None)


# Responses recorded from the Plaid sandbox (scripts/record_plaid_fixtures.py) with ids and
# tokens scrubbed. The hand-written fixtures above cover scenarios the sandbox does not return
# (pagination, modified and removed rows, a pending row); these check the real shapes.
RECORDED = FIXTURES / "recorded"


def recorded(name: str) -> dict[str, Any]:
    data: dict[str, Any] = json.loads((RECORDED / f"{name}.json").read_text(), parse_float=Decimal)
    return data


def test_recorded_sandbox_accounts_map_to_every_kind_we_support() -> None:
    client = FakeClient(accounts_get=recorded("accounts_get"))
    accounts = provider(client).fetch_accounts()
    assert len(accounts) == 14
    kinds = {account.name: account.kind for account in accounts}
    assert kinds["Plaid Checking"] is AccountKind.CHECKING
    assert kinds["Plaid Saving"] is AccountKind.SAVINGS
    assert kinds["Plaid Credit Card"] is AccountKind.CREDIT
    assert kinds["Plaid 401k"] is AccountKind.RETIREMENT
    assert kinds["Plaid Business Credit Card"] is AccountKind.CREDIT
    # Plaid type "loan" is a loan, never a credit card (spec 002 rule 4).
    assert sorted(name for name, kind in kinds.items() if kind is AccountKind.LOAN) == [
        "Plaid Auto Loan",
        "Plaid Home Equity Line of Credit",
        "Plaid Mortgage",
        "Plaid Student Loan",
    ]
    assert all(account.mask is None or account.mask.isdigit() for account in accounts)
    balances = provider(client).fetch_balances()
    assert {b.provider_account_id for b in balances} <= {a.provider_account_id for a in accounts}


def test_recorded_sandbox_transactions_parse_as_one_complete_page() -> None:
    page = recorded("transactions_sync_page1")
    client = FakeClient(transactions_sync=page)
    first = provider(client).fetch_transactions(None)
    assert first.has_more is False
    assert first.next_cursor == page["next_cursor"]
    assert len(first.added) == 49
    assert first.modified == []
    assert first.removed == []
    assert all(isinstance(t.amount_cents, int) for t in first.added)
    assert all(t.merchant_raw for t in first.added)
    assert all(isinstance(t.posted_at, dt.date) for t in first.added)
    assert {t.provider_account_id for t in first.added} <= {
        account["account_id"] for account in page["accounts"]
    }


def test_recorded_sandbox_holdings_parse() -> None:
    client = FakeClient(investments_holdings_get=recorded("investments_holdings_get"))
    holdings = provider(client).fetch_holdings()
    assert len(holdings) == 13
    assert all(isinstance(h.value_cents, int) for h in holdings)
    assert all(h.quantity > 0 for h in holdings)
