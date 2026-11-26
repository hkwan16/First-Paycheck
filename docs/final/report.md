# First Paycheck: Final Report

Stanford CS146S, Autumn 2026. Final release and report, due December 10, 2026. Draft written November 26, 2026 against `main` at commit `a3946d5`. Every number below comes from a file in the repository, a command named beside it, or a GitHub query run on November 26; HTML comments mark the places that will change before submission.

## 1. Summary

First Paycheck guides a new salaried employee through the money decisions of their first month at work: the Form W-4, the health plan, the 401(k) contribution, the emergency fund, and what is safe to spend. It works from the person's own pay stub, benefits summary and bank data, then checks in every month to see whether the decisions took effect. All money math runs in deterministic, tested Python in `api/calc/` over integer cents. Claude does three things only: reads redacted documents, labels merchants no rule knows, and writes explanations. Everything the model produces is a proposal until the person confirms it, and every explanation is checked number by number against the calculator and must cite an IRS or plan source.

The product is deployed: the web app on Vercel at <https://first-paycheck-silk.vercel.app>; the API and its job worker as one Docker service on Render's free tier at <https://first-paycheck-api.onrender.com>; Postgres with row-level security and sign-in on hosted Supabase; bank data from the Plaid sandbox; Sonnet 5.5 through the Anthropic API. The repository is <https://github.com/hkwan16/First-Paycheck> and the board is <https://github.com/users/hkwan16/projects/1>.

All nine proposed MVP features are functional in production (section 3). Of the nine success criteria in the technical spec, seven are measured by the eval suites and met; two depend on a moderated user test that has not been run (section 5). Coverage is 98% of statements on the API and 97.6% on the web app (`docs/quality.md`).

<!-- TEAM STATEMENT: confirm wording with both members before submission -->
The team is two people, and the record shows two different periods. hkwan16 (Hayden Kwan) built the repository alone from the first commit on October 13 to the last merge on November 20: all 781 commits on `main` at `a3946d5` are his (`git shortlog -sn main`). He owns the architecture, the API, the calculators, the eval suites, and the check-in and explain engines. Rosman-Carino (Rosman Cariño) joined for the hardening milestone on November 26, owning the web polish and accessibility fixes, infrastructure (the keep-alive, coverage reporting), the issue board for the hardening work, the follow-up issue filing and this report, with cross-review on every pull request from that date. The first six weeks had one author and no reviewer; the last two have two authors and a review on every PR. We say so plainly rather than imply an even split.

On November 26, `main` is deployed and green, sixteen pull requests are open awaiting review (twelve fixes from the hardening pass, the quality page, and three of the follow-ups), seven more branches wait for a rebase, and 38 of 233 GitHub issues are open (`gh issue list --state all`), most of them the November 20 production findings the open PRs fix.

## 2. Business Context and Requirements Brief

### The user problem

A person starting a first salaried job faces several consequential financial decisions in the first month, usually with no training: a W-4, a health plan before an enrollment deadline, a 401(k) contribution, and a sense of what is safe to spend. Budgeting apps ignore benefits and taxes, an advisor costs too much on a first salary, and articles are not about the reader's numbers. After setup, nothing checks whether the decisions took effect: a 401(k) election that never reached payroll looks the same as one that did (`docs/proposal.md`; `docs/technical-spec.md` section 5).

The target user is in their first 30 days at a first salaried job with benefits, holding an offer letter or pay stub, a benefits deadline, a bank account with a few months of history, and little financial training. They return monthly for a check-in and yearly at open enrollment and tax season. The business model is free for individuals or sold to employers as a financial-wellness benefit; employer sales are out of scope for the course.

### Scope and success criteria

The proposal set nine must-have features and three stretch goals; their status is the table in section 3. The technical spec set nine success criteria with a measurement for each (extraction, categorization and recurring-detection accuracy; calculator and check-in correctness; citation and fallback rates; setup in two sittings; understanding gain); the scorecard with targets and measured values is in section 5.

### How requirements were communicated

Requirements flowed through five written forms, each more specific than the last, read by teammates and AI tools alike.

| Form | Where | What it fixed |
|---|---|---|
| Proposal | `docs/proposal.md` | The problem, the user, nine MVP features, three stretch goals |
| Technical spec | `docs/technical-spec.md` | Architecture, data model, API design, the nine success metrics, agent readiness |
| Spec amendments | `docs/plan.md`, "Spec amendments" | 17 changes made before any code, each with a reason (section 3) |
| Feature specs | `docs/specs/001` to `019` | Goal, inputs, outputs, numbered rules, hand-worked examples, edge cases, status; tests are written from the examples |
| Backlog | `docs/backlog.yaml`, synced to the GitHub Project | 180 issues by milestone; every issue body ends with a definition of done |

For the AI tools, the repository carries the context a teammate would get. The root `CLAUDE.md` states the product, eight non-negotiable rules (money math only in `api/calc/`, one module may import `anthropic`, every query under row-level security, a failing test first, no em dash, fix root causes, synthetic data only, the API contract is generated), the repo map and the commands; `.cursor/rules/first-paycheck.mdc` mirrors it, and `scripts/tests/test_agent_context.py` fails when the two drift. `api/`, `web/` and `evals/` each add a `CLAUDE.md`. Every feature spec has hand-worked examples, so an agent writes tests from arithmetic a reviewer can check by hand, and calculator examples also go into `evals/fixtures/calc/` so the eval runs them through the HTTP route. Each coding agent received a brief naming the specs to read, the files it owned, the files another agent owned, its own test database and a gated command to pass before reporting (`docs/ai-log.md`, October 21). The rules are enforced by tests and lint, not by the prompt alone: a boundary test fails if `calc/` imports anything but the standard library, `pydantic` and `calc`; ESLint rejects raw colors and em dashes in the web app; pre-commit and CI reject U+2014 anywhere.

### Real prompts, and how they changed

`docs/ai-log.md` has 36 dated entries, each with a "Prompt or skill" line. Five, quoted verbatim, show how the instructions changed and why.

**October 21, the parallel build.** "One brief per package, written from the build plan's milestone section. Every brief repeated the repository rules (spec first, failing test first, integer cents only in `calc/`, RLS everywhere, no em dashes) and asked for deviations to be reported with reasons." Sixteen Opus subagents built M3 to M10 in one day. Two agents' Alembic migrations revised the same parent, and three re-chains were needed at merge (0004 onto 0007, 0012 onto 0009, 0013 onto 0012). Later briefs named the current migration head and the problem stopped. After two worktrees' suites rewrote the same cluster-wide role ("tuple concurrently updated"), every brief also named a private test database.

**October 22 and November 11, the categorize prompt.** "Spec 003 first (direction, a seed-only `contains` match for income and transfer, the descriptors), a reproduction over the recorded dynamic user, failing precedence, seed loader, job, gateway and migration tests, then the code; eval fixtures and baseline in their own commits." A paycheck from "Sweetgreen inc payroll" had been labeled dining because nothing looked at the sign of the amount; `categorize/v2` sends the direction. On November 11 the brief for issue 250 read: "The fix brief: spec first, the bug reproduced end to end on the local stack and kept as a Playwright test, failing unit and integration tests, earlier guesses relabeled through the categorize job's rules pass (PR 248), a new prompt version instead of an edited one, free evals only." The cause was the prompt: `categorize/v1` to `v3` all told the model that `transfer` covers "ATM withdrawals", so cash counted in no total. `categorize/v4` adds a `cash` category ("It is spending, not a transfer, because what the cash buys never shows up as a transaction") and removes withdrawals from `transfer`. Released prompts are never edited; a new version gets its own live baseline.

**October 30, the explain context (issue 181).** "Spec 008 rule 7b and spec 014 rule 19 first, a reproduction of the context and fallback for spec 014 example 11, failing calc, context, fallback, route and stale tests, then the code; a new eval suite with its own judge, measured live." The W-4 explanation said the new entries' $423.16 per paycheck was withheld now, while the pay stub withheld $272.44. The number checker accepted it because the context had labeled the figure "Federal income tax withheld per paycheck" and no stub figure reached the model. The fix put the stub's withholding into the context as its own fact, released `explain/v3`, and added an LLM judge calibrated on 24 hand-labeled items to a new `explain-w4` suite.

**November 1, the test that had to fail first (issue 172).** "Spec 018 first, then the unit tests (a failing "no button" test), then the code; the issue 172 test had to fail at a desktop width with the fix turned off before it could replace the phone one." The test passed at 1280x820 and 1280x600 with the fix removed. A scan of window heights found the bug only at 625 to 675 px; the test now runs at 1280x650 and, after the coordinator's review, checks its own precondition so a drift in the page's loading height cannot make it pass with the fix gone.

**November 26, the hardening briefs.** Each brief carried the issue's definition of done, required a failing test first, named the exact gate command, and asked for a plan file with the root cause, the change, the tests, the Playwright impact and a ready PR body (`Issue-Plans/README.md`, outside the repo). The coordinating session reviewed each branch and re-ran the gate. Review caught what the gates did not: a loan account left with no way back to "counted in net worth" once marked not used (issue 265, now a checkbox), a chip whose first version would have changed its tone and moved all five decision screenshot baselines (issue 257, the chip stays neutral), and a regenerated screenshot committed with code (issue 268, split into its own commit as `web/CLAUDE.md` asks). CI on real data caught a fourth: a Playwright locator that matched two "Other" nodes (issue 268), which the sample data never triggered.

## 3. System Design and What Shipped

### Architecture

A Next.js 16 client on Vercel talks over HTTPS with a Supabase JWT to a FastAPI API on Render; the same container runs a worker over a Postgres job queue (`python -m app.serve`). Every query runs as the signed-in user under row-level security, so another user's row is a 404, never a 403. Supabase provides Postgres through the Supavisor pooler and Auth. Plaid (sandbox) and the Anthropic API are the only other external services (`docs/technical-spec.md` section 1).

Three rules hold throughout, each enforced by a test:

1. **All money math lives in `api/calc/`:** pure functions over integer cents, `Decimal` rates, half-up rounding, no I/O, no LLM. `api/tests/unit/test_boundaries.py` fails on a forbidden import; the web app only formats cents.
2. **Only `api/llm/gateway.py` calls Claude.** Only redacted content is sent; every call writes an `llm_calls` ledger row and respects a per-user daily budget.
3. **Everything the model produces is a proposal until the user confirms it.** Calculators read confirmed tables only; the confirm route refuses a pay stub whose gross minus deductions does not equal net (a 422, mirrored in the client).

Data flows in ten steps: sync (Plaid or CSV through one provider interface), upload and redact, extract (a worker job the client polls), categorize (user rules, seed rules, then the model for unknown merchants only; a fix becomes a rule), detect recurring charges, calculate, decide (an immutable version per save, enforced by constraints and a trigger), explain, verify (one retry, then a flagged fallback), and export (PDF and `.ics` in the worker). Since November 20, "today" is the person's calendar day in their browser's zone, not the server's UTC day (spec 019, migration `0026_the_persons_day`).

### Features

| Proposal feature | Status on November 26 |
|---|---|
| 1. Bank sync and spending map | Functional: Plaid sandbox and CSV through one pipeline; rules first, model for unknown merchants, user-correctable; tiles, cash-flow diagram, recurring charges |
| 2. Paycheck decoder | Functional: PDF and image upload, redaction, extraction as a job, per-field confirm, the arithmetic gate; federal lines computed, state lines labeled only |
| 3. Emergency fund goal | Functional: 3 to 6 month target, time to goal at several rates, progress against the linked savings account |
| 4. 401(k) match optimizer | Functional: full-match rate, dollars gained or missed, per-paycheck cost before and after federal tax |
| 5. Health plan comparison | Functional: HDHP with HSA against PPO, expected cost and break-even by usage |
| 6. W-4 walkthrough | Functional: Pub 15-T percentage method for 2026, projected refund or balance due, a Step 4 suggestion |
| 7. "Why" explanations | Functional: verified against the calculator, IRS citation required, fallback after one retry |
| 8. Saved plan and decision calendar | Functional: immutable versions, one-page PDF, `.ics` file, next 90 days of dates |
| 9. Monthly check-in | Functional: election mismatch, goal off pace, new or changed charge, pay change, upcoming date; cash flow against the plan, net worth, holdings |
| Stretch: Plaid production | Not started (issue 104); the sandbox is enough for the course and the pipeline would not change |
| Stretch: savings priority ladder | Not built; judged too large for the last two weeks (`Plan.md`, Tier 3) |
| Stretch: employer layer | Not built; out of scope by design |

Two decisions narrowed scope. On November 1 the product became desktop only: the Playwright phone project and its 64 baselines were removed, and nothing is designed or tested for a phone (`docs/ai-log.md`, November 1). Sentry's hooks are in the code but the DSN is not set in production (issue 49).

### Spec amendments

Planning produced 17 amendments to the finalized spec before any feature code (`docs/plan.md`; `docs/technical-spec.md`, "Changes since the finalized PDF"), in three groups. Money correctness: every money column is a `bigint` named `*_cents`, `tax_year` comes from the pay date and is passed explicitly, the confirm gate runs on both sides. Operability: extraction became a job because OCR plus a vision call takes 15 to 60 seconds, raw uploads moved into a table under RLS so one `DELETE` on confirm removes them, Render connects through the pooler because Supabase's direct host is IPv6 only, and a manual sync route exists because webhooks never reach a laptop. Contract: the OpenAPI document is committed, the web client's types are generated from it, and CI fails on drift. Later changes followed the same path, spec first: 19 feature specs exist, and the hardening amendments (spec 019 for the person's day, spec 003 rule 9d for cash) are dated inside the spec files.

## 4. AI Tool Integration

**Code generation and refactoring.** The codebase was built with Claude Code. A main session planned the work and wrote the specs; sixteen Opus 5.5 subagents, two to four at a time, each in its own worktree with its own test database and gated command, built M3 to M10 on October 21, and the main session reviewed and merged their branches. Test counts went from 733 to 1,922 on the API and 605 to 1,332 on the web that day; the cost was orchestration, roughly a third of the main session on merges and conflicts (`docs/ai-log.md`, "M3 to M10 built by parallel Opus subagents"). On November 26 the same pattern produced the hardening: twenty branches by parallel agents against written definitions of done, each reviewed by a coordinating session (`Issue-Plans/README.md`).

**Automated testing.** The tests are AI-written from the specs' examples; the human role is the spec, the review and the production passes. One AI-written test caught a real bug before it shipped: the Hypothesis property for the W-4 Step 4(c) suggestion found that lowering Step 4(c) to zero can leave a refund that only another job's withholding causes, which the spec's first draft had claimed impossible (`docs/ai-log.md`, October 21, M7). Another: the deletion test that lists every user table from `information_schema` and fails when the fixture leaves one empty (M10). The eval suites are AI-written too, with baselines measured live and a tolerance per case (`evals/CLAUDE.md`).

**Code review and QA.** Four production passes with Claude in Chrome, clicking through the deployed app as the synthetic test user, found 25 issues on October 29 to 31 (#132 to #184), 16 on November 1 (#194 to #209), 23 on November 9 (#221 to #243) and 15 on November 20 (#257 to #271), with CI green each time (`docs/ai-log.md`; issue creation dates from `gh`). The coordinating session's review of agent output caught the three things in section 2. Human review still mattered: the Sankey mockup's clipped column was a person's bug report, and the product decisions (desktop only, supersede rather than refuse a duplicate pay stub, cash is spending) were made by a person and written into specs first. What did not happen until November 26: a GitHub review on any pull request (section 6).

**UI and UX prototyping.** Two clickable mockups of the setup flow and check-in were generated on October 20, one by the main session and one by a subagent using the `apple-design` skill. Mockup B was chosen, committed verbatim under `docs/mockup/` as the design reference, and ported to React. Its client-side formulas were not ported; every number on screen comes from the API (`docs/mockup/README.md`).

**CI/CD and deployment.** Six AI-written GitHub Actions workflows: `ci.yml` (lint, migrations up and down against Postgres 16, `api-test` with a coverage floor of 85%, `ingest-in-docker` against the image's pinned Tesseract, `types-drift`, `evals-free`, `web-test`), `web.yml` (lint, typecheck, unit tests, the OpenAPI types check, Playwright smoke with axe and screenshots), `e2e.yml` (the real-API Playwright projects against an API, worker, auth stand-in and Postgres), `deploy.yml` (migrate and seed production, then the Render deploy hook; Vercel deploys from `main` itself), `keepalive.yml` (a `/health` ping every 10 minutes) and `nightly.yml` (every eval suite at 09:17 UTC, opening an issue on a regression). Merging to `main` deploys; nothing is manual.

## 5. Testing and Quality

Counts are from `docs/quality.md`, measured November 26 at `a3946d5`.

| Layer | Count | Notes |
|---|---|---|
| API unit (`api/tests/unit/`) | 1,835 | No database, no network; includes 45 Hypothesis property tests in 12 calculator files |
| API integration (`api/tests/integration/`) | 912 | Against a real Postgres, locally and in CI |
| RLS cross-user (`api/tests/rls/`) | 51 | Every user route attempted by user B on user A's data; a meta-test fails when a route has no case |
| Eval runner and script tests | 160 and 80 | `evals/tests/`, `scripts/tests/` |
| Python total | 3,038 collected, 6 deselected live tests | `uv run pytest --collect-only` |
| Web unit (Vitest) | 1,963 tests in 175 files | jsdom, MSW for the API |
| Playwright | 19 spec files, 133 test blocks, 68 committed screenshots | Smoke (axe and screenshots) on every PR; real-API projects in `e2e.yml` |
| Eval suites | 11 suites: 6 free, 5 LLM | Free suites on every PR and nightly; LLM suites locally with a key |

Coverage: the API is at 98% (10,185 statements, 191 missed; 1,764 branches, 85 partial). The uncovered lines are the process supervisor's signal path, the Tesseract and WeasyPrint calls that run only in the Docker job, misconfigured-deployment branches, and live-only Plaid and gateway error paths; `api/calc/` misses nine statements, none arithmetic. The web app is at 97.57% of statements, 93.77% of branches, 98.23% of functions and 98.28% of lines; the gaps are the cash-flow detail panel (driven by Playwright instead), drag-and-drop handlers, and route-group layouts that Next.js renders. Web coverage is not yet run in CI.

The scorecard against the nine spec targets (`docs/quality.md`, "Eval scorecard"):

| Metric | Target | Measured | Met |
|---|---|---|---|
| Extraction accuracy | 95% of fields, 30 documents | 1.0 field and document accuracy over 34 stubs and 5 benefits summaries (39 documents, 442 fields) | Yes |
| Categorization accuracy | 90%, 500 transactions | 1.0 over 547 rows; rules alone cover 78.06% with precision 1.0 | Yes |
| Recurring detection | 90% precision and recall | precision 1.0, recall 0.9545 (21 of 22 series over two histories; a thin sample) | Yes |
| Calculator correctness | 100% | 46 of 46 spec examples through the HTTP routes | Yes |
| Check-in findings | 100% | 22 of 22 seeded scenarios | Yes |
| Explanations citing a source | 100% | 1.0 on 31 401(k) and 12 W-4 decisions | Yes |
| Fallback rate | at most 5% | 0% on the same 43 decisions | Yes |
| Setup in two sittings | 80% of users | Not measured | No |
| Understanding gain | +2 points | Not measured | No |

<!-- USER TEST: if the moderated test runs before December 10, replace this paragraph and the two "Not measured" rows with the results from docs/user-test/results.md -->
The two unmeasured metrics need people, not CI. The kit for a moderated test with 5 to 8 participants (consent form, facilitator script, the quiz with its key, observation sheet) is complete in `docs/user-test/`, but no session has run and `docs/user-test/results.md` does not exist. This report does not claim otherwise. Two LLM baselines are also stale: `categorize/v4` and two explain fixtures added for issue 223 have had no live run (`evals/CLAUDE.md`), and the nightly runs only the free suites because the API key is not a GitHub secret (issue 145).

**AI-assisted QA, evaluated.** It found what CI missed: 79 production issues over four passes with CI green each time, among them a paused savings goal that still said it was on pace (#166), a document that could never be read again after a fallback to manual entry (#163), a key saved on Render as `ABTHROPIC_API_KEY` that let production start healthy with no model (#133), and a pay stub confirmed twice that counted its pay twice (#190). It also failed in three instructive ways. A test passed without testing anything: the issue 172 test passed at desktop width with the fix removed, and only a scan of window heights found where the bug appears. A verifier accepted a misleading explanation: issue 181's W-4 explanation matched every number and still called a planned withholding the one in effect, because the context had labeled it that way; the fix was in the context, plus an LLM judge that scores framing. And a strict-mode locator failed only on real data: the issue 268 spec matched two "Other" nodes on the sandbox month but not on the sample data, so the local run and the smoke job passed and the real-API job failed.

## 6. Collaboration and Process

**Roles.** As in section 1: hkwan16 owns architecture, the API, the calculators, the evals and the check-in and explain engines, and reviews every hardening PR; Rosman-Carino owns the web polish and accessibility fixes, infrastructure, the hardening board, follow-up issue filing and this report, and reviews hkwan16's PRs in return.

**The board.** The GitHub Project holds every issue with a status, priority, milestone and assignee. Its source is `docs/backlog.yaml`, synced by `scripts/sync_backlog.py`, which creates issues, sets statuses, closes done items and updates milestones; on November 26 the YAML held 180 entries, 174 done (`Plan.md`). It has drifted from GitHub since November 9: the 15 issues from November 20 and the 13 from November 26 are not in it, and PR #251, which carries the previous batch, is open and conflicting. Issue #290 tracks the resync.

**Pull requests and reviews.** The repository has 67 pull requests: 50 merged and 17 open (`gh pr list --state all`). The first 50, all by hkwan16, were merged by their author without a GitHub review; the technical spec had promised "AI review on every PR plus a human approval", and that did not happen. Cross-review started with the hardening PRs on November 26: #273 to #278, #291 to #296 and #297 to #300 were opened by Rosman-Carino with hkwan16 requested as reviewer, and each waits on his review before it merges. As of this writing `main` has no branch protection (`gh api .../branches/main/protection` returns 404), so GitHub does not yet require CI or a review; turning it on is the first item on the process list, with `ingest-in-docker` as a required check (issue 33).

<!-- BRANCH PROTECTION: update once protection is on and screenshot it for the appendix -->

**CI gates.** Every PR runs `ci.yml`, `web.yml` and `e2e.yml`: ruff, mypy, the em-dash check, ESLint, Prettier, `tsc`, migrations up and down, about 3,000 Python tests with coverage, the Docker ingest job, the OpenAPI drift check, the free evals, the web unit tests, Playwright smoke with axe, and the real-API Playwright projects. Each November 26 PR's first CI run found something: three sets of expected Linux screenshot baselines (#277, #278, #295), one real e2e locator bug (#278), one chip rendering change that lost tabular numerals (#292), and one cursor-rule mirror test (#296). All were fixed the same day and every PR is green.

**Merge order.** Twenty branches touch overlapping files in the chrome, the decisions screen and the specs, so a merge order and rebase map were measured with `git merge-tree` across every pair (`Issue-Plans/README.md`). Six conflict with nothing and were opened first (#273 to #278); five are the first of a conflicting pair and were opened next (#291 to #295); seven wait for a rebase on a partner (the appendix table says which). Nine of the thirteen conflicts are in docs only. Two branches each add a migration numbered `0027`; #264 merges first and #266 is renumbered `0028` afterwards, as the repo did for `0023`.

**A process fix.** Two issues from the November 9 pass stayed open only because the PR bodies that fixed them said "Part of #240" and "Part of #243" instead of "Fixes", so GitHub never closed them. Both are fully fixed on `main` (PRs 246 to 249) and need a closing comment. Every hardening PR body says "Fixes #n" or "Closes #n", which `gh pr list --json closingIssuesReferences` confirms for all fifteen fix PRs (#296 is docs only).

## 7. Reflection and Lessons Learned

### How business context communication affected development

Writing the context down before the code paid off three times. Grounding the build plan in the proposal and spec produced 17 amendments before any feature code, and several of them (integer cents everywhere, the explicit tax year, the committed OpenAPI contract) are why parallel agents could build the API and the web client side by side without the client ever doing arithmetic. Hand-worked examples caught errors in our own understanding: the 401(k) property "missed match is zero if and only if the contribution is at or above the full-match percentage" is false when the 402(g) limit binds, found while working spec 006's $500,000 example by hand. And where context was missing, the agents did exactly what they were told and the result was wrong: the categorize prompt listed ATM withdrawals under transfers for three versions; the explain context labeled a planned figure as the current one, so model and verifier both accepted it; two agents revised the same migration parent because no brief named the head. Each was fixed by one sentence of context in the spec, the prompt or the brief, and a test that fails without it.

### Where AI tools succeeded or failed, and how the instructions adapted

They succeeded at volume and discipline: a plan scheduled for five weeks landed in one day, every merge gated on lint, two test suites and the free evals, and the suites now hold about 5,000 tests. Testing production like a person found 79 bugs that green CI did not. They failed in ways a person had to notice. Production ran a day with no model because of a misspelled environment variable; the fix was a refusal to start without the key, not a prompt. A verified explanation misled; the fix was in what the model was shown, plus a judge that reads framing rather than numbers. A regression test tested nothing at the width it ran at; the fix was to make it fail first with the fix off, then to check its own precondition. The instructions adapted in four durable ways: briefs name the migration head and a private test database; a released prompt is only ever versioned, with a live baseline; every bug is reproduced end to end, the way a user hits it, and kept as a regression test; and someone other than the author reads every branch, because the November 26 review caught three things the gates had passed.

### What we would do differently

- **Cross-review and branch protection on day one.** Fifty PRs merged without a review, against the spec's own promise. Requiring one from the first PR would have cost minutes a day and made the hardening handoff unnecessary.
- **Run the user test in week three, not week nine.** Two of nine success criteria are unmeasured because recruiting started too late. The kit took a day; the sessions needed a calendar.
- **File issues from every production pass into the YAML the same day.** The board drifted for two weeks because findings went straight to GitHub and the sync was deferred.
- **A live-model eval in CI from the start.** The nightly runs only the free suites; `categorize/v4` still has no live baseline. One secret and about $1.30 a day would have caught prompt drift within a night.
- **Smaller PRs.** The parallel build's merges cost a third of the main session; the November 26 PRs that merged cleanly touched one screen and one spec.

## 8. Appendix

### Links

| What | Where |
|---|---|
| Repository | <https://github.com/hkwan16/First-Paycheck> |
| Project board | <https://github.com/users/hkwan16/projects/1> |
| Web app (Vercel) | <https://first-paycheck-silk.vercel.app> |
| API health (Render) | <https://first-paycheck-api.onrender.com/health> |
| AI tool log | `docs/ai-log.md` (36 entries) |
| Quality page | `docs/quality.md` (PR #296) |
| Alpha document and demo recording | `docs/alpha/README.md`, `docs/alpha/alpha-demo.mp4` (111 seconds, recorded from production November 1) |
| Feature specs | `docs/specs/README.md` |
| User test kit | `docs/user-test/README.md` |
| Issue plans | One Markdown file per hardening issue (root cause, change, tests, CI findings, PR body), kept outside the repository in the course folder `Final Project/Issue-Plans/` because they describe unpushed branches; its `README.md` holds the merge order and rebase map |

### Hardening pull requests, as of November 26

<!-- HARDENING TABLE: update states as PRs merge and the seven rebased branches open -->

| PR | Issue | Title (short) | State |
|---|---|---|---|
| #273 | #272 | The eval baseline test skips without tesseract | Open, green |
| #274 | #271 | The create-account page's tab says Create an account | Open, green |
| #275 | #262 | The side nav stays in view while the page scrolls | Open, green |
| #276 | #225 | The Link screen's skeletons end with a way out when the session read never answers (test only) | Open, green |
| #277 | #242, #265 | Plain words for account roles; a loan gets a checkbox, not a picker | Open, green after new Linux baselines |
| #278 | #268 | Spending tiles account for Left over; one set of words; opaque popover | Open, green after a locator fix and new baselines |
| #291 | #267 | Delete account a step behind an Account item | Open, green; merge before #258 |
| #292 | #257 | Count decisions that need review in the saved chip | Open, green after restoring tabular numerals |
| #293 | #197 | The API keeps its own Render instance warm; staggered cron | Open, green; merge before #264 |
| #294 | #263 | Show the stub the plan uses on the Confirm step | Open, green; merge before #264 and #270 |
| #295 | #269 | "Ahead of plan" for extra saving; essentials target dropped | Open, green after new baselines; merge before #260 |
| #296 | (docs) | Test counts, coverage and the eval scorecard | Open, green |
| #297 | #287 | Mockup B's README records the Spending card's divergence from the product | Open |
| #298 | #280 | `make eval` says what is missing when a free suite cannot run | Open |
| #299 | #285 | The funded share rounds down, so 99.6% is not "100% of the target" | Open |
| #300 | #289 | A non-2xx answer with no API body is an error, not empty data | Open |
| branch | #258 | Cold start shows a waking-up message | Awaiting rebase on #267 |
| branch | #261 | The logo routes a returning user to the plan | Awaiting rebase on #257 |
| branch | #259 | Leaving a decision page asks about unsaved edits | Awaiting rebase on #257 and #261 |
| branch | #260 | A saved decision refreshes the open check-in | Awaiting rebase on #269 |
| branch | #264 | Remove failed or replaced documents (migration 0027) | Awaiting rebase on #197 and #263 |
| branch | #266 | An explanation is written on save (migration 0028 after #264) | Awaiting rebase on #260 and #264 |
| branch | #270 | Decision numbers in plain words, no false precision | Awaiting rebase on #257, #259, #263 and #264 |
| none | #240, #243 | Already fixed on `main` by PRs 246 to 249 | Close with a comment |
| issues | #279, #281 to #284, #286, #288, #290 | Follow-ups filed from the hardening work that wait on a merge or on hkwan16's PR #251 | Open, unassigned |
