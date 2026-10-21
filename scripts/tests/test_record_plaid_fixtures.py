"""The Plaid fixture recorder is a stub until M1; its CLI already parses."""

from __future__ import annotations

import pytest

from scripts import record_plaid_fixtures


def test_arguments_have_sandbox_defaults() -> None:
    args = record_plaid_fixtures.parse_args([])
    assert args.institution == "ins_109508"
    assert args.username == "user_good"
    assert args.products == ["transactions"]


def test_products_and_output_are_configurable() -> None:
    args = record_plaid_fixtures.parse_args(
        ["--products", "transactions", "investments", "--out", "/tmp/plaid"]
    )
    assert args.products == ["transactions", "investments"]
    assert str(args.out) == "/tmp/plaid"


def test_running_it_says_not_implemented(capsys: pytest.CaptureFixture[str]) -> None:
    assert record_plaid_fixtures.main([]) == 2
    assert "not implemented" in capsys.readouterr().err
