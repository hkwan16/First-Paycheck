# First Paycheck: Alpha Release and Task Backlog

Due Thursday, November 5, 2026. This document follows the three sections of the [alpha brief](../alpha-brief.md).

## Early working demo

### What the alpha does

First Paycheck walks someone through the money decisions of their first salaried month, using their own pay stub and bank data. In the alpha a person signs in, links a bank, uploads a pay stub, checks what was read from it, and decides how much to put into their 401(k), with the numbers worked out by tested code and an explanation that is checked against those numbers before it is shown.

The path through the alpha:

1. **Sign in** with email and password, a magic link, or a new account (Supabase Auth).
2. **Link a bank.** Plaid's sandbox bank (First Platypus Bank, `user_good` / `pass_good`) is linked through Plaid Link; a background job syncs its accounts and transactions, and the screen follows the job until it finishes.
3. **See categorized transactions.** Each row has a category and a badge for who chose it: a rule, the AI with its confidence, or you. Changing a category saves a rule for that merchant, and the screen says so.
4. **Upload a pay stub.** Before any AI sees a page, Social Security and account numbers are blacked out; the document row shows how many items were redacted. The worker then reads the redacted pages.
5. **Confirm the pay stub.** Every extracted field is a proposal next to the redacted line it came from. The person confirms or edits each one, and the screen checks that gross pay minus deductions equals net pay; the API checks again when the values are saved.
6. **Spending.** The transactions, with the summary tiles (income, essentials, flexible, savings) above them.
7. **401(k) decision.** The person enters salary and the employer match once, then moves the contribution slider; the API's calculator returns the match captured or left on the table. Saving stores an immutable version ("Saved as v1"); a change saves v2, which supersedes v1.
8. **Why.** A plain-language explanation of the saved decision. Every number in it is checked against the calculator's result and it cites a curated IRS passage; if the check fails twice, the screen shows the calculator's own result instead.

Production: web on Vercel (URL: TODO), API and worker on Render at `https://first-paycheck-api.onrender.com`. Recording (90 seconds): TODO (`screenshots/alpha-demo.mp4` or a link).

### Functional and placeholder features

"Planned" is the alpha scope from the [build plan](../plan.md). "Actual" is what `main` does today, read from the code and run end to end against a local stack (`make e2e-full`, which uses the fake model and the Plaid sandbox). Production has no `ANTHROPIC_API_KEY` yet, which changes three rows there; those rows say how.

| Feature | Planned for the alpha | Actual |
|---|---|---|
| Sign in (password, magic link, sign-up) | Functional | Functional. Signed-out visits to any app screen go to sign-in and come back afterwards. |
| Link a Plaid sandbox bank and see synced transactions | Functional | Functional, through Plaid Link. When Plaid has not prepared a new item yet, the sync waits 120 s and tries again, and the screen shows the queued job meanwhile. |
| Transactions categorized by rules then AI, with the source shown | Functional | Functional with a model configured. Production today: the categorize job needs the model even for the rule step, so it fails and rows show "Not labeled" until the key is set. |
| Fix a category, which saves a rule | Functional | Functional ("Saved as a rule."). |
| Upload a pay stub (PDF or image) with redaction before extraction | Functional | Functional with a model configured: text PDFs are redacted as text, scans with OCR and black boxes. Production today: the extract job fails without the model, so the stub never reaches review. |
| Review and confirm extracted fields, with the gross minus deductions equals net check | Functional | Functional, including manual entry when the model declines a document. |
| Spending summary tiles and transaction table | Functional | The table is functional. The tiles show loading placeholders: the API's `GET /spending/summary` exists, and the web is being wired to it in parallel with this document. |
| Spending cash-flow diagram (Sankey) | Not in the alpha (M5) | Not built in the web yet (in progress for M5); the API's `GET /cashflow` exists. |
| 401(k) match calculator | Functional | Functional. Every figure comes from `POST /calc/401k-match`; the client only formats. |
| Save a decision, then save a new version that supersedes it | Functional | Functional ("Saved as v1", then "Saved as v2"). The Why index lists each current decision with its version. |
| "Why" explanation verified against the calculator, with an IRS citation | Functional | Functional with a model configured: "Verified against calculator", an irs.gov source, and next steps from the calendar. Production today: a calm "not available yet" notice with the calculator result. |
| Emergency fund, health plan and W-4 cards | Placeholder ("After alpha") | Placeholder ("After alpha"), with the alpha's `calculators=401k_match` flag. |
| CSV import | Not in the alpha (M5) | The API route `POST /accounts/import` exists; the Link screen's button is disabled ("After alpha") while the web part is built. |
| Plan export and decision calendar | Not in the alpha (M9) | The Plan screen is a placeholder. A saved 401(k) decision already creates its calendar check, which the Why screen shows. |
| Monthly check-in | Not in the alpha (M8) | Placeholder screen. The tables exist (migration `0005_checkins`). |

Behind the screens: per-user rate limits on uploads (10 per hour) and explanation runs (30 per hour), JSON request and job logs with request and user ids, Sentry error reporting on the API and the worker when its DSN is set, and a `/health` that reports the deployed commit, the migration and whether the worker is alive.

### Screenshots

Screenshots live in [`screenshots/`](screenshots/) and are taken from production with a fresh account, at 1280 px wide and, where marked, 390 px for phone. Each file below is a placeholder until it is captured.

| File | Shows |
|---|---|
| `01-sign-in.png` | The sign-in screen |
| `02-link-syncing.png` | Linking First Platypus Bank, with the sync job's progress bar |
| `03-link-linked.png` | The linked accounts with their roles, and the pay stub row with its "N items redacted" badge |
| `04-spending-transactions.png` | Transactions with Rule, AI and You badges |
| `05-spending-rule-notice.png` | A category fix and its "Saved as a rule." notice |
| `06-confirm-review.png` | The Confirm screen: fields beside the redacted source, "The math checks out." |
| `07-spending-tiles.png` | The Spending summary tiles |
| `08-decisions-v1.png` | The 401(k) card at 4%, "Saved as v1", with the other three cards marked "After alpha" |
| `09-decisions-v2.png` | The card after a change, "Saved as v2" |
| `10-why-verified.png` | The explanation, "Verified against calculator", with its IRS source |
| `11-confirm-phone.png` | The Confirm screen at 390 px |
| `12-decisions-phone.png` | The Decisions screen at 390 px |
| `backlog.png` | The GitHub Project board |

## Documented backlog

The backlog is a GitHub Project. Every issue has a title, description, status, priority and assignee; the source of truth for issue text is [`docs/backlog.yaml`](../backlog.yaml), synced to GitHub by `scripts/sync_backlog.py`.

- Project board: https://github.com/users/hkwan16/projects/1 (issues: https://github.com/hkwan16/First-Paycheck/issues)
- Board screenshot: `screenshots/backlog.png` (to capture)

The 104 issues are grouped into milestones M0 to M10 in dependency order, and each milestone leaves a deployed product: the foundation and data model first (M0, M1), then documents (M2) and the 401(k) decision (M3), which only needed M1 and so could proceed side by side, then this hardening milestone (M4). Some M5 work is already in: the API for recurring charges, cash flow and CSV import, with the Sankey and the import screen in progress. After the alpha come the emergency fund, health plan and benefits extraction (M6), the W-4 (M7), monthly check-ins (M8), the plan export (M9), and a hardening pass with a user test (M10).

## Brief reflection on AI tool integration

Drawn from [`docs/ai-log.md`](../ai-log.md), which records each notable use of an AI tool with what went wrong and how it was caught.

### Tools used

Claude Code throughout. A main session planned the work and wrote the specs, then split each milestone into work packages handed to Opus 5.5 subagents, each in its own git worktree with explicit file ownership, and merged their branches. One of the two mockups was built by a subagent with the `apple-design` skill.

### How the tools changed the work

The plan was the main lever. Asking for a build plan grounded in the proposal and the technical spec produced seventeen spec amendments before any code, such as integer cents in every money column, a non-production route for linking Plaid's sandbox, and a committed OpenAPI file that the web's types are generated from. Parallel subagents then built the API and the web side by side against that contract, each owning its own files.

The project's rules for the AI are part of the repo (`CLAUDE.md` files): money math only in `api/calc/`, only one module may call Claude, a failing test before every fix, and no output of the model saved without the person confirming it. Those rules are checked by tests and lint, not trusted to the prompt.

### Successes, challenges and surprises

- **Checking the real system beat reading the code.** Asked whether row-level security was set up, the session queried the hosted database and probed Supabase's Data API instead of reading the migrations. It found that Supabase's default grants had left the migration table and a `SECURITY DEFINER` function open to the public key, which a local Postgres could never have shown. The fix included making the test database copy those defaults so the leak reproduced locally first.
- **Running end to end found what unit tests missed.** The local real-API harness built for M4 turned up a confirm screen that never moved on to Spending, a hydration mismatch on the Link screen, and a spacing bug that hid a status message from the tests. Each passed its unit tests, because the bug needed real timing or a real API to appear.
- **Humans still caught visual and mathematical errors.** A clipped Sankey column in the chosen mockup was caught by a person looking at the render, not by the AI that drew it. A property in the plan ("no missed match above the full-match percentage") was false when the yearly 402(g) limit binds, and it surfaced only while hand-working the spec's examples.
- **Defaults are where privacy leaks hide.** Sentry's SDK sends a stack frame's local variables by default; a test that turned them back on showed a request body reaching Sentry through a local even though the body itself was scrubbed.
- **Open problem.** Without a model key, the worker fails the categorize and extract jobs outright rather than falling back to rules and manual entry. Production needs the key, or that fallback, before the walkthrough.
