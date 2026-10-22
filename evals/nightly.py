"""The body of the issue the nightly workflow opens or updates on a regression.

    uv run python -m evals.nightly --report evals/results/nightly.json \\
        --exit-code 1 --run-url https://github.com/... [--llm-ran]

Reads the JSON ``evals.run --report`` wrote (or notes that there is none) and
prints Markdown: a table of every suite, then each regressed suite's
regressions and its first failure lines. ``.github/workflows/nightly.yml``
passes it to ``gh issue create`` or ``gh issue edit``.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

TITLE = "Nightly evals regressed"
LABEL = "nightly-evals"
MAX_FAILURE_LINES = 20


def _suite_lines(name: str, suite: Mapping[str, Any]) -> list[str]:
    lines = [f"### {name}", ""]
    lines += [f"- {regression}" for regression in suite.get("regressions", [])]
    failures: Sequence[str] = suite.get("failures", [])
    if failures:
        lines += ["", "First failures:", "", "```"]
        lines += list(failures[:MAX_FAILURE_LINES])
        if len(failures) > MAX_FAILURE_LINES:
            lines.append(f"... and {len(failures) - MAX_FAILURE_LINES} more")
        lines.append("```")
    return [*lines, ""]


def issue_body(
    report: Mapping[str, Any] | None, *, exit_code: int, run_url: str, llm_ran: bool
) -> str:
    lines = [
        f"The nightly eval run exited {exit_code} ({run_url}).",
        "",
    ]
    if not llm_ran:
        lines += ["ANTHROPIC_API_KEY is not set, so the LLM suites were skipped.", ""]
    if report is None:
        lines += ["The run wrote no report; the job log has the details."]
        return "\n".join(lines) + "\n"
    if report.get("stopped"):
        lines += [f"The run stopped early: {report['stopped']}.", ""]
    suites: Mapping[str, Mapping[str, Any]] = report.get("suites", {})
    lines += ["| Suite | Status | Cases | Metrics | Cost |", "|---|---|---|---|---|"]
    for name, suite in sorted(suites.items()):
        status = "regressed" if suite.get("regressions") else "ok"
        metrics = ", ".join(f"{k}={v:.4f}" for k, v in sorted(suite.get("metrics", {}).items()))
        cost = f"{suite.get('cost_cents', 0.0):.2f} cents"
        lines.append(f"| {name} | {status} | {suite.get('cases', 0)} | {metrics} | {cost} |")
    lines += ["", f"Spent {report.get('spent_cents', 0.0):.2f} cents in total.", ""]
    for name, suite in sorted(suites.items()):
        if suite.get("regressions"):
            lines += _suite_lines(name, suite)
    return "\n".join(lines).rstrip() + "\n"


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m evals.nightly", description=TITLE)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--exit-code", type=int, required=True)
    parser.add_argument("--run-url", required=True)
    parser.add_argument("--llm-ran", action="store_true")
    args = parser.parse_args(argv)
    report = json.loads(args.report.read_text()) if args.report.exists() else None
    body = issue_body(report, exit_code=args.exit_code, run_url=args.run_url, llm_ran=args.llm_ran)
    sys.stdout.write(body)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
