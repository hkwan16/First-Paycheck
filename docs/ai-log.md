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

## 2026-10-21: M4 end-to-end harness, alpha.spec.ts, and what running the specs against a real API found

**Task:** The test and deliverable half of M4: a local real-API Playwright harness, `e2e/alpha.spec.ts` for the whole alpha path, a CI job that runs it, visual and axe coverage for every alpha screen, and this alpha document.

**Tool:** Claude Code, an Opus 5.5 subagent in its own worktree, orchestrated from the main session, in parallel with another subagent building the Sankey and CSV import screens.

**Prompt or skill:** The five deliverables, a failing test first where there is code, one commit per item, and no edits under `api/app/`.

**What it produced:**
- `scripts/e2e_stack.py` and `make e2e-full`: a disposable Postgres database, a stand-in for Supabase Auth that signs ES256 tokens and serves its JWKS (so the web signs in through its real form and the API verifies the same tokens), and the API and worker with `LLM_FAKE=true` and the Plaid sandbox when keys are present.
- `web/e2e/alpha.spec.ts`, the `e2e` workflow (`.github/workflows/e2e.yml`), the Why index in the visual and axe spec, and this document.

**What was wrong:**
- After a confirm, the screen stayed on "This pay stub is confirmed" instead of moving to Spending. The navigation lived in a `mutate` call's `onSuccess`; the side nav keeps `/docs` and `/pay-stubs` active, the document's own refetch landed first, the review unmounted, and TanStack drops a `mutate` call's callbacks once its component unmounts.
- The Link screen hydrated with accounts its server HTML did not have: the layout hydrates before the page, and the side nav's reads came back from a fast local API before the page hydrated. React rebuilt the tree and the dev overlay covered the page.
- `Notice` put a space before its body when it had no title, so " Linked First Platypus Bank." never matched the specs' `/^Linked .+\./`.
- `/setup/confirm/[documentId]` and `/why/[decisionId]` read `params` outside Suspense, which `next dev` logs as an error under Cache Components.
- `confirm.spec.ts` found a field's input by a label that the row's Save and Cancel buttons also contain, so it failed in strict mode.
- The link helper waited 120 s for a first sync, exactly the API's retry interval when Plaid's sandbox is not ready, so it failed whenever Plaid needed that retry.
- Not fixed here (it is in `api/`): without `ANTHROPIC_API_KEY` the worker fails the categorize and extract jobs outright, so production has no rule-based categories and no manual-entry fallback until a key is set.

**How it was caught:** Running the existing real-API specs and the new alpha spec through the harness, then reading the API's JSON log and Playwright's page snapshot for each failure. Each web bug got a failing unit test that reproduces it (for the confirm race, a test that holds `/pay-stubs` while an active reader waits on it) before the fix.

**Fix:** In the subagent's branch: `useConfirmDocument({ onConfirmed })` navigates from the mutation's own success handler; `HydrationMarker` marks the page hydrated and `AppSideNav` waits for it; `Notice` adds the space only after a title; both dynamic pages await `params` inside Suspense; the spec matches the exact label; the link helper's budget covers two of the API's retries. The missing-key behavior is reported for the API owner.

**Time saved or lost:** Not measured. The harness took most of the session; it turned the real-API specs, which needed a hosted stack and its credentials, into a check that runs on every pull request.

## 2026-10-21: M7 W-4 calculator on the 2026 Pub 15-T percentage method

**Task:** The backend of M7: spec 014, `calc/w4.py` and `POST /calc/w4`, the `w4_submit` calendar event (migration `0009_w4_calendar_kind`), W-4 citations and explain support, and the spec's examples as eval cases.

**Tool:** Claude Code, an Opus 5.5 subagent in its own worktree, orchestrated from the main session, in parallel with another subagent building check-ins.

**Prompt or skill:** Spec first, then failing tests, then code; every IRS figure fetched and verified, anything unverifiable marked pending with an `xfail` test.

**What it produced:** `calc/data/pub15t_2026.json` (Worksheet 1A line 1g and the annual STANDARD and Step 2 checkbox tables, read from both the PDF and the web edition of Pub 15-T), ten hand-worked examples, the calculator with a whole-dollar Step 4(c) or 4(b) suggestion, `db/seed/irs_citations/w4.yaml` with every passage checked against the fetched pages, W-4 facts, notes and fallback text, and five explain-smoke scenarios.

**What was wrong:**
- Pub 15-T (2026) has no worked percentage-method example; its only example is a nonresident alien on the wage bracket tables. The spec's first example instead works Worksheet 1A for a wage at the midpoint of a biweekly wage bracket row and checks it against the printed $156.
- The first draft of the spec claimed every Step 4(c) suggestion lands within $100. Hypothesis found the counterexample: lowering Step 4(c) to zero can leave a refund that only another job's withholding causes. The property and the test were corrected; the rule already described the behavior.
- The edge case for the 401(k) catch-up first said a 15% rate at age 52 was no longer capped; 15% of $250,000 is still over $32,500. The cross-check script caught it and the case moved to 13%, exactly at the limit.
- W-4 notes say "Step 2", which the verifier read as the number 2. Spec 008 rule 11 now skips Form W-4 step numbers the way it skips "Form 1040".

**How it was caught:** A throwaway `Decimal` script recomputed every example independently of the implementation; a test rebuilds every Pub 15-T row from the Rev. Proc. 2025-32 brackets and standard deduction; Hypothesis properties over the suggestion.

**Fix:** As above, in the subagent's branch.

**Time saved or lost:** Not measured.

## 2026-10-21: M9 plan, calendar file and PDF export

**Task:** The backend of M9: spec 016, `GET /plan`, `GET /plan/calendar.ics`, `POST /plan/export` with the `plan.export` job rendering a PDF with WeasyPrint, `GET /plan/export/{job_id}`, migration `0013_plan_export_job` and 7-day retention.

**Tool:** Claude Code, an Opus 5.5 subagent in its own worktree, in parallel with another subagent building check-ins.

**Prompt or skill:** Spec first, then failing tests, then code; every number in the plan is a field a calculator produced; WeasyPrint only in the worker.

**What it produced:** `app/plan.py` (one read shared by the route and the job, figures copied by path), `export/calendar.py` (RFC 5545 with the standard library, checked against a hand-written `.ics` fixture), the Jinja template and its byte-for-byte HTML fixture, the job, the table under RLS and its retention, and CI and Docker changes so the PDF tests run against real pango.

**What was wrong:**
- The first downgrade of `0013` failed: rebuilding `job_kind` cannot carry the `jobs` CHECK that compares `kind` with a literal, so the migration now drops and recreates that constraint around the type change.
- The spec's first draft listed the 2026-10-31 events in the wrong order; the rule says `kind` order, which puts the election check first.
- The test seed wrote a fallback explanation with `retries = 2`, which the table's check refuses.
- In the Docker image, fontconfig printed "No writable cache directories" on every WeasyPrint import, because the `app` user's home is read-only; `XDG_CACHE_HOME=/tmp/app-cache`, set after the build steps (an earlier attempt in the base stage let uv create the directory as root during the build, so the error stayed), fixes it.
- On macOS, Homebrew's pango is not on the loader's path; the PDF tests skip there unless pytest runs with `DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib`, which `make` drops.

**How it was caught:** `test_migrations` (upgrade, downgrade, upgrade), writing the calendar test from the rule, the seed's own insert, running the image, and rendering the PDF to PNG to look at it.

**Fix:** As above, in the subagent's branch.

**Time saved or lost:** Not measured.

## 2026-10-21: M10 backend hardening: account deletion, unlink, eval sets, nightly evals, limits

**Task:** The backend items of M10: `DELETE /me`, a complete unlink path, the 30-stub extraction set and the categorization LLM suite over the 500 transactions, a nightly eval workflow, the eval tolerance check, and a rate-limit and body-size audit of every write route.

**Tool:** Claude Code, an Opus 5.5 subagent in its own worktree, orchestrated from the main session.

**Prompt or skill:** Spec first (new spec 017; amendments to specs 001, 002, 003, 005 and 015), failing tests first, one commit per item, baselines in their own commit.

**What it produced:** Migration `0014_delete_account_fn` and `DELETE /me` (Plaid revoked with no transaction open, then one `SECURITY DEFINER` delete that cascades every user table); a deletion test that lists the user tables from `information_schema` and fails on one its fixture leaves empty; an unlink path that retracts check-in findings about charges the unlink removed; 20 more pay stubs in a third layout; the `categorization` suite; `.github/workflows/nightly.yml` with `evals/nightly.py`; `WRITE_ROUTE_POLICIES` and a body limit on every request.

**What was wrong:**
- Reproducing unlink end to end on the November user showed a stale finding: after the worker re-ran detection and refreshed the check-in, the Equinox `recurring_new` finding still pointed at a deleted charge, because spec 015 only retracted conditions. Events whose subject is gone are now retracted unless the user acted on them.
- Unlinking a CSV account returned 503 when Plaid was not configured, and the Plaid call ran inside the request's transaction.
- A sync queued for an unlinked item failed and retried on a worker with no provider, although spec 002 rule 17 says it succeeds as `item_missing`.
- A write with a deleted account's still-valid token was a 500 (a foreign key violation); it is now 401 `account_deleted`.
- Only uploads had a body limit: a JSON body of any size reached FastAPI's parser, and a chunked upload with no `Content-Length` skipped the check.
- The first route listing for the policy test read `app.routes`, which hides included routers, so it found no routes; `iter_route_contexts` flattens them, as the cross-user test already did.

**How it was caught:** The end-to-end unlink test written before the fix, the completeness check over `information_schema`, and failing unit tests for streamed bodies and route policies.

**Fix:** As above, in the subagent's branch.

**Time saved or lost:** Not measured.

## 2026-10-21: M3 to M10 built by parallel Opus subagents, merged by the main session

**Task:** Implement every milestone after M2 (calculators, decisions, explain and verify, the Sankey and CSV import, recurring charges, emergency fund and health plans, benefits extraction, the W-4, monthly check-ins, net worth, the plan and its exports, hardening) by delegating each package to an Opus 5.5 subagent at high effort in its own git worktree, and merge the results into main from the main session.

**Tool:** Claude Code. Sixteen subagents over the day, two to four running at a time, each with a brief that named the specs to read, the files it owned, the files another agent owned, its own test database name and a `&&`-gated command to pass before reporting.

**Prompt or skill:** One brief per package, written from the build plan's milestone section. Every brief repeated the repository rules (spec first, failing test first, integer cents only in `calc/`, RLS everywhere, no em dashes) and asked for deviations to be reported with reasons.

**What it produced:** Specs 006 to 017, migrations 0004 to 0014, every route in the technical spec's API, the web screens for Decisions, Why, Plan, Check-in and the Sankey, a local real-API end-to-end harness, four new workflows (e2e, nightly), and the alpha document. Test counts went from 733 to 1922 on the API and 605 to 1332 on the web, with every merge gated on lint, the full suites and the free evals.

**What was wrong:**
- Supabase's default grants left `alembic_version` and three functions reachable with the publishable key (its own entry above). The guard test written for it then caught the same gap in the next migration an agent wrote.
- Two agents' migrations revised the same parent; three re-chains were needed at merge time (0004 onto 0007, 0012 onto 0009, 0013 told to revise 0012). Telling later agents the current head in their brief removed the problem.
- Migration 0001 rewrote the cluster-wide role on every run, so two worktrees' test suites collided with "tuple concurrently updated". Fixed in 0001 with a test that the role rows do not change once set up.
- The worker failed categorize and extract jobs outright without an Anthropic key, which production did not have; found by the alpha e2e work, fixed with rules-only categorization and manual entry.
- Each web merge after the first had conflicts in the shared files (the web guide, the MSW index, the sample screens, the API types), resolved by hand; two were resolved wrongly at first (a duplicate type alias, a missed `page-hydration.ts` line) and caught by `tsc` in the gate.
- Agents reported API gaps instead of patching across the boundary; three were real (no `provider` on accounts, no plan-line status, no way to run a check-in now) and became their own packages.

**How it was caught:** The merge gate (lint, both test suites, the free evals, `pnpm check:api`) after every merge, the migration guard test, and the agents' own real-API runs through the e2e harness.

**Fix:** As listed, each in its own commit on main.

**Time saved or lost:** Not measured. The whole post-alpha plan (M3 to M10, scheduled for November 6 to December 11) landed in one day; the cost was the orchestration itself, roughly a third of the main session's time on merges and conflict resolution.

## 2026-10-21: backlog statuses synced to the board

**Task:** Bring the GitHub Project up to date for the alpha's backlog requirement: a status on every issue, closed issues for finished work, and issues for work no issue described.

**Tool:** Claude Code, an Opus 5.5 subagent in its own worktree, orchestrated from the main session.

**Prompt or skill:** Add `status` to `backlog.yaml` and to `scripts/sync_backlog.py` (failing tests first), mark each issue truthfully from `main` after reading the code and guides, add issues for unlisted work, run the sync and verify the counts.

**What it produced:** `status` (todo, in_progress, done) in the backlog and the sync, which sets the Project's Status field, closes done issues and reopens the rest, and retries rate-limited `gh` calls; 124 issues (108 done, 9 in progress, 7 todo), 20 of them new: specs 009 to 017, the Supabase grant lockdown, the e2e stack, the no-model fallback, two M5 web pieces, plan line status, write-route limits and eval tolerance as done, and the web check-in-now button, web account deletion and the live LLM eval run as todo.

**What was wrong:**
- Every milestone in `backlog.yaml` used a `due` key that the parser never read, so no milestone on GitHub had a due date. The parser now rejects unknown keys, the file uses `due_on`, and the sync updates a milestone whose due date differs.
- Several issues looked done from their titles but were not by their own definitions of done: the CI e2e run skips the Plaid link steps because Actions has no Plaid secrets, the LLM eval baselines hold targets because no key has been available, the ingest-in-docker job is not required because `main` has no branch protection, and the web app has no production deployment.
- `web/CLAUDE.md` still says the API has no `POST /check-ins` and no plan line status; both landed in the API today. Recorded as a todo issue rather than edited here.

**How it was caught:** Reading `render.yaml`, the workflows, `evals/baseline.json`, the repo's secrets list, branch protection and the live `/health`, rather than the milestone summaries; the milestone dates showed up as a dry run reporting every milestone stale.

**Fix:** As above, in the subagent's branch. The sync created 20 issues, set 120 statuses, closed 108 issues and updated 11 milestones; a second dry run reported no changes.

**Time saved or lost:** Not measured.
