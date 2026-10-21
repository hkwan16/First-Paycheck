# 001: Data model

Status: Draft for M0. Tables are created by the migrations named in [Migrations](#migrations); M1 builds `0002_core` from this spec. The questions under [Open questions](#open-questions) must be settled before the migration that each one touches.

## Goal

Define every table in the amended technical spec (`docs/technical-spec.md`, section 2) precisely enough to write the Alembic migrations and the RLS tests from this document alone: columns, types, constraints, indexes, row-level security, the decision versioning rules, the transaction sign convention, and what is kept and deleted when.

## Inputs

The amended technical spec (section 2 and spec amendments 2-9, 13-15) and the build plan's backend architecture.

## Outputs

Alembic revisions `0001_roles` through `0006_webhook_fn`, the SQLAlchemy models in `api/db/models.py` and enums in `api/db/enums.py`, and the RLS test suite under `api/tests/rls/`.

## Rules

### Conventions

1. **Money** is `bigint` in a column whose name ends in `_cents`. No `numeric`, `float` or `money` column ever holds an amount. The API type is `Cents = Annotated[int, Field(strict=True)]`.
2. **Timestamps** are `timestamptz`, stored and compared in UTC; columns end in `_at`. Calendar dates with no time (pay dates, statement dates) are `date`.
3. **Percentages and rates** that are not money are `numeric` with an explicit scale (`numeric(5,2)` for percent points, `numeric(4,3)` for a 0-1 confidence).
4. **Identifiers** are `uuid` primary keys named `id` with `DEFAULT gen_random_uuid()`, except `profiles` (keyed by `user_id`) and `document_blobs` (keyed by `document_id`).
5. **Ownership.** Every user table has `user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE`. The only tables without a required `user_id` are `irs_citations` (reference data), `category_rules` seed rows and `jobs` rows of kind `schedule.tick`.
6. **Same-user references.** Every foreign key from a user table to another user table is composite, `(parent_id, user_id) REFERENCES parent(id, user_id)`, and every such parent has `UNIQUE (id, user_id)`. A row can never point at another user's parent, even through a bug that bypasses a policy check.
7. **Enums** are Postgres enum types named in [Enums](#enums). Adding a value is a migration.
8. **Audit columns.** Every table has `created_at timestamptz NOT NULL DEFAULT now()`. Mutable tables also have `updated_at timestamptz NOT NULL DEFAULT now()`, maintained by a shared `set_updated_at()` trigger. Append-only tables (`decisions`, `explanations`, `llm_calls`, `balance_snapshots`) have no `updated_at`.

### Row-level security

9. `alembic/rls.py:enable_rls(table)` runs `ENABLE ROW LEVEL SECURITY`, `FORCE ROW LEVEL SECURITY`, and creates the owner policy `FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid())`. Every table gets it unless listed under exceptions.
10. The API connects as role `app_api` and, per request, runs `SET LOCAL ROLE authenticated` and `set_config('request.jwt.claims', <claims json>, true)` inside one transaction, so `auth.uid()` resolves in every policy. `app_api` cannot bypass RLS.
11. The privileged connection (`postgres` role) is used only by `jobs/queue.py`, `jobs/scheduler.py`, Alembic and the seed loader that runs with it before deploy.
12. A row the user does not own reads as absent, so routes return 404, never 403.

**Exceptions to the owner policy** (each covered by its own RLS test):

| Table | Policy |
|---|---|
| `category_rules` | `SELECT` allows `user_id = auth.uid() OR user_id IS NULL`, so seed rows are visible to everyone. `INSERT`, `UPDATE`, `DELETE` require `user_id = auth.uid()`; seed rows are written only by the seed loader. |
| `irs_citations` | No `user_id`. `SELECT` to `authenticated` with `USING (true)`; no write policy, so only the seed loader writes. |
| `decisions` | `SELECT` owner. `INSERT` checks `user_id = auth.uid()` and, when `supersedes_id` is set, that the superseded row exists with the same `user_id`. No `UPDATE` or `DELETE` policy, and a trigger rejects both (rule 19). |
| `jobs` | `SELECT` owner (for `GET /jobs/{id}`). `INSERT` owner (routes enqueue as the user). No `UPDATE` or `DELETE` policy: dequeue, progress, heartbeat and completion run in `jobs/queue.py` on the privileged connection, the first of the two cross-user places (spec amendment 9). |
| `sync_items` | Owner policy, plus the `SECURITY DEFINER` function `enqueue_sync_for_plaid_item(provider_item_id text)`, the second cross-user place: it looks up the item across users, inserts one `sync.incremental` job for its owner, and returns nothing. It is owned by the privileged role, sets `search_path` explicitly, and is `EXECUTE`-granted only to `app_api`. |
| `document_blobs` | Owner policy. The rule that only `ingest/store.py` touches it is enforced in code by `tests/unit/test_boundaries.py`, not in SQL. |

Every job handler, after the privileged dequeue, opens a user-scoped session with `user_session_for(job.user_id)` and does all its reads and writes under RLS.

### Decision versioning

13. A user's decisions for one calculator form a single chain `v1 -> v2 -> ... -> vn`. Rows are never updated or deleted.
14. `UNIQUE (user_id, calculator, version)`: there is one row per version number, so two concurrent saves of the same next version cannot both succeed.
15. Partial unique index on `supersedes_id WHERE supersedes_id IS NOT NULL`: a version has at most one successor, so the chain cannot fork.
16. `CHECK ((version = 1) = (supersedes_id IS NULL))`: the first version supersedes nothing, and every later version supersedes something.
17. `BEFORE INSERT` trigger: when `supersedes_id` is set, the superseded row must have the same `user_id` and `calculator` and `version = NEW.version - 1`; otherwise it raises. (The composite foreign key of rule 6 already enforces the same user.)
18. The **current** decision for a calculator is the row that no other row's `supersedes_id` points to. The view `current_decisions` (created `WITH (security_invoker = true)` so RLS applies) selects exactly those rows.
19. `BEFORE UPDATE OR DELETE` trigger raises for every row. See Open question 1 for account deletion.
20. `POST /decisions` sends `supersedes_id` equal to the current row's id, or null when there is none. A save against a stale current row violates rule 14 or 15 and returns 409.

### Sign convention

21. `transactions.amount_cents > 0` is money leaving the account (purchases, bills, fees, transfers out); `< 0` is money arriving (paychecks, refunds, transfers in). This is Plaid's convention. The CSV provider converts its file to this convention before the shared pipeline upserts anything.
22. `balance_snapshots.balance_cents` is the provider's current balance as reported. For depository and investment accounts it is money held; for credit accounts it is the amount owed, positive when the user owes money (Plaid's convention). Net worth subtracts credit balances by account kind.
23. Pay stub and benefits amounts are non-negative magnitudes; whether a line adds or subtracts is carried by the column (or, in an extraction proposal, by the field's `role`).

### Retention and deletion

24. **Raw uploads.** `POST /docs/{id}/confirm` deletes the `document_blobs` row and sets `documents.deleted_at` in the same transaction that writes `pay_stubs` or `benefits_plans`. The `documents` row, its proposal and its redaction count are kept.
25. **Unlinking** (`DELETE /sync/items/{id}`) deletes the `sync_items` row; `ON DELETE CASCADE` removes its `accounts` and, through them, their `transactions`, `balance_snapshots` and `holdings`. `goals.account_id` is set to null (`ON DELETE SET NULL (account_id)`, Postgres 15 column-list syntax, so `user_id` is untouched). The encrypted access token goes with the row.
26. **Confirmed data** (`profiles`, `pay_stubs`, `benefits_plans`, `benefits_chunks`, `decisions`, `explanations`, `goals`, `calendar_events`, `check_ins`, `check_in_findings`, `recurring_charges`) is kept while the account exists.
27. **`llm_calls`** stores counts, cost, latency and status, never prompt or output text, and is kept for cost reporting.
28. **`jobs`** payloads and results never contain document bytes, extracted text, access tokens or account numbers; they carry ids. `last_error` is truncated and must not echo request bodies.
29. **Account deletion** removes every user row through `ON DELETE CASCADE` from `auth.users`, subject to Open question 1.

## Enums

| Type | Values |
|---|---|
| `pay_frequency` | `weekly`, `biweekly`, `semimonthly`, `monthly` (52, 26, 24, 12 pay periods) |
| `filing_status` | `single`, `married_filing_jointly`, `head_of_household` (the W-4 Step 1(c) groups) |
| `healthcare_usage` | `low`, `medium`, `high` |
| `document_type` | `pay_stub`, `offer_letter`, `benefits` |
| `document_status` | `uploaded`, `extracting`, `extracted`, `manual_entry_required`, `confirmed`, `failed` |
| `plan_kind` | `hdhp`, `ppo`, `hmo` |
| `sync_provider` | `plaid`, `csv` |
| `sync_status` | `active`, `login_required`, `error` |
| `account_kind` | `checking`, `savings`, `credit`, `investment`, `retirement` |
| `account_role` | `spending`, `emergency_fund`, `retirement` |
| `category_source` | `rule`, `user`, `llm` |
| `rule_match` | `exact`, `prefix` |
| `rule_source` | `seed`, `user` |
| `recurring_cadence` | `weekly`, `monthly`, `yearly` |
| `recurring_status` | `active`, `new`, `changed`, `stopped` |
| `recurring_user_status` | `confirmed`, `ignored`, `cancelled` |
| `goal_kind` | `emergency_fund`, `custom` |
| `calculator_kind` | `emergency_fund`, `k401_match`, `health_plans`, `w4` |
| `checkin_trigger` | `schedule`, `sync`, `manual` |
| `checkin_status` | `open`, `completed` |
| `finding_kind` | `election_mismatch`, `goal_off_pace`, `recurring_new`, `recurring_changed`, `recurring_stopped`, `pay_change`, `deduction_change`, `upcoming_deadline` |
| `finding_severity` | `info`, `warning`, `alert` |
| `finding_action` | `acknowledged`, `acted`, `dismissed` |
| `calendar_kind` | `enrollment_deadline`, `tax_season`, `open_enrollment`, `goal_target` |
| `calendar_status` | `upcoming`, `done`, `dismissed` |
| `job_kind` | `sync.initial`, `sync.incremental`, `categorize.run`, `ingest.extract`, `recurring.detect`, `checkin.monthly`, `schedule.tick` |
| `job_status` | `queued`, `running`, `succeeded`, `dead` |
| `llm_purpose` | `extract`, `categorize`, `explain` |
| `llm_status` | `ok`, `refusal`, `schema_error`, `api_error`, `budget_blocked` |

## Tables

Columns `id`, `user_id`, `created_at` and `updated_at` follow the conventions above and are not repeated unless they differ. "FK" means a composite same-user foreign key (rule 6) unless the target has no `user_id`.

### `profiles`

One row per user; the confirmed picture of the job and choices.

| Column | Type | Constraints |
|---|---|---|
| `user_id` | `uuid` | Primary key, references `auth.users(id) ON DELETE CASCADE` |
| `salary_cents` | `bigint` | Null until confirmed; `CHECK (salary_cents > 0)` |
| `pay_frequency` | `pay_frequency` | Null until confirmed |
| `filing_status` | `filing_status` | Null until confirmed |
| `other_jobs` | `jsonb` | `NOT NULL DEFAULT '[]'`, `CHECK (jsonb_typeof(other_jobs) = 'array')`; item shape set by the W-4 spec (M7) |
| `dependents` | `smallint` | `NOT NULL DEFAULT 0`, `CHECK (dependents >= 0)` |
| `expected_healthcare_usage` | `healthcare_usage` | Null until answered |
| `start_date` | `date` | Null until confirmed |
| `match_tiers` | `jsonb` | `NOT NULL DEFAULT '[]'`, `CHECK (jsonb_typeof(match_tiers) = 'array')`; items `{employee_pct_upto, employer_pct}`, validated by the Pydantic model in spec 006 |
| `vesting_years` | `smallint` | Null when unknown; `CHECK (vesting_years >= 0)` |

### `documents`

One row per upload, kept after the file is deleted.

| Column | Type | Constraints |
|---|---|---|
| `type` | `document_type` | `NOT NULL` |
| `status` | `document_status` | `NOT NULL DEFAULT 'uploaded'` |
| `content_type` | `text` | `NOT NULL`, `CHECK (content_type IN ('application/pdf', 'image/png', 'image/jpeg'))` |
| `size_bytes` | `integer` | `NOT NULL`, `CHECK (size_bytes > 0)`; the upper limit is enforced by `POST /docs` |
| `proposal` | `jsonb` | Null until extracted; the proposed fields (`key, label, value, confidence, note, kind, role`) and redacted source lines that `GET /docs/{id}` returns |
| `extract_job_id` | `uuid` | References `jobs(id) ON DELETE SET NULL`; null until extraction is queued |
| `redaction_count` | `integer` | `NOT NULL DEFAULT 0`, `CHECK (redaction_count >= 0)` |
| `confirmed_at` | `timestamptz` | Set on confirm; `CHECK ((status = 'confirmed') = (confirmed_at IS NOT NULL))` |
| `deleted_at` | `timestamptz` | Set when the blob is deleted |

Indexes: `(user_id, created_at DESC)`. `UNIQUE (id, user_id)`.

### `document_blobs`

Raw upload bytes until confirmation (spec amendment 3). Only `ingest/store.py` reads or writes it.

| Column | Type | Constraints |
|---|---|---|
| `document_id` | `uuid` | Primary key; FK `(document_id, user_id) -> documents ON DELETE CASCADE` |
| `user_id` | `uuid` | As convention |
| `bytes` | `bytea` | `NOT NULL` |
| `content_type` | `text` | `NOT NULL`, same check as `documents.content_type` |

### `pay_stubs`

Confirmed fields from one pay stub.

| Column | Type | Constraints |
|---|---|---|
| `document_id` | `uuid` | `NOT NULL UNIQUE`; FK `-> documents` |
| `pay_date` | `date` | `NOT NULL` |
| `tax_year` | `smallint` | `GENERATED ALWAYS AS (EXTRACT(year FROM pay_date)) STORED` (spec amendment 13) |
| `period_start`, `period_end` | `date` | `NOT NULL`, `CHECK (period_start <= period_end)` |
| `gross_cents` | `bigint` | `NOT NULL`, `CHECK (gross_cents > 0)` |
| `federal_withholding_cents`, `social_security_cents`, `medicare_cents`, `state_tax_cents`, `retirement_contribution_cents`, `medical_premium_cents`, `other_deductions_cents` | `bigint` | Each `NOT NULL DEFAULT 0`, `CHECK (>= 0)` |
| `net_cents` | `bigint` | `NOT NULL`, `CHECK (net_cents >= 0)` |

Constraint `pay_stub_balances`: `CHECK (gross_cents - federal_withholding_cents - social_security_cents - medicare_cents - state_tax_cents - retirement_contribution_cents - medical_premium_cents - other_deductions_cents = net_cents)`. This is the database backstop for the confirm gate (spec amendment 17); `other_deductions_cents` holds every confirmed deduction line without its own column, so the identity holds for real stubs. Indexes: `(user_id, pay_date DESC)`.

### `benefits_plans`

Confirmed health plan options.

| Column | Type | Constraints |
|---|---|---|
| `document_id` | `uuid` | FK `-> documents`; null when entered by hand |
| `name` | `text` | `NOT NULL` |
| `kind` | `plan_kind` | `NOT NULL` |
| `premium_per_period_cents`, `deductible_cents`, `oop_max_cents` | `bigint` | `NOT NULL`, `CHECK (>= 0)`; `CHECK (deductible_cents <= oop_max_cents)` |
| `coinsurance_pct` | `numeric(5,2)` | `NOT NULL`, `CHECK (coinsurance_pct BETWEEN 0 AND 100)` |
| `employer_hsa_cents` | `bigint` | `NOT NULL DEFAULT 0`, `CHECK (>= 0)` |
| `enrollment_deadline` | `date` | Nullable |

### `benefits_chunks`

Chunked benefits text for retrieval. Kept after the blob is deleted.

| Column | Type | Constraints |
|---|---|---|
| `document_id` | `uuid` | `NOT NULL`; FK `-> documents ON DELETE CASCADE` |
| `chunk_index` | `integer` | `NOT NULL`, `CHECK (chunk_index >= 0)`; `UNIQUE (document_id, chunk_index)` |
| `text` | `text` | `NOT NULL` (redacted text only) |
| `search` | `tsvector` | `GENERATED ALWAYS AS (to_tsvector('english', text)) STORED` |

Indexes: GIN on `search`.

### `sync_items`

One per linked institution or CSV source.

| Column | Type | Constraints |
|---|---|---|
| `provider` | `sync_provider` | `NOT NULL` |
| `provider_item_id` | `text` | Null for CSV; partial `UNIQUE (provider, provider_item_id) WHERE provider_item_id IS NOT NULL` (the webhook lookup key) |
| `institution_name` | `text` | Nullable |
| `access_token_enc` | `bytea` | Fernet ciphertext under `PLAID_TOKEN_KEY`; `CHECK ((provider = 'plaid') = (access_token_enc IS NOT NULL))`; never returned by any route |
| `cursor` | `text` | Nullable; written only after the last page of a sync |
| `status` | `sync_status` | `NOT NULL DEFAULT 'active'` |
| `last_synced_at` | `timestamptz` | Nullable |

`UNIQUE (id, user_id)`.

### `accounts`

| Column | Type | Constraints |
|---|---|---|
| `sync_item_id` | `uuid` | `NOT NULL`; FK `-> sync_items ON DELETE CASCADE` |
| `provider_account_id` | `text` | `NOT NULL`; `UNIQUE (sync_item_id, provider_account_id)` |
| `kind` | `account_kind` | `NOT NULL` |
| `name` | `text` | `NOT NULL` |
| `mask` | `text` | Nullable; last four digits only, `CHECK (mask ~ '^[0-9]{2,4}$')` |
| `role` | `account_role` | Nullable; partial `UNIQUE (user_id) WHERE role = 'emergency_fund'` (current savings is read from the one emergency-fund account) |
| `is_active` | `boolean` | `NOT NULL DEFAULT true` |

`UNIQUE (id, user_id)`.

### `transactions`

| Column | Type | Constraints |
|---|---|---|
| `account_id` | `uuid` | `NOT NULL`; FK `-> accounts ON DELETE CASCADE` |
| `provider_txn_id` | `text` | `NOT NULL`; `UNIQUE (account_id, provider_txn_id)` (the pipeline's upsert key) |
| `posted_at` | `date` | `NOT NULL`; the provider's posting date |
| `amount_cents` | `bigint` | `NOT NULL`; sign per rule 21 |
| `merchant_raw` | `text` | `NOT NULL` |
| `merchant_clean` | `text` | Nullable; display name |
| `merchant_norm` | `text` | `NOT NULL`; `normalize_merchant(merchant_raw)`: lowercased, digits and store numbers stripped (spec amendment 6) |
| `category` | `text` | Nullable until categorized; a value from the seed category list |
| `category_source` | `category_source` | `CHECK ((category IS NULL) = (category_source IS NULL))` |
| `confidence` | `numeric(4,3)` | `CHECK (confidence BETWEEN 0 AND 1)`; `CHECK ((category_source = 'llm') = (confidence IS NOT NULL))` |
| `pending` | `boolean` | `NOT NULL DEFAULT false` |

Indexes: `(user_id, posted_at DESC, id DESC)` for cursor pagination; `(user_id, merchant_norm)` for relabeling siblings after a fix; `(user_id, category)`.

### `category_rules`

| Column | Type | Constraints |
|---|---|---|
| `user_id` | `uuid` | Nullable: `NULL` for seed rows; `CHECK ((user_id IS NULL) = (source = 'seed'))` |
| `merchant_norm` | `text` | `NOT NULL`, `CHECK (merchant_norm <> '')`; a plain string, never a pattern |
| `match` | `rule_match` | `NOT NULL` |
| `category` | `text` | `NOT NULL` |
| `source` | `rule_source` | `NOT NULL` |

`UNIQUE NULLS NOT DISTINCT (user_id, merchant_norm, match)`. Precedence when categorizing: user exact, user prefix, seed exact, seed prefix, then the LLM; among prefix rules of one source, the longest `merchant_norm` wins. The categorizer loads the user's rules and the seed rules once per run and matches in memory, so prefix lookups need no special index.

### `balance_snapshots`

Append-only; one row per account per sync.

| Column | Type | Constraints |
|---|---|---|
| `account_id` | `uuid` | `NOT NULL`; FK `-> accounts ON DELETE CASCADE` |
| `as_of` | `timestamptz` | `NOT NULL`; `UNIQUE (account_id, as_of)` |
| `balance_cents` | `bigint` | `NOT NULL`; sign per rule 22 |

Indexes: `(account_id, as_of DESC)`.

### `holdings`

| Column | Type | Constraints |
|---|---|---|
| `account_id` | `uuid` | `NOT NULL`; FK `-> accounts ON DELETE CASCADE` |
| `as_of` | `date` | `NOT NULL` |
| `security_id` | `text` | `NOT NULL`; `UNIQUE (account_id, as_of, security_id)` |
| `name` | `text` | `NOT NULL` |
| `ticker` | `text` | Nullable |
| `quantity` | `numeric(24,8)` | `NOT NULL` (shares, not money) |
| `value_cents` | `bigint` | `NOT NULL` |
| `cost_basis_cents` | `bigint` | Nullable |

### `recurring_charges`

| Column | Type | Constraints |
|---|---|---|
| `merchant_norm` | `text` | `NOT NULL`; `UNIQUE (user_id, merchant_norm, cadence)` |
| `merchant_clean` | `text` | `NOT NULL`; display name |
| `cadence` | `recurring_cadence` | `NOT NULL` |
| `typical_amount_cents` | `bigint` | `NOT NULL`, `CHECK (typical_amount_cents > 0)` (money out) |
| `first_seen`, `last_seen` | `date` | `NOT NULL`, `CHECK (first_seen <= last_seen)` |
| `status` | `recurring_status` | `NOT NULL DEFAULT 'new'` |
| `user_status` | `recurring_user_status` | Nullable until the user acts |

### `goals`

| Column | Type | Constraints |
|---|---|---|
| `kind` | `goal_kind` | `NOT NULL` |
| `target_amount_cents` | `bigint` | `NOT NULL`, `CHECK (> 0)` |
| `monthly_contribution_cents` | `bigint` | `NOT NULL`, `CHECK (>= 0)` |
| `account_id` | `uuid` | Nullable; FK `-> accounts ON DELETE SET NULL (account_id)` |
| `decision_id` | `uuid` | Nullable; FK `-> decisions` |
| `target_date` | `date` | Nullable |

### `decisions`

Append-only and versioned; rules 13-20.

| Column | Type | Constraints |
|---|---|---|
| `calculator` | `calculator_kind` | `NOT NULL` |
| `inputs` | `jsonb` | `NOT NULL`; the calculator input model, including `tax_year` |
| `result` | `jsonb` | `NOT NULL`; the calculator output model, money as integer cents |
| `version` | `integer` | `NOT NULL`, `CHECK (version >= 1)` |
| `supersedes_id` | `uuid` | Nullable; FK `(supersedes_id, user_id) -> decisions(id, user_id)` |
| `check_in_id` | `uuid` | Nullable; FK `-> check_ins` (added in `0005`); set when the new version was made from a check-in finding |

Constraints: `UNIQUE (user_id, calculator, version)`; partial unique on `supersedes_id`; `CHECK ((version = 1) = (supersedes_id IS NULL))`; insert and immutability triggers. `UNIQUE (id, user_id)`. Indexes: `(user_id, calculator, version DESC)`. View `current_decisions` per rule 18.

### `explanations`

One row per attempt; append-only.

| Column | Type | Constraints |
|---|---|---|
| `decision_id` | `uuid` | Nullable; FK `-> decisions` |
| `finding_id` | `uuid` | Nullable; FK `-> check_in_findings` (added in `0005`); `CHECK (num_nonnulls(decision_id, finding_id) = 1)` |
| `attempt` | `smallint` | `NOT NULL`, `CHECK (attempt IN (1, 2))` (one retry) |
| `text` | `text` | `NOT NULL`; for a fallback, the plain calculator result |
| `citations` | `jsonb` | `NOT NULL DEFAULT '[]'`; list of `irs_citations` keys |
| `prompt_version` | `text` | `NOT NULL` |
| `verified` | `boolean` | `NOT NULL` |
| `fallback` | `boolean` | `NOT NULL`; `CHECK (NOT (verified AND fallback))` |
| `numbers_checked`, `citations_checked` | `integer` | `NOT NULL DEFAULT 0`, `CHECK (>= 0)`; the verification counts `GET /decisions/{id}/explanation` returns |
| `llm_call_id` | `uuid` | Nullable; FK `-> llm_calls` |

Indexes: `(decision_id, created_at DESC)`, `(finding_id, created_at DESC)`. The latest explanation is the newest row.

### `check_ins`

| Column | Type | Constraints |
|---|---|---|
| `period` | `date` | `NOT NULL`; first day of the reviewed month, `CHECK (EXTRACT(day FROM period) = 1)` |
| `triggered_by` | `checkin_trigger` | `NOT NULL`; partial `UNIQUE (user_id, period) WHERE triggered_by = 'schedule'` so the monthly enqueue is idempotent |
| `status` | `checkin_status` | `NOT NULL DEFAULT 'open'` |
| `completed_at` | `timestamptz` | `CHECK ((status = 'completed') = (completed_at IS NOT NULL))` |

### `check_in_findings`

| Column | Type | Constraints |
|---|---|---|
| `check_in_id` | `uuid` | `NOT NULL`; FK `-> check_ins ON DELETE CASCADE` |
| `kind` | `finding_kind` | `NOT NULL` |
| `severity` | `finding_severity` | `NOT NULL` |
| `decision_id` | `uuid` | Nullable; FK `-> decisions` |
| `payload` | `jsonb` | `NOT NULL`; shape per finding kind, set by the check-in spec (M8) |
| `user_action` | `finding_action` | Nullable; `PATCH` with `null` undoes (spec amendment 14) |
| `user_action_at` | `timestamptz` | `CHECK ((user_action IS NULL) = (user_action_at IS NULL))` |

### `calendar_events`

| Column | Type | Constraints |
|---|---|---|
| `kind` | `calendar_kind` | `NOT NULL` |
| `title` | `text` | `NOT NULL` |
| `due_at` | `date` | `NOT NULL` |
| `decision_id` | `uuid` | Nullable; FK `-> decisions` |
| `status` | `calendar_status` | `NOT NULL DEFAULT 'upcoming'` |

Indexes: `(user_id, due_at)`.

### `jobs`

| Column | Type | Constraints |
|---|---|---|
| `user_id` | `uuid` | Nullable only for system jobs: `CHECK ((kind = 'schedule.tick') = (user_id IS NULL))` |
| `kind` | `job_kind` | `NOT NULL` |
| `status` | `job_status` | `NOT NULL DEFAULT 'queued'` |
| `progress` | `smallint` | `NOT NULL DEFAULT 0`, `CHECK (progress BETWEEN 0 AND 100)` |
| `payload` | `jsonb` | `NOT NULL DEFAULT '{}'`; ids only (rule 28) |
| `result` | `jsonb` | Nullable |
| `last_error` | `text` | Nullable |
| `attempts` | `smallint` | `NOT NULL DEFAULT 0`; the job is `dead` after 5 |
| `run_after` | `timestamptz` | `NOT NULL DEFAULT now()`; backoff sets it to `now() + min(2^attempts * 30 s, 1 h)` |
| `heartbeat_at` | `timestamptz` | Nullable; the scheduler requeues `running` jobs whose heartbeat is stale |
| `started_at`, `finished_at` | `timestamptz` | Nullable |
| `idempotency_key` | `text` | Nullable; partial `UNIQUE (user_id, idempotency_key) WHERE idempotency_key IS NOT NULL` |

Indexes: `(run_after) WHERE status = 'queued'` for `FOR UPDATE SKIP LOCKED` dequeue; `(heartbeat_at) WHERE status = 'running'`.

### `llm_calls`

Append-only cost ledger (spec amendment 4). Written by `llm/gateway.py` in the caller's user session.

| Column | Type | Constraints |
|---|---|---|
| `purpose` | `llm_purpose` | `NOT NULL` |
| `model` | `text` | `NOT NULL` |
| `prompt_version` | `text` | `NOT NULL` |
| `input_tokens`, `output_tokens`, `cache_read_tokens` | `integer` | `NOT NULL DEFAULT 0`, `CHECK (>= 0)` |
| `cost_microcents` | `bigint` | `NOT NULL DEFAULT 0`, `CHECK (>= 0)`; millionths of a cent |
| `latency_ms` | `integer` | `NOT NULL`, `CHECK (>= 0)` |
| `status` | `llm_status` | `NOT NULL`; a refused call past the budget is recorded as `budget_blocked` with zero tokens |
| `job_id` | `uuid` | Nullable; references `jobs(id) ON DELETE SET NULL` |

Indexes: `(user_id, created_at)` for the daily budget sum over the current UTC day.

### `irs_citations`

Reference data, no `user_id` (RLS exception).

| Column | Type | Constraints |
|---|---|---|
| `calculator` | `calculator_kind` | `NOT NULL` |
| `key` | `text` | `NOT NULL`; for example `k401.deferral_limit`; `UNIQUE (key, tax_year)` |
| `title` | `text` | `NOT NULL` |
| `url` | `text` | `NOT NULL`, `CHECK (url LIKE 'https://%')` |
| `passage` | `text` | `NOT NULL`; quoted from the page, verified by hand |
| `tax_year` | `smallint` | `NOT NULL` |
| `source` | `text` | `NOT NULL`; the IRS document name, for example "Notice 2025-67" |
| `verified_on` | `date` | `NOT NULL` |

## Migrations

| Revision | Creates |
|---|---|
| `0001_roles` | Role `app_api`, `current_user_id()`, `set_updated_at()`; the `auth` schema shim is created only by tests |
| `0002_core` | `profiles`, `sync_items`, `accounts`, `transactions`, `balance_snapshots`, `holdings`, `category_rules`, `jobs`, `llm_calls`, and their enums |
| `0003_documents` | `documents`, `document_blobs`, `pay_stubs`, `benefits_plans`, `benefits_chunks` |
| `0004_decisions` | `decisions` with its constraints, triggers and `current_decisions` view, `goals`, `calendar_events`, `explanations`, `irs_citations` |
| `0005_checkins` | `recurring_charges`, `check_ins`, `check_in_findings`, and the deferred foreign keys `decisions.check_in_id` and `explanations.finding_id` |
| `0006_webhook_fn` | `enqueue_sync_for_plaid_item(text)` |

CI runs upgrade, downgrade, upgrade and `alembic check` on every pull request.

## Hand-worked examples

The data model's examples are RLS and constraint tests rather than arithmetic. Each row is one test.

| # | Test | Setup | Expected |
|---|---|---|---|
| 1 | `test_rls_owner_isolation` | User A inserts a transaction | User B's session selects zero rows; B's `GET /transactions/{id}` is 404 |
| 2 | `test_role_reset_after_transaction` | Run a request as A, then reuse the pooled connection | `current_user` is `app_api` and `request.jwt.claims` is empty |
| 3 | `test_decision_v2_supersedes_v1` | A saves v1, then v2 with `supersedes_id = v1.id` | Both rows exist; `current_decisions` returns v2 |
| 4 | `test_decision_second_v2_rejected` | A saves v2 twice against v1 | Second insert fails on rule 14 or 15; route returns 409 |
| 5 | `test_decision_update_rejected` | `UPDATE decisions SET result = ...` as A | Raises from the trigger |
| 6 | `test_cannot_supersede_other_users_decision` | B inserts v2 with `supersedes_id` = A's v1 | Rejected by the insert policy and the composite FK |
| 7 | `test_version_one_has_no_parent` | Insert `version = 2, supersedes_id = NULL` | Fails the check constraint |
| 8 | `test_seed_rules_visible_not_writable` | B selects and then updates a seed rule | Select returns it; update affects zero rows |
| 9 | `test_pay_stub_must_balance` | Insert a stub with net off by 2 cents | Fails `pay_stub_balances` |
| 10 | `test_unlink_cascades` | Delete a sync item with accounts, transactions, snapshots, holdings and a goal on one account | All four child sets gone; the goal remains with `account_id` null |
| 11 | `test_confirm_deletes_blob` | Confirm a pay stub | `document_blobs` row gone, `documents.deleted_at` set, `pay_stubs` row present, all in one transaction |
| 12 | `test_jobs_not_updatable_by_user` | A updates their own job's status | Zero rows affected |

## Edge cases

- A transaction removed by Plaid is deleted, not flagged; a modified one is updated in place by the `(account_id, provider_txn_id)` upsert.
- A user with no emergency-fund account has no current savings from balances; the calculator asks for it (technical spec, Current savings).
- `pay_stubs.tax_year` is generated, so a corrected `pay_date` updates it automatically.

## Out of scope

- Multi-currency. All amounts are US dollars.
- Organization or employer tenancy (a later layer, technical spec section 5).
- Storing prompt or completion text anywhere.

## Open questions

1. **Account deletion and immutable decisions.** The decisions trigger rejects every `DELETE`, which also blocks the `ON DELETE CASCADE` from `auth.users`. M10 ("unlink and deletion paths") must choose between letting the trigger allow deletes inside a privileged account-deletion function and another mechanism. Until then, account deletion is not offered.
2. **Abandoned uploads.** A blob whose document is never confirmed has no deletion rule in the spec. Proposal for M10: a scheduled job deletes blobs older than a fixed age and marks the document `failed`.
3. **Recurring charges after unlink.** `recurring_charges` has no account link, so unlinking leaves charges detected from that account's transactions. Decide in M5 whether to add `account_id` or to re-run detection after unlink.
4. **Terminal job retention.** Succeeded and dead jobs accumulate; decide a pruning age before M10.
5. **CSV transaction ids.** CSV rows have no provider id, but `UNIQUE (account_id, provider_txn_id)` needs one for idempotent re-imports. Decide in M5 how `csv_provider.py` derives it (for example a hash of account, date, amount, description and the row's occurrence count).
