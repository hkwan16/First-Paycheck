# First Paycheck Financial Setup: Technical Spec

First Paycheck is a web app that guides a new salaried employee through their first-month money decisions, then checks in every month to see whether those decisions stuck and what changed. It works from the user's own pay stub, benefits documents and linked bank accounts. All financial math runs in deterministic, tested code. The LLM only extracts, categorizes and explains.

## 1. Architecture

A Next.js client, a FastAPI backend with a separate worker, and Supabase (database, login, file storage). Bank data arrives through a sync provider (Plaid) or a CSV import, both feeding one pipeline. Only the LLM gateway calls Claude; the calculation engine does all money math with no LLM.

**Only the LLM gateway talks to Claude; all money math stays in tested code.** Blue boxes are the only parts that touch an LLM; circled numbers are the data-flow steps below. Every other component is plain, tested code.

```mermaid
flowchart TB
  Web["<b>Web client · Next.js</b><br/>Link accounts, upload documents, confirm fields,<br/>fix categories, review decisions, monthly check-in"]

  subgraph Backend["Backend · FastAPI + worker"]
    direction LR
    subgraph In["Data in · no LLM"]
      Sync["<b>Sync</b> ①<br/>Plaid or CSV, one provider interface<br/>Accounts, transactions, balances, holdings"]
      Ingest["<b>Document ingestion</b> ②<br/>Parses PDFs, OCRs images<br/>Redacts SSNs and account numbers"]
    end
    subgraph AI["Understand · the only LLM calls"]
      Gateway["<b>LLM gateway</b> ③ ④ ⑧<br/>Extract, categorize unknown merchants, explain<br/>Pydantic schema checks"]
      Retrieval["<b>Retrieval</b> ⑧<br/>Curated IRS citations per calculator<br/>Full-text search over benefits text"]
      Verify["<b>Verifier</b> ⑨<br/>Every number matches a calculator output<br/>Every citation exists"]
    end
    subgraph Decide["Decide · no LLM"]
      Detect["<b>Recurring detector</b> ⑤<br/>Cadence and amount patterns"]
      Calc["<b>Calculation engine</b> ⑥<br/>Tax, 401(k), health plan, emergency fund,<br/>W-4, cash flow, net worth"]
      CheckIn["<b>Check-in engine</b> ⑦<br/>Diffs new data against the plan,<br/>emits typed findings"]
      Export["<b>Export</b> ⑩<br/>One-page PDF plan, decision calendar"]
    end
  end

  subgraph Ext["External services"]
    direction LR
    Plaid["<b>Plaid</b><br/>Transactions, Balances, Investments<br/>Webhooks on new data"]
    Claude["<b>Claude API</b><br/>Sonnet 5.5, Haiku 5.5<br/>Redacted content only"]
  end

  subgraph Supabase["Supabase · row-level security on every table"]
    direction LR
    PG["<b>PostgreSQL</b><br/>Accounts, transactions, balances, holdings,<br/>profile, decisions, goals, check-ins, jobs"]
    Auth["<b>Auth</b><br/>Login, issues JWT"]
    Storage["<b>Storage</b><br/>Uploads, deleted after confirmation"]
  end

  In ~~~ AI ~~~ Decide
  Web <-->|"HTTPS + JSON, user JWT"| Backend
  Backend <-->|"SQL as the user, files"| Supabase
  Backend <-->|"Plaid API + webhooks · Claude API"| Ext

  classDef llm fill:#e3ecfa,stroke:#2563c9,stroke-width:2px,color:#111
  class Gateway,Claude llm
  class AI llm
```

**The LLM never feeds money math directly.** Everything the LLM extracts or labels is a proposal until the user confirms it. The calculators read only confirmed data. Setup and the monthly check-in are two views over the same pipeline.

```mermaid
flowchart LR
  S["① Sync<br/>Plaid or CSV"] --> X["③ Extract<br/>④ Categorize"]
  U["② Upload<br/>redact"] --> X
  X --> C{"User confirms<br/>fields and labels"}
  C --> P[("Confirmed profile,<br/>accounts, transactions")]
  P --> R["⑤ Detect<br/>recurring charges"]
  P --> K["⑥ Calculate<br/>what-ifs"]
  K --> D[("Decision<br/>user picks")]
  R --> CI["⑦ Check-in<br/>findings"]
  D --> CI
  S -.->|"new data each month"| CI
  D --> E["⑧ Explain<br/>+ retrieval"]
  CI --> E
  E --> V{"⑨ Verify"}
  V -->|pass| Shown["Shown to user"]
  V -->|"fail after retry"| F["Plain calculator<br/>result"]
  D --> O["⑩ Export PDF<br/>+ calendar"]

  classDef llm fill:#e3ecfa,stroke:#2563c9,stroke-width:2px,color:#111
  class X,E llm
```

Data flow (numbers match the diagrams):

1. **Sync (no LLM):** The user links a bank through Plaid Link, or uploads a CSV for an account they won't link. Both go through the same provider interface and land in the same tables: `accounts`, `transactions`, `balance_snapshots`, `holdings`. Plaid webhooks trigger incremental syncs; a CSV import is a one-shot sync. Provider access tokens are encrypted at rest and never leave the backend.
2. **Upload (no LLM):** The user uploads a pay stub or offer letter and a benefits summary. Ingestion reads each file (pdfplumber for text-layer PDFs, OCR for images and scanned PDFs) and redacts SSNs and account numbers before anything is sent to an LLM. In images, the redaction blacks out the matching regions.
3. **Extract (LLM):** Claude returns typed JSON fields, Pydantic checks them, and the user confirms each one. Confirmed pay stub fields are stored as a `pay_stubs` row; confirmed plan options as `benefits_plans` rows. The benefits summary text is chunked and indexed for retrieval, and the raw upload files are deleted.
4. **Categorize (LLM, unknown merchants only):** A background job first applies the user's own corrections and a rules table of known merchants. Only merchants that match neither go to Claude, in batches, with a confidence score. The user can fix any label; each fix becomes a rule, so the same merchant never goes back to the LLM.
5. **Detect recurring charges (no LLM):** A job finds merchants that repeat on a weekly, monthly or yearly cadence at a stable amount and records them in `recurring_charges`. New, changed and stopped charges are flagged for the next check-in.
6. **Calculate (no LLM):** The stateless calculators run on confirmed data, so the user can try what-ifs freely. The result the user chooses is saved as a `decisions` row. The emergency fund decision also creates a `goals` row linked to the savings account.
7. **Check-in (no LLM):** Monthly, or whenever a sync lands new data, the check-in engine diffs the new data against the plan and emits typed findings: a 401(k) election that doesn't match the latest pay stub, a goal that is off pace, a new recurring charge, a pay or deduction change, an upcoming calendar date. Each finding names the decision it affects, so the user can re-run that calculator with current numbers.
8. **Explain (LLM + retrieval):** Claude explains each decision or finding from the calculator's numbers, the curated IRS citations for that calculator, and full-text search results from the user's benefits text.
9. **Verify (no LLM):** Plain code checks that every number in the explanation matches a calculator output and every citation exists. A failed check gets one retry, then the user sees the plain calculator result, flagged as a fallback.
10. **Export (no LLM):** Decisions become a one-page PDF plan, along with the user's decision calendar of dated checkpoints.

## 2. Data Model

PostgreSQL with row-level security on every table; every row carries `user_id`. Money is stored as integer cents. Timestamps are UTC. Nothing the LLM produced is written to a confirmed table until the user accepts it.

| Table | Purpose | Key columns |
|---|---|---|
| `profiles` | The confirmed picture of the user's job and choices | salary, pay_frequency, filing_status, other_jobs, dependents, expected_healthcare_usage, start_date |
| `documents` | One row per upload, kept after the file is deleted | type (pay_stub, offer_letter, benefits), status, redaction_count, deleted_at |
| `pay_stubs` | Confirmed fields from each pay stub, one per upload | document_id, pay_date, period_start, period_end, gross, federal_withholding, social_security, medicare, state_tax, retirement_contribution, medical_premium, net |
| `benefits_plans` | Confirmed plan options from the benefits summary | name, kind (hdhp, ppo, hmo), premium_per_period, deductible, oop_max, coinsurance, employer_hsa, enrollment_deadline |
| `benefits_chunks` | Chunked benefits text with a `tsvector` for retrieval | document_id, chunk_index, text, search |
| `sync_items` | One per linked institution | provider (plaid, csv), provider_item_id, access_token (encrypted), cursor, status, last_synced_at |
| `accounts` | Every bank, card, investment or retirement account | sync_item_id, provider_account_id, kind (checking, savings, credit, investment, retirement), name, mask, role (spending, emergency_fund, retirement), is_active |
| `transactions` | Every transaction, from any provider | account_id, provider_txn_id, posted_at, amount, merchant_raw, merchant_clean, category, category_source (rule, user, llm), confidence, pending |
| `category_rules` | Merchant to category mappings, seeded and learned from user fixes | merchant_pattern, category, source (seed, user) |
| `balance_snapshots` | Balance per account per sync | account_id, as_of, balance |
| `holdings` | Investment positions from Plaid Investments | account_id, as_of, security_id, name, ticker, quantity, value, cost_basis |
| `recurring_charges` | Detected subscriptions and bills | merchant_clean, cadence, typical_amount, first_seen, last_seen, status (active, new, changed, stopped), user_status (confirmed, ignored, cancelled) |
| `goals` | Savings targets tracked against account balances | kind (emergency_fund, custom), target_amount, monthly_contribution, account_id, decision_id, target_date |
| `decisions` | Every chosen calculator result, versioned | calculator, inputs, result, version, supersedes_id, check_in_id, created_at |
| `explanations` | Each explanation attempt | decision_id or finding_id, text, citations, prompt_version, verified, fallback |
| `check_ins` | One per monthly review or data-triggered review | period, triggered_by (schedule, sync, manual), status, completed_at |
| `check_in_findings` | Typed findings for one check-in | check_in_id, kind, severity, decision_id, payload, user_action (acknowledged, acted, dismissed) |
| `calendar_events` | Dated checkpoints derived from decisions and plans | kind, due_at, decision_id, status |
| `jobs` | Background work queue | kind, status, progress, payload, result, attempts, run_after |
| `irs_citations` | Curated passages per calculator, versioned by tax year | calculator, key, title, url, passage, tax_year |

Rules that keep the model honest:

- `decisions` are never updated in place. A new choice inserts a new version with `supersedes_id`, so a check-in can show what changed and why.
- `pay_stubs` keep one row per upload, so the check-in can compare the latest stub against the one the plan was built on.
- `category_rules` grow from user corrections. Categorization accuracy improves per user without any LLM fine-tuning, and the LLM share of categorization falls over time.
- `sync_items.access_token` is encrypted with a key held only by the backend. Webhook payloads are verified against Plaid's signature before any job is queued.
- Raw uploads are deleted after confirmation; transactions, balances and holdings are kept as long as the account is linked, and deleted when the user unlinks it.

## 3. API Design

REST and JSON (multipart for uploads). The client logs in with Supabase Auth and sends the resulting JWT on every route. The backend runs each database query as that user by forwarding the JWT claims to Postgres, so row-level security on every table limits each user to their own data. An automated test tries to read another user's rows through every route. The one route without a user JWT is the Plaid webhook, which is verified by signature instead.

**Documents and profile**

| Endpoint | Purpose: input → output | LLM |
|---|---|---|
| `POST /docs` | Upload: PDF or image (PNG, JPEG) + type (pay stub, offer letter, benefits) → document_id | No |
| `POST /docs/{id}/extract` | document_id → proposed fields, confidence, per-line notes | Sonnet 5.5 |
| `POST /docs/{id}/confirm` | Confirmed fields → pay_stubs or benefits_plans rows; indexes benefits text; deletes the file | No |
| `GET /profile`, `PUT /profile` | Confirmed salary, filing status, expected healthcare usage, goals → saved profile | No |

**Accounts and sync**

| Endpoint | Purpose: input → output | LLM |
|---|---|---|
| `POST /sync/link-token` | → Plaid Link token for the client | No |
| `POST /sync/items` | Plaid public token → sync_item; queues the initial sync job | No |
| `DELETE /sync/items/{id}` | Unlinks the institution and deletes its accounts, transactions, balances and holdings | No |
| `POST /sync/webhook` | Plaid webhook (signature-verified) → queues an incremental sync | No |
| `POST /accounts/import` | CSV + account kind → job_id; same pipeline as a Plaid sync | No |
| `GET /accounts` | → accounts with latest balance and role | No |
| `PATCH /accounts/{id}` | role or is_active → updated account | No |
| `GET /jobs/{id}` | job_id → status, progress, result when done | No |

**Transactions and spending**

| Endpoint | Purpose: input → output | LLM |
|---|---|---|
| `GET /transactions` | Filters (account, date range, category, min confidence) → page of transactions | No |
| `PATCH /transactions/{id}` | New category → updated transaction; writes a category rule | No |
| `GET /spending/summary` | Date range → totals by category, monthly essentials, flexible, savings rate | No |
| `GET /cashflow` | Month → income, essentials, flexible, savings, left over, with the plan's targets beside each | No |
| `GET /recurring` | → recurring charges with status | No |
| `PATCH /recurring/{id}` | user_status (confirmed, ignored, cancelled) → updated charge | No |
| `GET /net-worth` | → balance time series per account kind and total | No |
| `GET /holdings` | → latest positions per investment and retirement account | No |

Categorization runs as a background job queued by every sync. Rules and user corrections are applied first; only unknown merchants go to Haiku 5.5.

**Calculators and decisions**

| Endpoint | Purpose: input → output | LLM |
|---|---|---|
| `POST /calc/emergency-fund` | Essentials, current savings, monthly contribution → 3–6 month target, months to goal | No |
| `POST /calc/401k-match` | Salary, match formula, contribution % → % for full match, $ gained or missed, per-paycheck cost | No |
| `POST /calc/health-plans` | Plans, expected usage → cost per plan, break-even | No |
| `POST /calc/w4` | Filing status, pay, other jobs, dependents → W-4 values, projected federal refund or due | No |
| `POST /decisions` | Calculator name, inputs, chosen result, supersedes_id → decision_id; creates a goal or calendar event when the decision implies one | No |
| `GET /decisions` | → current decision per calculator with version history | No |
| `GET /goals`, `PATCH /goals/{id}` | → goals with progress from balance snapshots; edit contribution or linked account | No |
| `POST /explain` | decision_id or finding_id → concept, numbers, what-ifs, citations, verified flag | Sonnet 5.5 + RAG |

**Check-ins, calendar and plan**

| Endpoint | Purpose: input → output | LLM |
|---|---|---|
| `GET /check-ins` | → list of check-ins with finding counts | No |
| `GET /check-ins/{id}` | → findings, each with the decision it affects and the current calculator result | No |
| `POST /check-ins` | → runs a check-in now against the latest data | No |
| `PATCH /check-ins/{id}/findings/{fid}` | user_action → updated finding | No |
| `GET /calendar` | → upcoming checkpoints from decisions and plans | No |
| `GET /plan`, `GET /plan/export` | → saved decisions with reasoning and decision calendar; one-page PDF plan | No |

**Calculators:** The `/calc/*` endpoints are stateless and save nothing. `POST /decisions` saves the result the user picks, which keeps what-if exploration cheap and saving an explicit choice.

**LLM calls:** Prompts are versioned in the repo, every output is checked against a Pydantic schema, and each call gets only the redacted content it needs. Failures fall back to the calculator result or manual entry.

**OCR and redaction:** OCR finds where each word sits in an image or scanned PDF. Any word matching an SSN or account number pattern is blacked out in the image itself. Sonnet 5.5's vision input then receives the redacted image, which keeps the layout cues extraction needs. If OCR confidence on a page is too low to redact safely, that page is not sent, and the user enters its fields manually. Text-layer PDFs are redacted as text. Transactions sent for categorization carry only merchant, amount and date, never account identifiers.

**Background jobs:** Syncs, categorization, recurring detection and check-ins run as jobs stored in a Postgres jobs table and processed by a separate worker, so long work survives request timeouts and server restarts. A scheduler row queues the monthly check-in for every active user.

**Citations:** Each calculator has a curated, versioned table of the IRS passages it relies on, such as the 401(k) deferral limit or the Pub 15-T steps. These are deterministic and tested. Full-text search is used only for the user's own benefits text.

**Tax scope:** Federal only. The W-4 calculator uses versioned IRS Pub 15-T withholding tables plus the yearly federal brackets and standard deduction to project the refund or balance due. The paycheck decoder labels state tax lines but does not compute them.

**Current savings:** Read from the balance of the account the user marks as their emergency fund. For a CSV-only user it is pre-filled from the running balance column when one exists, and otherwise asked directly.

**Plaid environment:** The class project runs against the Plaid sandbox with its test institutions. Production access, which needs Plaid's approval, is a stretch item; nothing in the pipeline changes when it is granted.

**Stretch:**

- Plaid production access for real institutions.
- Savings priority ladder adds `POST /calc/savings-ladder` (Roth IRA vs. 401(k) with what-if toggles).
- Employer organization layer for the financial-wellness benefit.

## 4. Technical Stack

- **Frontend:** TypeScript, Next.js (React), Tailwind CSS, Recharts, Plaid Link.
- **Backend:** Python 3.12, FastAPI, Pydantic v2, versioned IRS Pub 15-T tables and yearly federal brackets and standard deduction.
- **Bank data:** plaid-python (Transactions, Balances, Investments, webhooks), CSV importer behind the same provider interface.
- **Parsing, LLM, retrieval:** pdfplumber, pandas, Tesseract OCR (pytesseract); Anthropic SDK (Sonnet 5.5, Haiku 5.5; Sonnet 5.5 vision for redacted images); curated IRS citation tables; Postgres full-text search over chunked benefits text.
- **Data, auth, storage:** Supabase (PostgreSQL with row-level security, Auth, Storage), SQLAlchemy + Alembic, Postgres-backed job queue with a separate worker and scheduler, application-level encryption for provider tokens. PDF export: WeasyPrint.
- **Testing:** pytest, Hypothesis, Vitest, Playwright, custom eval runner, Plaid sandbox fixtures.
- **CI/CD, hosting:** GitHub Actions (lint, tests, evals; merges blocked on regressions), Vercel, Render (API and worker).

## 5. Business Context Summary

**Problem.** In their first month, a new employee must fill out a W-4, pick a health plan, set a 401(k) contribution and work out what they can safely spend, usually with no training. Budgeting apps ignore benefits and taxes, advisors cost too much on a first salary, and articles don't use the reader's own numbers. After setup, nothing checks whether the decisions actually took effect.

**Target users.** Early-career employees in their first 30 days at a first salaried job with benefits, who then check in monthly and return at open enrollment, tax season and raises. The monthly check-in and the decision calendar drive those return visits.

**Business model:** free for individuals, or sold to employers as a financial-wellness benefit for new hires. Employer sales are out of scope for the class project; per-user data isolation keeps a later organization layer possible.

| Success metric | Target | How we measure |
|---|---|---|
| Extraction accuracy | ≥ 95% of fields | 30 labeled synthetic stubs, offers, benefit summaries (CI) |
| Transaction categorization accuracy | ≥ 90% | 500 labeled transactions (CI) |
| Recurring charge detection | ≥ 90% precision and recall | Seeded Plaid sandbox accounts with known subscriptions (CI) |
| Calculator correctness | 100% | Tests vs. hand-worked IRS and plan examples |
| Check-in findings correctness | 100% | Tests vs. seeded scenarios (election not applied, goal off pace, new charge) |
| Displayed explanations that cite a source | 100% | Automated check on eval outputs |
| Explanation fallback rate | ≤ 5% | Share of eval decisions that fall back to the plain calculator result |
| Setup finished in 2 sittings or fewer | ≥ 80% of users | User test with 5–8 people |
| Understanding gain | +2 points avg. | 5-question quiz, before vs. after setup |

## 6. Agent Readiness

We use Claude Code and Cursor to write, test and review code, so the repo gives agents the same context a teammate would get.

- **Context files:** a root CLAUDE.md (mirrored in .cursor/rules) states the product, the user, the rule that money math lives only in `api/calc/` with no LLM, the repo map and the run, test and lint commands; `web/`, `api/` and `evals/` each add a short CLAUDE.md.
- **Specs before code:** each feature starts as a short spec in `docs/specs/` with inputs, outputs and hand-worked examples; agents build code and tests from it, and the spec changes first when requirements do.
- **UI prototyping:** AI-generated clickable mockups of the setup flow and check-in are reviewed before the frontend is built.
- **Fast, safe feedback:** `make setup`, `make test` and `make eval` run locally in under a minute; synthetic fixtures, Plaid sandbox credentials and a `.env.example` mean agents never see real data or keys; TypeScript types are generated from the Pydantic schemas so client and server can't drift.
- **Guardrails and log:** pre-commit (ruff, mypy, eslint), CI that blocks merges on test or eval regressions, and AI review on every PR plus a human approval; `docs/ai-log.md` records key prompts, failures and fixes for our reflections.
