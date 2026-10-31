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

## 2026-10-21: web plan line status, Check in now, and the alpha document refresh

**Task:** The last M8 web item (colour the check-in's plan lines from the API's new `status`, and a "Check in now" button over `POST /check-ins`), an end-to-end check-in spec that no longer skips when the user has no check-in, and a refresh of `docs/alpha/README.md` to what `main` does.

**Tool:** Claude Code, an Opus 5.5 subagent in its own worktree, orchestrated from the main session.

**Prompt or skill:** Three deliverables, a failing test first for each, one commit per step, no edits under `api/`, `evals/` or `docs/specs/`, and the gate `pnpm lint && pnpm format:check && pnpm typecheck && pnpm test && pnpm build && pnpm e2e` plus the `authenticated-check-in` project through the local stack.

**What it produced:** `planStatusTone` and `planStatusText` (`web/src/components/screens/check-in/checkin-format.ts`), `useCheckInNow` and `checkInRunOf` (`web/src/lib/api/hooks/checkins.ts`), `CheckInNow.tsx`, the `POST /check-ins` MSW handler, a limits row, a rewritten `web/e2e/check-in.spec.ts` that runs after Decisions, new baselines, and the refreshed alpha document.

**What was wrong:**
- The brief's "over or under as warning for spending lines and the reverse for savings" first read as both sides warning on spending lines. The mockup's Flexible line, under its plan with an "ok" badge, settled it: on spending lines only over needs a look, on savings and retirement only under. Health premiums stay a warning either side, since a premium off the chosen plan means the election did not take.
- A fresh e2e user has no findings, so the old spec skipped its done and undo test. The month's findings need dates due within 30 days, which only saved decisions create; the project now depends on `authenticated-decisions`.
- Updating the visual baselines failed a different smoke test on each run: `/dev/screens/confirm/extracting` logged `ERR_CONNECTION_REFUSED`. `useDocument` re-reads an extracting document every 1.5 s, and the sample screen's QueryClient let that poll reach an API the sample does not have whenever the axe pass outlasted one poll.

**How it was caught:** Comparing the brief with `docs/mockup/CheckIn.dc.html`; reading spec 015 rule 7 and `app/decision_effects.py` for what makes a finding; the smoke spec's console check, then a unit test that advances three poll intervals on the extracting sample and counts requests.

**Fix:** In the subagent's branch: the tone table as above; the dependency in `playwright.config.ts`; the sample QueryClient defaults to `enabled: false`, so only hooks that turn reads on themselves can fetch.

**Time saved or lost:** Not measured.

## 2026-10-21: web follows the unlink's recurring detection; a CSV account is removed

**Task:** The web side of three API changes on `main`: `DELETE /sync/items/{id}` returning `{recurring_job_id}`, `AccountOut.provider`, and the 422 `not_plaid_item` for a manual sync of a CSV item.

**Tool:** Claude Code, an Opus 5.5 subagent in its own worktree, orchestrated from the main session.

**Prompt or skill:** Follow the job with `useJob` from `useUnlinkItem` and the accounts card, check what `recurring.detect` invalidates, drop Sync now for a CSV institution and say Remove instead of Unlink, failing tests first, no edits under `api/`, and the gate `pnpm lint && pnpm format:check && pnpm typecheck && pnpm test && pnpm build && pnpm e2e`.

**What it produced:** `unlink.recurringJob` in `web/src/lib/api/hooks/sync.ts`; `recurring.detect` in `JOB_INVALIDATES` now also reads check-ins, and `invalidateAfterUnlink` stops reading recurring charges at once (they change only when the job runs); `removalWords` and `provider` on each institution group (`web/src/components/screens/link/account-format.ts`); `recurringJobId(n)`, `recurringJobStates` and the CSV refusal in the MSW handlers; `sampleCsvAccount`; and an import e2e check that an imported account offers Remove and no Sync now.

**What was wrong:**
- `unlinkAll` in `web/e2e/support/api.ts`, which gives `link.spec.ts` a clean slate "CSV accounts included", matched only `Unlink` buttons, so after the rename it would have left an earlier run's imported account behind.
- Spec 017 rule 11 says the open check-in is settled when the returned job finishes, but `recurring.detect` only queues a `checkin.monthly` refresh, whose id the client never sees. Reading check-ins when detection ends can still show a finding the refresh is about to retract. Recorded in `web/CLAUDE.md`; the API was out of scope.
- The `TODO(GET /spending/summary, M5)` in `web/src/lib/categories.ts` is not a small change: the summary's `category_buckets` would have to reach the transaction table and its category select, which today render without a summary, and the API has a `transfer` bucket the client folds into "Not spending". Left as it was.
- Through the local real-API stack, `spending.spec.ts` (no "Scale" badge: no pay stub is confirmed when the Spending project runs) and the emergency fund test in `decisions.spec.ts` (September's sandbox essentials are $6.33, so the card reads "already cover the $19 target" and never "Target $") fail on `main`'s commit too. Not fixed here.

**How it was caught:** Searching the e2e specs for the words being changed; reading `api/jobs/handlers/recurring.py` and `checkin/engine.py:queue_refresh` before deciding what the job's finish should refresh.

**Fix:** In the subagent's branch: `unlinkAll` matches Unlink or Remove inside the accounts card; the rest as above.

**Time saved or lost:** Not measured.

## 2026-10-21: two real-API e2e failures CI cannot see

**Task:** `spending.spec.ts` ("the cash flow and the summary tiles show the same totals") and the emergency fund test in `decisions.spec.ts` failed through the local real-API stack with Plaid sandbox keys. CI has no Plaid secrets, so it leaves the Spending project out and runs Decisions on a user without sandbox transactions.

**Tool:** Claude Code, an Opus 5.5 subagent in its own worktree, orchestrated from the main session.

**Prompt or skill:** Reproduce each through `scripts/e2e_stack.py`, verify the reported diagnosis, fix the root cause (test, web or API), prefer making a test true for the state its project produces over adding a project dependency, and the gate `pnpm lint && pnpm format:check && pnpm typecheck && pnpm test` plus both projects against the stack.

**What it produced:** A conditional scale-badge check and a `<main>`-scoped alert check in `web/e2e/spending.spec.ts`, a screen test for spending with no pay stub and no income, typed emergency fund figures with a hand-worked headline and goal check in `web/e2e/decisions.spec.ts`, and the e2e notes in `web/CLAUDE.md`.

**What was wrong:**
- The reported cause for Spending held, with a second half: no stub is confirmed in September (the Acme stub is paid in October, and the project depends on Link only), and the sandbox bank deposits nothing that month either. `flowScale` has no reference, so the diagram draws every amount without bands or a badge. The screen is right; the test assumed a scale.
- Fixing that exposed a failure it had hidden (serial mode skips the rest of the file): the period test asserted no `role="alert"` on the page, and Next's route announcer is an empty `role="alert"` it appends to `<body>` on every page, so that assertion could never pass.
- Decisions failed only when Link ran in the same stack, which `--project=authenticated-decisions` alone does not do: with the sandbox bank linked, essentials start at September's $6.33, the target is $19, and the card says "already cover the $19 target".

**How it was caught:** Running each project through the stack, then `--project=authenticated-link --project=authenticated-spending --project=authenticated-decisions --workers=1`, and reading the page snapshot in each failure's `error-context.md` (the stray alert sat beside the app's root, outside `<main>`).

**Fix:** In the subagent's branch: the badge is expected only when gross pay or income is drawn; alerts are looked for inside `<main>`; the emergency fund test types $1,800 of essentials, $2,000 saved and 3 months, expects "Target $5,400, reached in 12 months" (or 14 at $250), and checks the saved goal's transfer and target. No API or web code changed.

**Time saved or lost:** Not measured.

## 2026-10-21: a rejected model key retried for half an hour

**Task:** On production the Render `ANTHROPIC_API_KEY` is rejected (the account has no funding yet), so every model call failed with `LLMError: Anthropic API returned HTTP 401 (AuthenticationError)`. An uploaded pay stub sat in `extracting` ("Reading pay stub, Waiting to start") while `ingest.extract` retried with backoff, attempts at 60 s, 120 s, 240 s and on.

**Tool:** Claude Code, an Opus 5.5 subagent in its own worktree, orchestrated from the main session.

**Prompt or skill:** Reproduce it end to end with the worker and a gateway whose API answers 401, then make an authentication, permission or unknown-model error end both the extract and the categorize job on the first attempt as "no model", keep transient errors retrying and keep every ledger row; spec first, and the gate `make lint` and `make test-api`.

**What it produced:** `LLMMisconfigured` in `api/llm/gateway.py` (401, 403 and 404, logged at ERROR with the status only); the extract handler maps it to `manual_entry_required` with the existing `no_model` reason and `categorize_user` to `stopped: "no_model"`; `tests/support/anthropic_api.py`, the real `LLMGateway` over `httpx2.MockTransport`; specs 003 (rules 12a and 24), 004 (rule 22) and 005 (rules 12 and 13) and `api/CLAUDE.md`.

**What was wrong:**
- The gateway sorted HTTP errors into `LLMUnavailable` (429 and 5xx) and a plain `LLMError` for every other 4xx, and the extract handler retried every `LLMError` that was not a refusal or a spent budget. Configuration errors fell in the retry bucket, so the user waited out five attempts for the manual entry screen the no-key path gives at once.
- The categorize job had the same gap: a 401 failed the job and the queue retried it, where a missing key succeeds with `stopped: "no_model"`.
- `jobs/services.py` still said categorize and extract jobs "fail" without a key, which spec 003 rule 12a and spec 004 rule 22 had changed; the docstring and the startup warning now say what happens.

**How it was caught:** Production's jobs row (`queued`, attempt 3, `last_error` the 401). The reproduction ran the worker over the real gateway with a transport answering 401: the job went back to `queued` with `attempts` 1 and the document stayed `extracting`.

**Fix:** In the subagent's branch: the new exception and the two handlers, with tests that run the worker on 401, 403 and 404 (job succeeded on attempt 1, document `no_model`, one request, one `api_error` row) and on 429, 500 and 529 (still `queued` for a retry). A new `status_reason` was not added: from the user's side a rejected key is the same as no key, and `web/src/lib/documents.ts` already says "Automatic reading is off right now". The ERROR log, which Sentry's logging integration turns into an event, is the operator's signal. `GET /health` was left alone: a "key is set" field would have read fine during this very incident.

**Time saved or lost:** Not measured.

## 2026-10-22: the production walkthrough and its screenshots

**Task:** Run the alpha path on the deployed product (Vercel, Render, hosted Supabase, the Plaid sandbox) as the synthetic test user and capture the alpha document's screenshots from it.

**Tool:** Claude Code in the main session, with Opus 5.5 subagents for the two fixes it turned up.

**Prompt or skill:** The real-API Playwright projects, first against the production API from a local `next dev`, then from the deployed web app through a second Playwright config (`web/playwright.capture.config.ts`) that runs two capture specs around the product's own `decisions`, `plan` and `check-in` specs.

**What it produced:** 15 screenshots in `docs/alpha/screenshots/`, the walkthrough passing end to end on production (18 of 18), and the findings below.

**What was wrong:**
- A local web app cannot drive the production API: its CORS allows the Vercel origin only, so every read failed with "Could not load your accounts". The capture had to run from the deployed web app itself.
- Plaid Link's iframe stopped on a disabled Continue that nine minutes of generic clicking never enabled. The bank is linked through the API's sandbox route instead, and the "sync in progress" screenshot was dropped rather than faked.
- Production had an Anthropic key that the API rejected (401). The extraction job treated that as a transient error and retried with backoff for about half an hour; the categorize job died the same way. A subagent reproduced it through the worker with a mocked 401 and made a rejected key end the job at once as "no model" (the log entry above).
- Three e2e helpers assumed a warm local server: sign-in's redirect, the Link screen's first read and the documents list each got the 5 s default. On a deployment that was waking up, every API request hung with no answer at all (the trace shows status -1 for all of them). They now wait up to a minute, and the capture spec waits for the documents list before deciding whether to upload.
- The Vercel project still carried the alpha flag `calculators=401k_match`, so three calculators were "After alpha" placeholders in production until the flag was changed to `sankey` and redeployed.
- The capture counted documents before the list had loaded and uploaded a second stub, then picked the newest row (still reading) instead of the one waiting for review. It now filters rows by their status text, without regex anchors in `hasText`, which match the whole row's text.

**How it was caught:** Each from the failing run's trace or page snapshot, then the hosted `jobs` table for the retry loop (`last_error` named the 401) and `/health`'s new `plaid.missing` field for the missing token key.

**Fix:** As above. Production walkthrough issue closed on the board; the alpha document's screenshot table now says what each shot shows without a model key.

**Time saved or lost:** Not measured. Six capture runs before all 18 passed; each failure was a real difference between a deployed product and the local stack.

## 2026-10-22: loans were listed as credit cards on the net worth card

**Task:** The backlog bug "Net worth lists loans under the right kind, not Credit card", found on the production walkthrough: the check-in's net worth card read "Plaid Auto Loan ··9003, Credit card · owed", and the same for the mortgage, the student loan and the home equity line.

**Tool:** Claude Code, an Opus 5.5 subagent in its own worktree.

**Prompt or skill:** Specs first, failing tests first, then the enum, migration, mapping, contract and web label.

**What it produced:** A `loan` account kind. Specs 001, 002, 010 and 015 (and the technical spec's table) say Plaid's `loan` type maps to it and that `credit` and `loan` are both liabilities, with spec 015 route row 12 worked by hand for a student loan. Migration `0015_loan_account_kind` adds the label after `credit`, and its downgrade maps loans back to `credit` and rebuilds the type. The web's kind labels moved to `lib/accounts.ts`, so the net worth card and the CSV import's account types read the same exhaustive map.

**What was wrong:** `sync/plaid/provider.py:account_kind` had `case "credit" | "loan": return AccountKind.CREDIT`, as spec 002 rule 4 said at the time. The totals were already right, because a loan was a liability either way. Only the kind, and so the label, was wrong. The recorded sandbox test even asserted `kinds["Plaid Mortgage"] is AccountKind.CREDIT`, so the tests had locked the label bug in.

**How it was caught:** On the production walkthrough's check-in screenshot. A scratch script linked the live sandbox bank and printed each account's Plaid type and mapped kind: all four loans came out as `credit`. After the fix, the same bank linked on the local e2e stack (real API, worker and Plaid sandbox) gives `GET /net-worth` with four `loan` rows on the liability side and the same totals production showed (assets 8,654,174, liabilities 16,370,589).

**Fix:** As above. Existing loan accounts stored as `credit` change on their item's next sync, because the upsert rewrites `kind`. The migration cannot tell a loan from a card, so it changes no rows. The live `plaid_sandbox` test now asserts the four sandbox loans arrive as `loan`.
## 2026-10-22: income below zero on a sandbox history

**Task:** The production walkthrough's Spending tiles read "Income -$5,845.78", the diagram "Spent beyond income -$7,535.41" and the check-in's "Take-home pay" the same negative figure. The Plaid sandbox books its GUSTO PAY payroll as money out (585,000) and the seed rules label it income; `calc/spending.py` netted the income bucket and flipped its sign.

**Tool:** Claude Code, an Opus 5.5 subagent in its own worktree, orchestrated from the main session.

**Prompt or skill:** Change spec 007 first so income counts money in only and an income-labeled outflow is ignored and reported; reproduce with a sandbox-shaped fixture; fix the calculator and whatever follows; gate on `make lint`, `make test` and `pnpm --dir web e2e`.

**What it produced:** Spec 007 rule 22a with two hand-worked examples (a small month and the sandbox's October), notes in specs 010 and 015; `CategorySum` with money out and money in as separate magnitudes, the SQL `FILTER` aggregates that feed it, and `income_outflows_ignored_cents` on the summary; `tests/support/sandbox_history.py`, which runs the recorded sandbox item through `PlaidProvider`, `run_sync` and the seed rules; route tests for `GET /spending/summary`, `GET /cashflow` and the check-in's take-home line; a web fixture of the API's sandbox month.

**What was wrong:**
- The income bucket was the negated net of every income row, so one income-labeled outflow could push it below zero, and `left_over_cents` and the shares inherited the error.
- Fixing that exposed a second bug: with income 4.22 and no stub, the diagram scaled 4.22 to 400 px and drew Savings about 94,800 px tall. Before, a negative income meant no scale at all, which hid it. `flowScale` now sizes the tallest node it draws to 400 px.

**How it was caught:** The walkthrough's screenshots. The reproduction synced the recorded sandbox responses through the real pipeline and seed rules and asked the route for October: income -584,578 and left over -753,541, the production figures to the cent. The diagram's scale came out of writing the screen test for the fixed numbers.

**Fix:** In the subagent's branch. The sandbox October now reads income 422, `income_outflows_ignored_cents` 585,000, `transfers_ignored_cents` 210,350 and left over -168,541; "Spent beyond income" still shows because that month really did spend 1,689.63 against 4.22 deposited.
## 2026-10-22: example figures that read as values on the decision cards

**Task:** The walkthrough's bug "Prefilled figures are values, not placeholders, on the decision cards": a new user's 401(k) plan details form showed "65,000.00" in Yearly salary and the emergency fund card "300.00" in Monthly transfer to savings, both as placeholders, so saving said to enter the number already on screen.

**Tool:** Claude Code, an Opus 5.5 subagent in its own worktree, orchestrated from the main session.

**Prompt or skill:** Fill each field with the API's value where confirmed data gives it without client arithmetic, else make the placeholder read as an example; failing tests first in the cards' tests; web only.

**What it produced:** `examplePlaceholder` ("for example 65,000.00") in `decision-format.ts`; `SALARY_EXAMPLE` and `BIRTH_YEAR_EXAMPLE` in `plan-details.ts` and `CONTRIBUTION_EXAMPLE` in `emergency-fund-format.ts`, each shared by its placeholder and its "like ..." error so the two cannot drift; the birth year field widened to fit its example. Tests: a new user with a confirmed stub and no profile salary (both fields empty, placeholders that `parseMoney` cannot read, the errors on save), and the emergency fund with no transfer typed.

**What was wrong:**
- The salary placeholder was a bare figure, and the e2e Acme stub (2,708.33 twice a month) implies almost exactly $65,000 a year, so on the walkthrough it looked like the stub's own salary already filled in.
- No field could be filled instead: `PayStubOut` has `gross_cents` and `pay_frequency` but no yearly salary, and `ProfileOut.salary_cents` is empty for a new user. Gross times pay periods is money math, which belongs in `api/calc/`, so the backlog's "save without retyping the salary" needs an API field first and was left for an API change. The monthly transfer has nothing to come from before the first save.
- The birth year's "1996" placeholder had the same fault and was fixed with them. The HSA field's "0.00" was kept: an empty HSA amount is read as $0, so that placeholder shows what empty means.

**How it was caught:** The production walkthrough; reproduced in the card tests with MSW, which failed on the bare placeholders before the change.

**Fix:** As above, then the API piece the first pass named, in a second round on the same branch: spec 005 rule 24a gives `PayStubOut` the computed field `annual_salary_cents` (`calc/pay_stub.py:annual_salary_cents`, gross times `calc.pay_dates.PERIODS`, exact, null without a frequency; `calc.pay_dates.frequency_named` reads the stored enum as the calculator's literal). The spec's example says 270,833 twice a month is 6,499,992 cents, not 65,000.00: nothing rounds it. The plan details form now starts a new user's salary from the newest stub's figure, as a value described by where it came from, so the Acme user saves without retyping; the "for example" placeholder stays for a stub with no pay schedule. A new `k401-results.json` case (made by the API's calculator) covers the card's first result on that salary.

**What was wrong in the second round:** Two concurrent worktrees shared `TEST_DATABASE_URL`, and another branch had already migrated it to a revision this branch does not have (`0015_loan_account_kind`), so every integration test failed in Alembic. This worktree's `.env` now points at its own database, `first_paycheck_test_salary`. Pydantic's `@computed_field` over `@property` fails mypy (`prop-decorator`); the decorator alone (pydantic applies the property) passes without a `type: ignore`.

**Time saved or lost:** Not measured.
## 2026-10-22: choosing the Plaid sandbox user on the sandbox link route

**Task:** `POST /sync/items` with `sandbox_institution_id` always linked Plaid's default `user_good`, although `PlaidClient.sandbox_public_token_create` already took a `username`. The plan wants a custom sandbox user for deterministic evals, so the route needed to name one.

**Tool:** Claude Code, an Opus 5.5 subagent in its own worktree, orchestrated from the main session.

**Prompt or skill:** Spec 002 rule 27 first, then failing route, validator and client tests, then the client, request model and route; extend the live `plaid_sandbox` test with `user_transactions_dynamic` and run it once against Plaid; let the e2e link helper take `E2E_PLAID_USERNAME`.

**What it produced:** `sandbox_username` and `sandbox_password` (a `SecretStr`) on `LinkItemRequest`, passed as `override_username` and `override_password`; a `password` keyword on the client; route tests for the options reaching the fake, the 422 cases and a 502 that never echoes or logs the password; a live test linking `user_transactions_dynamic`; `linkSandboxBank` adding the username to the button's request with `page.route`.

**What was wrong:**
- The brief's 64 KB limit was checked against Plaid before it was written into the spec. Plaid refuses any request body over 100,000 bytes, and a JSON configuration's quotes are escaped again inside the body, so 65,536 characters is about the most that fits. The repo's own `evals/fixtures/recurring/custom_user.json` is 91,747 characters even compact (a 105,049-byte request) and Plaid refuses it this way; it has to be loaded some other way, such as Sandbox Studio.
- `user_transactions_dynamic` names its accounts "Checking", "Credit card" and five loans, not "Plaid Checking", so the e2e helper's last check and the later specs' account names hold only for `user_good`. The helper now checks only that accounts appeared when a username is set, and `web/CLAUDE.md` says to run just the link step with another user.
- Spec 002's status line still said the live sandbox path had never run against Plaid; it had (the recorded fixtures and the loan fix). It now says when it last ran.

**How it was caught:** A scratch probe of `/sandbox/public_token/create` with the eval configuration, a 300,000-character password and malformed JSON (Plaid answers `INVALID_CREDENTIALS` without repeating the password); the live `plaid_sandbox` run; a local e2e stack run linking `user_transactions_dynamic` through the button, then reading its accounts from the database.

**Fix:** As above, in the subagent's branch.

**Time saved or lost:** Not measured.

## 2026-10-22: loan ledgers in the spending summary, and shares of a few cents of income

**Task:** Two walkthrough bugs on Plaid's `user_transactions_dynamic` user. `GET /spending/summary` read every account, so five loans' own ledgers ("Monthly payment" booked as money in, "Interest charged" as money out) drove the tiles, the diagram and the check-in's take-home and left-over lines (`uncategorized_cents` -5,498,010). With 12 cents of income the summary sent `essentials_pct` "304000.0" and the tiles printed it.

**Tool:** Claude Code, an Opus 5.5 subagent in its own worktree, orchestrated from the main session.

**Prompt or skill:** Spec 007 first (rule 21a: checking, savings and credit only, the rest reported as `ledger_rows_skipped`; rule 25: a share is null with no income or past 1,000.0), then specs 010 and 015; record the dynamic user and reproduce through the real pipeline; failing calculator, route and web tests; then the code and `make types`.

**What it produced:** A recording of the dynamic user (`api/tests/fixtures/plaid/recorded/dynamic`) that `tests/support/sandbox_history.py` replays through `run_sync` and the seed rules; `SPENDING_ACCOUNT_KINDS` and `LEDGER_ACCOUNT_KINDS` in the spending router with a test that every `AccountKind` is in exactly one; `ledger_rows_skipped` and `account_kinds_counted` on the summary; the share limit in `calc/spending.py`; "n/a, income too small to compare" on the tiles and the diagram's bucket details; a ledger note on Spending and the check-in.

**What was wrong:**
- The brief's share rule, "null when the share would exceed 1,000.0, a negative bucket still shown", would have kept the reproduction's `flexible_pct` of "-849825.0": the seed rules file the dynamic user's payroll under dining, so flexible is -1,019.79 against 12 cents of income. The rule as written limits the share's size, either sign; a refund-heavy month's -15.0 is still shown.
- The bug reports from production had loans driving take-home; the no-model reproduction left the loans' rows uncategorized instead, so take-home was unchanged there. The hand-worked loan month labels the loan's payment received `income`, as a model might, so the route and check-in tests fail on take-home (291,500 against 250,000) as production did.
- Found along the way: a null essentials share made the diagram's Essentials details fall through to the "Debt payments, fees, taxes and other spending" text; the summary card named every active account, loans included, as the accounts its totals covered; a category's popover listed rows the API had not counted.

**How it was caught:** The recording replayed under the old code gave exactly the production figures (`uncategorized_cents` -5,498,010, `essentials_pct` "304000.0"); the route test was written against those rows before the fix.

**Fix:** As above, in the subagent's branch. The dynamic October's expected figures depend on the seed rules, which another branch is changing at the same time (its payroll may become income); that test's numbers will move when the two meet.

**Time saved or lost:** Not measured.
## 2026-10-22: spending rules apply to money out only; seed rules for bank descriptors

**Task:** Two bugs from production with Plaid's `user_transactions_dynamic` sandbox user. The weekly paycheck `Sweetgreen inc payroll ppd id` (money in) was labeled `dining` by the seed prefix rule `sweetgreen`, because the categorizer never looked at the sign; and 256 of 316 rows were uncategorized with rules only, most of them the loans' own ledgers (`Monthly payment`, `Interest charged`).

**Tool:** Claude Code, an Opus 5.5 subagent in its own worktree, orchestrated from the main session.

**Prompt or skill:** Spec 003 first (direction, a seed-only `contains` match for income and transfer, the descriptors), a reproduction over the recorded dynamic user, failing precedence, seed loader, job, gateway and migration tests, then the code; eval fixtures and baseline in their own commits.

**What it produced:** `RuleBook.match(merchant_norm, *, amount_cents)` that skips a spending rule for money in; `contains` rules below `prefix` (whole-token runs, money in only); the job labels each merchant and direction apart, sends the direction to the model (`categorize/v2`) and drops a spending answer for money in; a user's spending fix keeps its own row and relabels only money-out siblings; migration `0016_rule_match_contains` (enum label, a check that keeps `contains` to seed income and transfer rows, and clearing the rule and model labels the new rules forbid so the next sync relabels them); seed rows for the descriptors, with `interest` exact `fees` plus `contains` `income` so the word resolves by its sign. The dynamic user goes from 256 to 52 uncategorized rows, with the paychecks as income.

**What was wrong:**
- The first recording of the dynamic user had zero transactions: Plaid answered `HISTORICAL_UPDATE_COMPLETE` with an empty page once, and the recorder takes the first page that is not `NOT_READY`. A second run recorded 316 rows. The recorder does not yet retry an empty complete page.
- The brief called `Interest` money in; in the recording it is money out on the student loan (Plaid files it under bank fees), so an exact `interest -> income` rule would have made accrued interest income. The spec resolves it by sign instead.
- Making spending rules money-out only also stops rules from netting refunds: the recorded `user_good` October's United Airlines refund (-50,000) is now uncategorized, which changes spec 007's sandbox example (flexible 118,423, left over -218,541).

**How it was caught:** The reproduction test over the recorded rows; the full test run (three sandbox spending tests); reading the recorded rows by account and sign.

**Fix:** As above, in the subagent's branch.

**Time saved or lost:** Not measured.

**Revised before merge:** Making spending rules money-out only also stopped refunds from netting (the `user_good` October's United Airlines refund, -50,000, became uncategorized and changed spec 007's figures). The coordinator replaced it with direction-aware precedence: money out goes user exact, user prefix, seed exact, seed prefix; money in goes user exact, user prefix, seed contains, seed exact, seed prefix. The paycheck is still `income` (`payroll` beats the prefix `sweetgreen` for money in), the refund is `travel` again, the model may call money in a refund, and a user rule applies both ways. A failing precedence row (`united airlines`, -50,000 -> `travel`) reproduced it first; the migration test now runs the categorize rules pass after 0016 to show the cleared rows come back right.

## 2026-10-30: the W-4 explanation tells the stub's withholding from the entries' (issue 181)

**Task:** The e2e account's W-4 explanation (`explain/v2`) said "Your employer withholds $423.16 of federal income tax from each paycheck ... withholding is almost exactly matched", while its pay stub withholds $272.44 and the W-4 card says $3,918.70 is due if nothing changes. Issue 132's 401(k) bug, on the W-4.

**Tool:** Claude Code, an Opus 5.5 subagent in its own worktree, orchestrated from the main session.

**Prompt or skill:** Spec 008 rule 7b and spec 014 rule 19 first, a reproduction of the context and fallback for spec 014 example 11, failing calc, context, fallback, route and stale tests, then the code; a new eval suite with its own judge, measured live.

**What it produced:** `calc/pay_stub.py:withholding_on_schedule` and `stub_withholding` (entries, other, none); `calc/w4.py:at_withholding`, which `w4()` now uses for rule 10a too; `POST /explain` reads the newest stub once for the 401(k) rate and the federal withholding; W-4 facts that say whose each figure is, the stub's withholding and the balance due at it as facts, allowed numbers and fallback text (`fallback/v4`); `explain/v3` (v2 plus W-4 rules); `judge_withholding_claim/v1` and the `explain-w4` suite (12 decisions, 24 calibration items). Live: explain-w4 1.0 on all five metrics in three runs (22.82, 22.43, 21.39 cents); the 401(k) explain suite on v3 1.0 on all five (47.14 cents).

**What was wrong:**
- The root cause was in the context, not the model alone: the fact was labeled `Federal income tax withheld per paycheck`, the refund note said "more is withheld than the year's tax", and the fallback itself said "your employer withholds $423.16". No stub figure reached the model.
- A first scripted calibration test used a decision the judge scores, so the scripted judge was asked about a request it had no label for; the test now uses a decision it does not score.
- Two live runs started together hung for over 30 minutes in an SSL read at 1.3 s of CPU (probably the laptop sleeping; the 120 s request timeout did not fire). They were killed and rerun one at a time; their partial spend is not known, at most a few cents.

**How it was caught:** The production explanation (user report); the reproduction printed the old context and fallback; the integration tests through `POST /explain` with the fake model failed before the fix.

**Fix:** As above, in the subagent's branch.

**Time saved or lost:** Not measured.
