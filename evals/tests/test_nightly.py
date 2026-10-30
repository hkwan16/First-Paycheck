"""The nightly workflow's issue body (``evals/nightly.py``)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from evals import nightly

RUN_URL = "https://github.com/example/first-paycheck/actions/runs/1"
REPORT = {
    "suites": {
        "calc": {
            "metrics": {"pass_rate": 1.0},
            "cases": 40,
            "failures": [],
            "cost_cents": 0.0,
            "regressions": [],
        },
        "extraction": {
            "metrics": {"field_accuracy": 0.91},
            "cases": 30,
            "failures": ["stub-12 net_cents: expected 224574, got 224575"],
            "cost_cents": 96.5,
            "regressions": ["field_accuracy 0.9100 < baseline 0.9500 (tolerance 0.0200)"],
        },
    },
    "spent_cents": 96.5,
}


def test_a_regression_names_the_suite_metric_and_run() -> None:
    body = nightly.issue_body(REPORT, exit_code=1, run_url=RUN_URL, llm_ran=True)
    assert nightly.TITLE == "Nightly evals regressed"
    assert "extraction" in body
    assert "field_accuracy 0.9100 < baseline 0.9500 (tolerance 0.0200)" in body
    assert "stub-12 net_cents" in body
    assert RUN_URL in body
    assert "96.50 cents" in body
    # Suites that passed are listed as passing, not as regressions.
    assert "| calc | ok |" in body
    assert "| extraction | regressed |" in body


def test_a_stopped_run_says_why() -> None:
    report = {**REPORT, "stopped": "extraction: stopped, spent 301.00 cents, cap is 300.00 cents"}
    body = nightly.issue_body(report, exit_code=2, run_url=RUN_URL, llm_ran=True)
    assert "spent 301.00 cents, cap is 300.00 cents" in body


def test_a_missing_report_still_makes_a_body() -> None:
    body = nightly.issue_body(None, exit_code=2, run_url=RUN_URL, llm_ran=False)
    assert "no report" in body
    assert "LLM suites were skipped" in body


def test_failures_are_capped_per_suite() -> None:
    failures = [f"row {n}: wrong" for n in range(100)]
    report = {
        "suites": {
            "categorization": {
                "metrics": {"accuracy": 0.5},
                "cases": 500,
                "failures": failures,
                "cost_cents": 0.4,
                "regressions": ["accuracy 0.5000 < baseline 0.9000 (tolerance 0.0270)"],
            }
        }
    }
    body = nightly.issue_body(report, exit_code=1, run_url=RUN_URL, llm_ran=True)
    assert "row 19: wrong" in body
    assert "row 20: wrong" not in body
    assert "80 more" in body


def test_the_cli_prints_the_body(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    path = tmp_path / "report.json"
    path.write_text(json.dumps(REPORT))
    argv = ["--report", str(path), "--exit-code", "1", "--run-url", RUN_URL, "--llm-ran"]
    assert nightly.main(argv) == 0
    assert "field_accuracy 0.9100" in capsys.readouterr().out


def test_the_cli_tolerates_an_absent_report(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    argv = ["--report", str(tmp_path / "none.json"), "--exit-code", "2", "--run-url", RUN_URL]
    assert nightly.main(argv) == 0
    assert "no report" in capsys.readouterr().out
