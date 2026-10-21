# First Paycheck

First Paycheck guides a new salaried employee through their first-month money decisions (W-4, health plan, 401(k) contribution, emergency fund and safe spending) using their own pay stub, benefits documents and linked bank accounts, then checks in every month to see whether those decisions took effect and what changed. All financial math runs in deterministic, tested code in `api/calc/`. Claude only extracts fields from redacted documents, categorizes unknown merchants and writes explanations, and every explanation is checked against the calculator's numbers and cites an IRS or plan source. Nothing the model produces reaches a calculator until the user confirms it.

**Status:** M0 (scaffold, spec amendments, CI, deployed hello world) in progress. Alpha due November 5, 2026. See the [build plan](docs/plan.md).

## Docs

| Document | What it is |
|---|---|
| [Technical spec](docs/technical-spec.md) | Architecture, data flow, data model, API, stack and metrics (amended; changes listed at the end) |
| [Proposal](docs/proposal.md) | Problem, target user and MVP features |
| [Build plan](docs/plan.md) | Decisions, milestones M0-M10, spec amendments and risks |
| [Backlog](docs/backlog.yaml) | Every issue by milestone, synced to the GitHub Project |
| [Feature specs](docs/specs/README.md) | One spec per feature, written before the code |
| [Mockup B](docs/mockup/README.md) | The design reference the web app is ported from |
| [AI tool log](docs/ai-log.md) | Where AI tools helped, failed and how it was caught |
| [Alpha release](docs/alpha/README.md) | The alpha deliverable, against the [alpha brief](docs/alpha-brief.md) |

## Quick start

You need [uv](https://docs.astral.sh/uv/) for Python and [pnpm](https://pnpm.io/) for the web app. Copy `.env.example` to `.env` and fill in the values it lists.

```sh
make setup   # install Python and web dependencies
make dev     # run the API, the job worker and the web app together
make test    # run the API and web test suites
make lint    # ruff, mypy, eslint, tsc and the no-em-dash check
make eval    # run the free eval suites (calculators, categorization rules)
```

The Makefile also defines `test-api`, `eval-llm`, `migrate`, `revision`, `seed`, `types` and `worker`.

## Layout

```
api/     FastAPI app, calculators, sync, ingest, LLM gateway, jobs, tests
web/     Next.js app, design system, screens, Playwright end-to-end tests
evals/   Eval runner, suites, fixtures and the committed baseline
docs/    Spec, proposal, plan, backlog, feature specs, mockup, AI log, alpha
```
