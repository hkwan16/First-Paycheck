# First Paycheck: Alpha Release and Task Backlog

Due Thursday, November 5, 2026. This document follows the three sections of the [alpha brief](../alpha-brief.md); the last section points each of the brief's requirements at the place it is met.

## Early working demo

### What the alpha does

First Paycheck walks someone through the money decisions of their first salaried month, using their own pay stub, benefits documents and bank data, and then checks in each month to see whether those decisions took effect. Every number is worked out by tested code in `api/calc/`; the model only reads documents, labels transactions and explains, and whatever it produces is a proposal until the person confirms it.

The alpha was scoped as milestones M0 to M4 (sign in, link a bank, confirm a pay stub, the 401(k) decision and its explanation). The rest of the MVP, planned for November 6 to December 11, was built ahead of schedule, so `main` today runs every milestone through M10. The path through it:

1. **Sign in** with email and password, a magic link, or a new account (Supabase Auth). Signed-out visits to any app screen go to sign-in and come back afterwards.
2. **Link a bank.** Plaid's sandbox bank (First Platypus Bank, `user_good` / `pass_good`) through Plaid Link, or a CSV export from any bank. A background job syncs accounts and transactions while the screen shows its progress. Each account gets a role (spending, emergency fund, retirement, and so on); an institution can be synced again or unlinked.
3. **Upload a pay stub** (PDF or image), and optionally a benefits summary. Social Security and account numbers are blacked out before any model sees a page; the document row says how many items were redacted.
4. **Confirm the pay stub.** Each extracted field sits next to the redacted line it came from. The person confirms or edits every one, and the screen checks that gross pay minus deductions equals net pay; the API checks again when the values are saved. A benefits summary is reviewed the same way (plans, match tiers, vesting).
5. **Spending.** Transactions with their category and who chose it (a rule, the AI with its confidence, or you); fixing a category saves a rule. Summary tiles, a cash-flow diagram from gross pay to categories, a month picker and the recurring charges, each of which can be renamed or marked not recurring.
6. **Decisions.** Four calculators: emergency fund (with a savings goal that can be paused, resumed or marked reached), 401(k) match, health plan comparison and W-4 withholding (which reads the saved 401(k) and health plan decisions). Saving stores an immutable version ("Saved as v1"); a change saves v2 over it.
7. **Why.** A plain-language explanation of a saved decision. Every number in it is checked against the calculator's result and it cites a curated IRS passage; if the check fails twice, the screen shows the calculator's own result instead.
8. **Plan.** Every saved decision with its figures and explanation status, the paycheck, goals and the next 90 days of dates, a PDF made by the worker and a calendar file (.ics).
9. **Monthly check-in.** What changed since the plan was saved (an election that did not reach the pay stub, a goal behind pace, a new or repriced charge, a pay or deduction change, a date coming up), each marked done or dismissed, or undone. The month's cash flow against the plan, each line said as on plan, over or under. Net worth by month and investment holdings. "Check in now" runs this month's check-in without waiting for the monthly tick.

Production: the web app is at `https://first-paycheck-silk.vercel.app` (Vercel); the API and worker run on Render at `https://first-paycheck-api.onrender.com`, and its `/health` reports the deployed commit of `main` (`aa266f0` when the screenshots were taken), migration `0014_delete_account_fn`, a live worker and whether Plaid is configured. The walkthrough below ran on that deployment on October 22 as the synthetic test user: the Plaid sandbox bank linked through the API's sandbox route (14 accounts, 48 transactions, 13 holdings synced by the worker), the Acme pay stub uploaded, typed in and confirmed, the four decisions saved, the plan exported as a PDF by the worker, and this month's check-in run with "Check in now". The same run is `web/playwright.capture.config.ts`: the product's own real-API specs (`decisions`, `plan`, `check-in`) between two capture specs, against the deployed web app and API. Recording (90 seconds): TODO (`screenshots/alpha-demo.mp4` or a link).

**Production and the Anthropic key.** Production had no `ANTHROPIC_API_KEY` during the walkthrough (a rejected key was set for a while, which the walkthrough found: see the AI log, "a rejected model key retried for half an hour"). Running with no model was then a supported production mode; since issue #133 it is supported only outside production (development, tests, CI, evals), and `APP_ENV=production` without the key refuses to start, because on October 29 a key saved under a misspelled name left production quietly running with no model. With no model (spec 004 rule 22, migration `0011_no_model_reason`): categorization runs the rules only and leaves the rest "Not labeled"; an uploaded document goes straight to manual entry with "Automatic reading is off right now, so type the fields from the lines shown." beside the redacted lines; "Why" shows a calm "not available yet" notice with the calculator's result; and the health plan card takes typed plans instead of a read benefits summary. Setting the key turns on AI labels, extraction and verified explanations with no other change.

### Functional and placeholder features

"Planned" is the scope from the [build plan](../plan.md). "Actual" is what `main` does, read from the code and run end to end against the local stack, which uses the fake model and, when keys are present, the Plaid sandbox.

| Feature | Planned | Actual |
|---|---|---|
| Sign in (password, magic link, sign-up), sign out | Alpha | Functional |
| Link a Plaid sandbox bank, follow the sync | Alpha | Functional. When Plaid has not prepared a new item yet, the sync waits 120 s and tries again, and the screen shows the queued job meanwhile. |
| Account roles, Sync now, unlink an institution | M1, M10 | Functional. Unlinking removes the institution's accounts, transactions and balances and retracts check-in findings about its charges. |
| CSV import | M5 | Functional: a new CSV account, re-imports without duplicates, row-by-row errors for a broken file. |
| Categorization by rules then AI, with the source shown; a fix saves a rule | Alpha | Functional with a model. Without one (production today), rules only. |
| Upload with redaction before extraction | Alpha | Functional with a model: text PDFs redacted as text, scans with OCR and black boxes. Without one, documents go to manual entry. Offer letters are kept but not read. |
| Confirm the pay stub (gross minus deductions equals net) | Alpha | Functional, including manual entry. |
| Benefits summary extraction and review | M6 | Functional with a model; the confirmed plans and match feed the calculators. |
| Spending tiles, transactions, month picker | Alpha, M5 | Functional |
| Cash-flow diagram (Sankey) | M5 | Functional behind the `sankey` feature flag, with a stacked view under 640 px and full keyboard navigation. |
| Recurring charges | M5 | Functional: detected weekly, monthly or yearly; rename, or mark not recurring and undo that. |
| 401(k) match calculator | Alpha | Functional. Every figure comes from `POST /calc/401k-match`. |
| Emergency fund, health plans, W-4 calculators | M6, M7 | Built and functional, and live in production since October 22, when the alpha's `calculators=401k_match` flag was dropped from the Vercel build (the flag still exists for an alpha-shaped build). |
| Versioned decisions (v1, then v2 over it) | Alpha | Functional, for every calculator. |
| Verified explanation with an IRS citation | Alpha | Functional with a model for the 401(k), health plan and W-4 (an emergency fund has no IRS source, so none). Without one, a calm notice and the calculator's result. |
| Plan screen, PDF export, calendar file | M9 | Functional |
| Monthly check-in: findings with done, dismiss and undo | M8 | Functional |
| Cash flow against the plan, coloured and labeled by the API's status | M8 | Functional (on plan, over, under; which side matters depends on the line). |
| Check in now | M8 | Functional: on the list, and on this month's open check-in. |
| Net worth by month and holdings | M8 | Functional |
| Delete the account | M10 | Functional: Plaid items revoked, then every row deleted. |
| Rate limits and body sizes on every write route | M10 | Functional; a 429 says when to try again. |
| Error boundaries per card | M10 | Functional: one broken card leaves the rest of the screen working. |
| Accessibility audit | M10 | Done for every sample screen at 1280 and 390 px: axe at every impact, a keyboard walk, reduced motion. |
| User test with 5 to 8 people | M10 | Kit written (`docs/user-test/`); the sessions have not run. |
| Live LLM eval baselines | M10 | Not yet: the deterministic suites run in CI; the LLM suites wait for a key. |
| Plaid production access | M10 stretch | Not started. |

Behind the screens: row-level security on every user table with a cross-user test for every route, per-user rate limits, JSON request and job logs with request and user ids, Sentry on the API and the worker when its DSN is set, nightly evals, and a `/health` that reports the deployed commit, the migration and whether the worker is alive.

### Screenshots

Screenshots are in [`screenshots/`](screenshots/), at 1280 px wide and, where marked, 390 px for phone, taken from the production web app and API on October 22 as the test user, with no model key set: the Confirm screen is the manual entry path over the redacted lines, categories come from the rules, and Why shows the calculator's result with the "not available yet" notice. Two were not captured: the sync in progress, because Plaid Link's iframe is not driven by automation (the bank was linked through the API's sandbox route, so there is no moment to capture), and the board, which needs a signed-in GitHub session.

| File | Shows |
|---|---|
| `01-sign-in.png` | The sign-in screen |
| `03-link-linked.png` | The 14 linked accounts with their roles and balances, and the pay stub rows with their "1 item redacted" badges |
| `04-spending-transactions.png` | Transactions with their Rule badges (no AI labels without a model key) |
| `05-spending-rule-notice.png` | A category fix and its "Saved as a rule." notice |
| `06-confirm-review.png` | The Confirm screen in manual entry: the fields to type beside the redacted source lines |
| `07-spending-tiles.png` | The Spending summary tiles |
| `08-spending-sankey.png` | October's cash-flow diagram, gross pay from the confirmed stubs to categories, with a node's popover open |
| `09-decisions-v1.png` | The 401(k) card with its saved version |
| `10-decisions-v2.png` | The card after a change, saved as the next version |
| `11-why-verified.png` | Why, as production shows it without a model key: the calculator's result and the "not available yet" notice |
| `12-plan.png` | The Plan screen with its decisions, goals and next 90 days |
| `13-check-in.png` | A check-in: findings, the cash flow against the plan with its statuses, net worth |
| `14-check-in-now.png` | The list of check-ins after Check in now |
| `15-confirm-phone.png` | The Confirm screen at 390 px |
| `16-decisions-phone.png` | The Decisions screen at 390 px |
| `backlog.png` | The GitHub Project board (to capture from a signed-in session) |

## Documented backlog

The backlog is a GitHub Project. Every issue has a title, a description (its body, ending with its definition of done), a status (todo, in progress, done), a priority (High, Medium, Low) and an assignee (the repo owner, since this is a solo project), plus its milestone and area labels. The source of truth is [`docs/backlog.yaml`](../backlog.yaml), synced to GitHub by `scripts/sync_backlog.py`, which also closes the done issues.

- Project board: https://github.com/users/hkwan16/projects/1 (issues: https://github.com/hkwan16/First-Paycheck/issues)
- Board screenshot: `screenshots/backlog.png` (to capture)

`backlog.yaml` holds 131 issues: 121 done, 7 in progress and 3 to do (49 High, 80 Medium, 2 Low priority), across milestones M0 to M10 in dependency order, each leaving a deployed product.

| Milestone | Scope | Done | In progress | To do |
|---|---|---|---|---|
| M0 | Scaffold, spec amendments, CI, deployed hello world | 11 | 0 | 0 |
| M1 | Data model, auth, Plaid sandbox sync, categorization, design system | 16 | 0 | 0 |
| M2 | Upload, ingest, redact, extract, confirm | 8 | 2 (extraction eval with a live model, tesseract-in-Docker as a required check) | 0 |
| M3 | 401(k) calculator, decisions, citations, explain, verify | 8 | 0 | 0 |
| M4 | Alpha hardening and this document | 6 | 3 (alpha e2e in CI, observability, this document) | 0 |
| M5 | Sankey, CSV import, spending summary, recurring charges | 14 | 0 | 0 |
| M6 | Emergency fund, goals, health plans, benefits extraction | 13 | 0 | 0 |
| M7 | W-4 | 5 | 0 | 0 |
| M8 | Check-ins, calendar, cash flow, net worth, holdings | 18 | 0 | 0 |
| M9 | Plan export | 6 | 0 | 0 |
| M10 | Hardening, evals, accessibility, user test | 9 | 2 (two eval sets at target, which need a live model) | 3 (user test, Plaid production, live LLM evals) |

Those statuses are from the sync at commit 54b76bb (October 21), after the M8 web item, the error boundaries, web account deletion and the accessibility audit were merged. The open items are the ones that need something from outside the repo: a live model for the eval sets and baselines, the Plaid secrets in GitHub Actions for the alpha spec's link steps, Sentry and a log drain in production, and people for the user test.

## Brief reflection on AI tool integration

Drawn from [`docs/ai-log.md`](../ai-log.md), which records each notable use of an AI tool with what went wrong and how it was caught.

### Tools used

Claude Code throughout. A main session planned the work and wrote the specs, then split each milestone into work packages for Opus 5.5 subagents, each in its own git worktree with a brief naming the specs to read, the files it owned, its own test database and a `&&`-gated command to pass before reporting. Sixteen subagents ran over the build day, two to four at a time, and the main session merged their branches. One of the two mockups was built by a subagent with the `apple-design` skill.

### How the tools changed the work

The plan was the main lever. A build plan grounded in the proposal and the technical spec produced seventeen spec amendments before any code: integer cents in every money column, a non-production route for linking Plaid's sandbox, and a committed OpenAPI file the web's types are generated from. Parallel subagents then built the API and the web side by side against that contract. The whole post-alpha plan (M3 to M10, scheduled for November 6 to December 11) landed in one day; over that work, test counts went from 733 to 1922 on the API and from 605 to 1332 on the web, with every merge gated on lint, both suites and the free evals. The cost was orchestration: roughly a third of the main session went to merges and conflict resolution.

The rules for the AI live in the repo (`CLAUDE.md` files): money math only in `api/calc/`, one module that may call Claude, a failing test before every fix, nothing the model produces saved without the person confirming it. Tests and lint check those rules rather than trusting the prompt.

### Successes, challenges and surprises

- **Checking the real system beat reading the code.** Asked whether row-level security was set up, the session queried the hosted database instead of reading migrations, and found Supabase's default grants had left the migration table and a `SECURITY DEFINER` function open to the public key. The guard test written for it later caught the same gap in another agent's migration.
- **Running end to end found what unit tests missed.** The local real-API harness turned up a confirm screen that never moved on to Spending (a mutation callback dropped when its component unmounted) and a hydration mismatch on the Link screen; each passed its unit tests. On the API, reproducing an unlink end to end on the November test user showed a check-in finding still pointing at a charge the unlink had deleted.
- **Definitions of done beat titles.** Syncing statuses showed several issues that looked done but were not by their own definitions: the CI end-to-end run skips the Plaid steps without secrets, the LLM eval baselines still hold targets, and the web has no production deploy.
- **Hypothesis and hand-worked examples caught wrong specs, not just wrong code.** A W-4 property claimed every suggestion lands within $100 and Hypothesis found the counterexample; a 401(k) property was false when the 402(g) limit binds, found while working the spec's examples by hand.
- **Parallel agents need a shared map.** Two agents' migrations revised the same parent three times until briefs named the current head; merges conflicted in shared files and two resolutions were wrong until `tsc` in the merge gate caught them. Agents reported API gaps instead of patching across the boundary, and three gaps (an account's provider, plan line status, check in now) became their own packages.
- **Humans still catch what renders wrong.** A clipped Sankey column in the chosen mockup was caught by a person looking at it, not by the AI that drew it.
- **Resolved since the first draft.** The worker used to fail categorize and extract jobs outright without a model key; it now falls back to rules and manual entry. Production itself now refuses to start without the key (#133), so a missing or misspelled key cannot hide behind that fallback.

## Where each alpha requirement is met

| Brief requirement | Where |
|---|---|
| Description of the current alpha version | [What the alpha does](#what-the-alpha-does) |
| Screenshots or a short video of key features | [Screenshots](#screenshots) (named placeholders to capture) and the recording TODO under [What the alpha does](#what-the-alpha-does) |
| Which features are functional and which are placeholders | [Functional and placeholder features](#functional-and-placeholder-features) |
| Backlog in a task management system | The GitHub Project, under [Documented backlog](#documented-backlog) |
| Title, description, status, priority and assignee per task | Every issue in [`backlog.yaml`](../backlog.yaml) and on the board; see [Documented backlog](#documented-backlog) |
| A link or screenshot of the backlog | The board link and `screenshots/backlog.png` |
| AI/LLM tools used | [Tools used](#tools-used) |
| How the tools influenced and accelerated development | [How the tools changed the work](#how-the-tools-changed-the-work) |
| Successes, challenges and unexpected insights | [Successes, challenges and surprises](#successes-challenges-and-surprises) |
| Clear, organized, about 1-2 pages | Headings and tables throughout; the feature table runs past two pages because the build ran past the alpha's scope |
