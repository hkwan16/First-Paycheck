# Build plan

This is the repo copy of the First Paycheck build plan, condensed. The product is defined in [`technical-spec.md`](technical-spec.md) and [`proposal.md`](proposal.md); the look and interactions are settled by Mockup B in [`mockup/`](mockup/README.md); feature-level detail lives in [`specs/`](specs/README.md). Every issue below is in [`backlog.yaml`](backlog.yaml) and on the GitHub Project.

- Backlog board: [GitHub Project "First Paycheck"](https://github.com/users/hkwan16/projects/1), 104 issues across milestones M0 to M10, synced from `backlog.yaml` by `scripts/sync_backlog.py --project 1 --owner hkwan16`.
- AI tool log: [`ai-log.md`](ai-log.md).

## Context

The alpha release is due Thursday, November 5, 2026 ([`alpha-brief.md`](alpha-brief.md)): a working demo with screenshots, a backlog in a task tracker with title, description, status, priority and assignee per task, and a reflection on AI tools. Work started on October 20 from a repo with only the proposal, the spec and the brief. After the alpha, the rest of the MVP lands in dependency order through early December.

The intended outcome is a deployed product where a user signs in, links a Plaid sandbox bank, confirms an extracted pay stub, runs calculators in tested code, saves versioned decisions, reads verified explanations, exports a plan, and gets a monthly check-in. Three rules hold throughout:

- All money math lives in `api/calc/`, with no LLM in it.
- Only `api/llm/gateway.py` calls Claude.
- Everything the LLM produces is a proposal until the user confirms it.

## Decisions

These are settled and not reopened during the build.

- Solo developer. uv for Python, pnpm for the web app. Backlog in GitHub Projects, driven by `gh`. Monorepo with `web/`, `api/`, `evals/` and `docs/`.
- Deployed from day one: Vercel (web), Render (API and worker, Docker), hosted Supabase, the Plaid sandbox and the Anthropic API. GitHub Actions runs CI and deploys `main`.
- The November 5 alpha runs end to end on the real foundation: sign in, link a Plaid sandbox institution and see synced, categorized transactions, upload and confirm a pay stub (Sonnet 5.5 extraction after redaction), the 401(k) match calculator, save the decision as a version, and one verified explanation with citations. The other calculators render as labeled placeholders.
- Mockup B is committed under `docs/mockup/` as the design reference and ported to React. Its client-side formulas are not ported; every number comes from the API.
- A failing test comes first for every feature and bug fix. Quality, simplicity, robustness, scalability and maintainability outrank build speed. Lint errors and flaky tests are fixed at the root. No em dash appears in any text, code or commit.

## Milestones

Backend and frontend land together in each milestone, in sequence. Each milestone leaves a deployed product.

| Milestone | Dates | Scope | Status |
|---|---|---|---|
| M0 | Oct 20-22 | Scaffold, spec amendments, CI, deployed hello world | In progress |
| M1 | Oct 23-26 | Data model, auth, Plaid sandbox sync, categorization, design system | Not started |
| M2 | Oct 27-30 | Upload, ingest, redact, extract, confirm | Not started |
| M3 | Oct 31-Nov 2 | 401(k) calculator, decisions, citations, explain, verify | Not started |
| M4 | Nov 3-5 | Alpha hardening and the alpha document | Not started |
| M5 | Nov 6-12 | Sankey, CSV import, spending summary, recurring detection | Not started |
| M6 | Nov 13-19 | Emergency fund, goals, health plans, benefits extraction | Not started |
| M7 | Nov 20-26 | W-4 | Not started |
| M8 | Nov 27-Dec 3 | Check-ins, calendar, cash flow, net worth, holdings | Not started |
| M9 | Dec 4-7 | Plan export | Not started |
| M10 | Dec 8-11 | Hardening: deletion paths, eval sets at target, nightly evals, accessibility, user test | Not started |

Definitions of done, per milestone:

- **M0:** `make setup && make test && make lint` pass locally; CI is green on a pull request; merging `main` deploys `/health` on Render and the sign-in page on Vercel with the correct tokens; the Project board holds every M0-M4 issue.
- **M1:** on the deployed stack, a signed-in user links First Platypus Bank through Plaid Link, the worker syncs, transactions show their category source, a category fix creates a rule, the RLS test covers every registered route, and the component gallery matches the mockup at both widths.
- **M2:** a synthetic pay stub PDF and a PNG photo both produce a reviewable proposal with per-field confidence; confirming stores the row and deletes the blob; extraction field accuracy is at least 90% on 10 fixtures; `redaction_count` is non-zero where the label says an SSN exists.
- **M3:** on the deployed stack, the user sets the 401(k) slider, sees the full-match percentage and dollars, saves, changes and saves again to see v2 supersede v1, and reads a verified explanation whose IRS citation links to a real page.
- **M4:** the alpha document is complete, the board shows every issue with status and priority, and `main` is green and deployed.

## Spec amendments

Applied to `technical-spec.md` in M0; the code is built to the amended spec. The spec's closing section lists them in one line each.

| # | Change | Why |
|---|---|---|
| 1 | `POST /docs/{id}/extract` returns `{job_id}`; extraction runs in the worker; the result is read through `GET /docs/{id}` | OCR plus Sonnet vision takes 15-60 s, and keeps heavy dependencies out of the API process |
| 2 | Every money column is `bigint` named `*_cents`; Pydantic `Cents = Annotated[int, Field(strict=True)]` | Makes the integer-cents rule visible everywhere |
| 3 | Raw uploads live in `document_blobs` under RLS instead of Supabase Storage; only `ingest/store.py` touches it | One auth path and one `DELETE` on confirm; Storage can replace it later behind the same module |
| 4 | New `llm_calls` ledger; the gateway refuses calls past a per-user daily budget | Cost control, and the fallback-rate metric needs per-call data |
| 5 | `decisions` constraints: unique version per calculator, partial unique `supersedes_id`, version-1 check, immutability trigger, ownership-checking insert policy | Guarantees a linear, immutable version chain |
| 6 | `category_rules` match `merchant_norm` exactly then by prefix; precedence user exact > user prefix > seed exact > seed prefix > LLM; seed rows have `user_id NULL` | No regular expressions from user input; predictable precedence |
| 7 | `amount_cents > 0` is money out; the CSV provider normalizes | The spec did not say |
| 8 | Manual sync route, and a non-production sandbox item route | Webhooks never reach a laptop, and Playwright cannot drive the Plaid iframe reliably |
| 9 | Cross-user SQL only in the job dequeue and one `SECURITY DEFINER` webhook function | Everything else stays under RLS |
| 10 | Committed `api/openapi.json`, `openapi-typescript` types, CI drift check, stable operation ids | The type-sharing mechanism was unstated |
| 11 | Render connects through the Supavisor pooler; psycopg `prepare_threshold=None` | Supabase's direct host is IPv6 only and Render has no IPv6 egress |
| 12 | LLM confidence is a "needs review" UI threshold only; evals measure accuracy | Self-reported confidence is weak evidence |
| 13 | `tax_year` from `pay_date`, passed explicitly; yearly constants in `api/calc/data/<year>.json` | October-December 2026 and January 2027 straddle tax years |
| 14 | Read routes the screens need, and finding undo with `user_action: null` | The mockup screens need these reads |
| 15 | `profiles.match_tiers` and `profiles.vesting_years` | No field held the match formula |
| 16 | Richer `/calc/401k-match`, `/spending/summary` and `/cashflow` outputs | The Decisions card and the Sankey must not sum anything client-side |
| 17 | The confirm arithmetic gate runs in the client and as a server 422 | The server stays the authority |

## Architecture in brief

Full detail goes into `api/CLAUDE.md`, `web/CLAUDE.md` and `docs/specs/`.

- **API:** FastAPI with one RLS-scoped transaction per request; pure calculators in `calc/` that import nothing but the standard library, `decimal`, `pydantic` and each other; one sync pipeline for Plaid and CSV; ingest with OCR and redaction; the LLM gateway with structured outputs, refusal handling, the cost ledger and a fake mode for tests; a verifier for explanations; a Postgres job queue with a separate worker.
- **Web:** Next.js App Router, React 19, Tailwind v4 tokens from the mockup, TanStack Query over generated types, Supabase auth, Plaid Link. Color meanings are enforced by types and lint rules; every number comes from the API.
- **Testing and evals:** unit, integration and RLS layers with no live network by default; Hypothesis for calculator properties; eval suites with committed baselines; Playwright end to end with visual and axe checks at 1280 and 390 px.

## Risks

| Risk | Mitigation |
|---|---|
| Plaid sandbox quirks (`PRODUCT_NOT_READY`, random data, pagination mutation, public webhooks only) | `RetryLater` backoff; a custom sandbox user for deterministic evals; cursor saved only after the last page; manual sync route; recorded fixtures for unit tests |
| OCR differs between macOS and Debian | The Dockerfile pins the Debian package; CI runs ingest tests in the image; evals compare confirmed fields, not raw text |
| WeasyPrint native dependencies | Docker runtime with pango; `export/` imports lazily and runs in the worker |
| Claude output drift | Structured outputs with Pydantic; the verifier rejects invented numbers; versioned prompts with eval baselines; model ids pinned in env |
| LLM cost | Rules before the LLM; per-user daily budget; batches of 50; the Batches API for large histories; prompt caching; rate limits; the fake gateway everywhere else; expected alpha spend under $5 |
| Solo timeline to November 5 | Four milestones, each leaving a deployed product; M2 and M3 are independent after M1, so M3 can move first if OCR stalls; explanations fall back by design, so a broken one never blocks the demo |
| An RLS mistake | FORCE RLS, an API role that cannot bypass it, a route-wide cross-user test with a coverage meta-test, cross-user SQL in two audited places |
| Worker crash mid-job | Heartbeat, stale-job requeue, idempotent handlers keyed by upsert |
| Flaky tests | No live network by default, savepoint rollback, derandomized Hypothesis, seeded fixture generators |
