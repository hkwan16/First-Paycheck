# AI tool log

One entry per notable use of an AI tool: what it was asked, what it produced, what was wrong, and how that was caught. The alpha and final reflections are written from this log, so entries record failures as carefully as successes.

## Entry format

Every entry has a dated heading and these fields, in this order. A field that does not apply says "None" rather than disappearing.

| Field | What goes in it |
|---|---|
| **Task** | What we were trying to get done |
| **Tool** | Tool and model, and whether subagents were used |
| **Prompt or skill** | The prompt in brief, or the skill invoked |
| **What it produced** | The artifacts, with paths or links |
| **What was wrong** | Every defect found, including small ones |
| **How it was caught** | Test, review, render, user report, eval |
| **Fix** | What changed, and by whom |
| **Time saved or lost** | An honest estimate, or "not measured" |

## 2026-10-20 to 2026-10-21: planning session, spec amendments, mockups and M0 kickoff

**Task:** Turn the proposal and the finalized technical spec into a buildable plan for the November 5 alpha, settle the frontend design, and start M0.

**Tool:** Claude Code. The main session delegated to subagents: one subagent for a second mockup, two Plan subagents for the build plan, and parallel Opus subagents for the M0 implementation, one per work package (this documentation package among them), each in its own git worktree.

**Prompt or skill:** Asked for a build plan grounded in `technical-spec.md` and `proposal.md`, then for two clickable mockups of the setup flow and monthly check-in. One mockup was built by the main session; the other by a subagent using the `apple-design` skill. Implementation was split into work packages handed to parallel subagents with explicit file ownership.

**What it produced:**
- Seventeen spec amendments, now applied in [`technical-spec.md`](technical-spec.md) and listed in its closing section.
- Two mockups. Mockup B was chosen and is committed in [`mockup/`](mockup/README.md); the live artifact is <https://claude.ai/artifact/K4UZ8HBNWQ8Ku1F783pm5v>.
- The build plan (milestones M0-M10, issues, tests first, definitions of done), condensed in [`plan.md`](plan.md), with every issue in [`backlog.yaml`](backlog.yaml).
- The M0 documents: [`specs/001-data-model.md`](specs/001-data-model.md) and [`specs/006-401k-match.md`](specs/006-401k-match.md).

**What was wrong:**
- Mockup B's Spending Sankey clipped its right-hand column, so the last nodes and their labels were cut off.
- The plan's property "missed match is zero if and only if the contribution is at or above the full-match percentage" is false when the 402(g) limit binds below that percentage. Spec 006 states the corrected property.

**How it was caught:**
- The Sankey clipping was caught by a user bug report on the mockup. A headless Chrome render of the artboard confirmed the fix.
- The property error was caught while hand-working spec 006's examples, at the $500,000 salary case.

**Fix:**
- Claude Code fixed the Sankey layout in `Spending.dc.html`; a headless Chrome render confirmed the right column was no longer clipped before the mockup was committed.
- Spec 006 rewrites the property and adds an example (9) for the case, marked pending until the 401(a)(17) question is settled.

**Time saved or lost:** Not measured. The Sankey bug cost one round of rework; it would have been ported into React if a person had not looked at the render.

## 2026-10-21: Supabase default grants left the migration pointer and a SECURITY DEFINER function open to the publishable key

**Task:** Answer "should I set up RLS on Supabase?" by checking the hosted project instead of answering from the migrations.

**Tool:** Claude Code, main session, no subagents.

**Prompt or skill:** The question above. The session queried `pg_class`, `pg_policy`, `role_table_grants` and `pg_default_acl` over the privileged pooler connection, then probed the Data API with the publishable key and with a signed-in test user's JWT.

**What it produced:**
- Confirmation that every application table has RLS enabled and forced with its owner policy, and that `app_api` cannot bypass it.
- Migration `0007_lock_alembic_version`, a test-shim change that copies Supabase's default privileges, and a migration test that fails on any `public` object still granted to `anon`.

**What was wrong:**
- `alembic_version` is created by Alembic before the first migration and never passed through `enable_rls`, so Supabase's default grants left it readable and writable by `anon` through PostgREST: `GET /rest/v1/alembic_version` with the publishable key returned the revision, and the grants included DELETE.
- `enqueue_sync_for_plaid_item(text)` (SECURITY DEFINER, intended for `app_api` only) was executable by `anon` and `authenticated`: 0006's `REVOKE ALL FROM PUBLIC` does not remove an explicit default-privilege grant to those roles. The local test suite passed because a plain Postgres has no such defaults.
- With a signed-in user's JWT, PostgREST served `profiles`, `transactions` and `jobs` directly. RLS scoped the rows correctly, but the API's validation (the Confirm arithmetic gate, job kinds) could be bypassed for the user's own rows.

**How it was caught:**
- By checking the hosted database and the Data API end to end rather than reading the migrations. The earlier M1 RLS work was reviewed only against a local Postgres, which never had the defaults.

**Fix:**
- The test auth shim now runs the same `ALTER DEFAULT PRIVILEGES` statements Supabase does, which reproduced the leak locally (7 tables and 3 functions granted to `anon`) before the migration was written. `0007_lock_alembic_version` revokes the defaults from `alembic_version` and the three functions and grants back only what 0001, 0002 and 0006 intended. Applied to the hosted project; the anon probes now return 401 and `/health` still reports the revision.
- The PostgREST exposure for signed-in users is closed by removing `public` from the Data API's exposed schemas in the Supabase project settings, recorded in `docs/plan.md`.

**Time saved or lost:** About an hour to find and close. Reading the schema from the hosted project turned a yes/no question into two real fixes.

## 2026-10-21: M4 API hardening (explain rate limit, JSON logs, Sentry, worker health)

**Task:** The API half of M4: rate limit `POST /explain` at 30 per hour, structured JSON logs with request and job ids, env-gated Sentry for the API and the worker, and a `worker` field on `GET /health`.

**Tool:** Claude Code, an Opus 5.5 subagent in its own worktree, orchestrated from the main session.

**Prompt or skill:** The four deliverables with a failing test first for each and one commit per item.

**What it produced:**
- `ratelimit.EXPLAIN_RUNS` in `POST /explain` (spec 008 rule 22 amended).
- `app/logs.py` (formatters, `log_context`, one dictConfig), `app/request_log.py` (one `app.request` line per request, `X-Request-Id`), worker run lines; `python -m app.serve api` runs uvicorn in-process with that config.
- `app/sentry.py`, wired into `create_app` and `jobs.worker.main`; `SENTRY_DSN` in `.env.example` and `render.yaml`.
- `jobs/scheduler.py:worker_status` and `worker: ok | stale` on `/health` (spec 002 rule 38).

**What was wrong:**
- The first context design read the request id from a `ContextVar` at format time, so a handler that formats later (pytest's `caplog`) lost it. Records are now stamped by a LogRecord factory when they are created.
- Sentry's defaults send frame locals, which `before_send` cannot see into. `include_local_variables=False` was set from the start; a mutation run of the real-SDK test (in a subprocess, with an in-memory transport) confirmed it matters: with locals on, the request body reached Sentry through the route's `body` local even though the body itself was scrubbed.
- While checking the existing setup, the Dockerfile CMD turned out to name a worker service that no longer exists; it now runs `python -m app.serve` like `render.yaml`.

**How it was caught:** Tests written before the code; mutation runs of the Sentry test (locals on, bodies kept) both failed; a manual `python -m app.serve api` run showed every line as JSON.

**Fix:** As above, in the subagent's branch.

**Time saved or lost:** Not measured.

## 2026-10-21: M6 backend (emergency fund, health plans, benefits extraction)

**Task:** The API half of M6: specs 011-013, the emergency fund and health plan calculators and routes, their decisions, goals and calendar events, `GET/PATCH /goals`, `profiles.birth_year`, explain for health plans, and benefits extraction of the 401(k) match and vesting with a `benefits-extraction` eval suite.

**Tool:** Claude Code, an Opus 5.5 subagent in its own worktree, orchestrated from the main session.

**Prompt or skill:** The five deliverables, spec first, failing tests first, one commit per step.

**What it produced:** `calc/emergency_fund.py`, `calc/health_plans.py` (HSA and HDHP constants verified against Rev. Proc. 2025-19), `app/decision_effects.py`, `app/routers/goals.py`, `app/routers/benefits.py`, migration `0008_goals_and_birth_year`, `extract_benefits/v2`, `evals/gen/make_benefits.py` and `evals/suites/benefits_extraction.py`.

**What was wrong:**
- Health-plan explanations went to the fallback under the fake model: facts carried plan names and usage words, which the verifier counted as unmatched numbers. Facts are now numbers only and the words moved to notes.
- A negative expected cost (an HSA deposit larger than the plan's cost) failed verification because allowed money was stored signed; money now matches by magnitude.
- A goal upsert queried the linked account after `session.add`, and autoflush inserted a half-built row (NotNullViolation). The account is resolved first.
- Ordering confirmed plans by `created_at` tied for two summaries confirmed in one transaction, since `now()` is the transaction's start; plans now carry `position` and order by the document's `confirmed_at`.

**How it was caught:** Integration tests written before the code.

**Fix:** As above, in the subagent's branch.

**Time saved or lost:** Not measured.
