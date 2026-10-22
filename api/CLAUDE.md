# api/

FastAPI backend and background worker. Python 3.12, managed by uv from the repo
root (`uv sync --all-packages`). `api/` is the import root: `app`, `calc`, `db`,
`jobs`, `llm`, ... are top-level packages (add new ones to `pyproject.toml`
`[tool.hatch.build.targets.wheel] packages`).

## Layout

```
app/        main.py (create_app), config.py (Settings), auth.py (JWT), db.py (engines,
            user_session), deps.py (UserSession, DbBind), errors.py, openapi.py, routers/
calc/       calculators: f(Input) -> Result, Pydantic models, integer cents, Decimal rates;
            data/<year>.json (federal constants), data/pub15t_<year>.json (withholding
            tables), registry.py, pay_dates.py, spending.py,
            cashflow.py, recurring.py (amount arithmetic for detection)
db/         models.py (Base), rls.py (enable_rls), enums.py, seed/ (load.py, data files)
alembic/    env.py, versions/NNNN_name.py
sync/       provider.py (protocol), pipeline.py, crypto.py, categorize.py, categories.py,
            plaid/ (client, provider, webhook), csv_provider.py, recurring.py
ingest/     store (document_blobs), chunk, proposal (API-safe); reader, ocr, redact,
            layout, pipeline (worker only)
llm/        gateway.py (the only anthropic import), schemas.py, cost.py, prompts/<name>/vN.md
retrieval/  IRS citations, benefits full-text search, context.py (what explain sends)
verify/     numbers, allowed, verify (checks), flow (draft-verify-retry-fallback), fallback
jobs/       queue.py, worker.py, scheduler.py, registry.py, services.py, context.py,
            handlers/ (sync, categorize, recurring, ingest_extract)
checkin/    engine and one pure function per finding kind
export/     calendar (.ics), store (plan_exports) (API-safe); html, pdf, templates/ (worker only)
tests/      unit/ (no DB, no network), integration/ (real Postgres), rls/ (cross-user
            route cases), support/ (fakes, factories), fixtures/ (plaid, llm)
```

## Request lifecycle and RLS

1. `CurrentUser` (`app/auth.py`) verifies the Supabase access token with
   `PyJWKClient` against the project JWKS: ES256 or RS256 only, audience
   `authenticated`, the project issuer, 30 s leeway. Failures are 401; a JWKS
   outage is 503 (the token may be fine).
2. `UserSession` (`app/deps.py`) opens one transaction on the `app_api` engine
   and runs `SET LOCAL ROLE authenticated` plus
   `set_config('request.jwt.claims', <claims>, true)`, so `auth.uid()` and every
   policy see the user. Both are transaction-local: commit or rollback returns a
   clean pooled connection. The dependency uses `scope="function"`, so the
   commit happens before the response is sent.
3. Job handlers have no JWT: they use `user_session_for(user_id)`.

Rules:

- Routers never import `app.db` or create engines; they take `UserSession`.
  `tests/unit/test_boundaries.py` enforces this and the `calc/` and `anthropic`
  boundaries.
- `get_privileged_engine()` (the `postgres` role) is for `jobs/queue.py`
  (dequeue across users), `jobs/scheduler.py`, the seed loader
  (`db/seed/load.py`, which writes the ownerless seed rules) and Alembic only.
  Cross-user SQL outside those places goes through a reviewed
  `SECURITY DEFINER` function.
- A row owned by someone else is invisible under RLS, so the route returns 404.
- `app_api` is `NOINHERIT` and owns nothing; without the role switch it cannot
  read user data. Turn off Supabase's Data API exposure of `public` (Project
  Settings, API): `authenticated` holds table grants, so PostgREST would
  otherwise let a signed-in user write rows past the API's validation.

## Database and migrations

- Every user-owned table has `user_id uuid NOT NULL REFERENCES auth.users(id)
  ON DELETE CASCADE` and gets `enable_rls("table")` (from `db.rls`) in the
  migration that creates it: RLS enabled and forced, grants reset, one owner
  policy on `public.current_user_id()`.
- Money columns are `bigint` named `*_cents`; Pydantic uses
  `Annotated[int, Field(strict=True)]`. Timestamps are `timestamptz` in UTC.
- New revision: `make revision id=0002_core msg="core tables"`. Hand-check
  autogenerate output; RLS, grants, triggers and functions are written by hand.
  Every revision has a working `downgrade()`.
- Migrations never create Supabase's `auth` schema; tests install a shim
  (`tests/support/auth_shim.py`) on plain Postgres.
- CI runs upgrade, downgrade to base, upgrade and `alembic check`.

## Errors and the API contract

- Raise `AppError` (or `NotFound`, `Unauthorized`); every error leaves as
  `{"error": {"code", "message"}}`. Document error statuses on a route with
  `responses=error_responses(404, 422)`.
- Operation ids are route function names. After a route or schema change run
  `make types` and commit `api/openapi.json`; a unit test and CI fail on drift.

## LLM gateway (from M1)

- `llm/gateway.py` is the only module that imports `anthropic` (spec 003
  rules 19-27). Each call: budget check over the user's current UTC day
  (blocked calls write a `budget_blocked` row before any HTTP), then
  `client.messages.create` with the system prompt as one cached text block and
  `output_config={"effort": ..., "format": {"type": "json_schema", "schema":
  anthropic.transform_schema(Schema)}}`, then `stop_reason == "refusal"` is
  checked before any output is read (`LLMRefused`), then the text is validated
  with `Schema.model_validate_json` (`LLMSchemaError`). `messages.parse` is not
  used: it validates inside the call, so a refusal's non-JSON text raises before
  `stop_reason` is readable and the call's usage is lost.
- Every call writes one `llm_calls` row in its own committed user session
  (counts, cost, status; never prompt or output text). Prices live in
  `llm/cost.py`; a model without a price fails before the call.
- Prompts: `llm/prompts/<name>/vN.md` with YAML front matter (`version`,
  `model` = settings purpose, `effort`, `max_tokens`, `schema`), loaded and
  validated by `llm/prompts/__init__.py`. A released prompt file is never
  edited; a change is a new version.
- `LLM_FAKE=true` swaps in `FakeGateway`, which shares the budget, validation
  and ledger code and answers from `tests/fixtures/llm/categorize.json`; every
  API and worker test runs with it. Live calls are marked `llm_live` and never
  run by default.
- The SDK is built on `httpx2`, which `respx` cannot patch: gateway tests pass
  `http_client=httpx2.Client(transport=httpx2.MockTransport(...))`.
- Model ids come from settings (`LLM_MODEL_*`), never literals in code.

## Sync, Plaid and jobs (from M1)

- `sync/provider.py` is the provider protocol; `sync/pipeline.py:run_sync` is
  its only caller (spec 002). Network calls run with no transaction open; the
  cursor is written last, in the same transaction as the data.
- `sync/plaid/client.py` is the only module that imports `plaid` (no type
  stubs; the exemption is scoped to that file). It parses money as `Decimal`
  and raises `PlaidError` without request bodies. Access tokens are `SecretStr`
  everywhere and encrypted with `sync/crypto.py` before they touch the database.
- The webhook route verifies the signature in a dependency declared before
  its database session, then calls `enqueue_sync_for_plaid_item` through
  `ServiceSession` (`SET LOCAL ROLE app_api`), the one granted function.
- `jobs/services.py:default_services` builds the worker's Plaid provider
  factory and gateway. Missing credentials fail jobs (and retry), never the
  worker. Handlers are registered in `jobs/registry.py`.
- `sync/categorize.py`: normalization, the `RuleBook`, the `categorize.run`
  job (rules, reuse of earlier LLM labels, then 50 merchants per gateway call)
  and `record_user_label` for `PATCH /transactions/{id}` (spec 003).
- Migration names follow spec 001: `0006_webhook_fn` revises `0002_core`, and
  the next revision (`0003_documents`) revises `0006_webhook_fn`;
  `0007_lock_alembic_version` revises `0003_documents`, `0004_decisions`
  revises `0007_lock_alembic_version`, and `0005_checkins` revises
  `0004_decisions`.
- Supabase grants every new table and function in `public` to `anon` and
  `authenticated` by default. `enable_rls` revokes that per table; a function
  needs its own `REVOKE ALL ... FROM PUBLIC, anon, authenticated` plus the
  intended grant (see 0007). The test auth shim copies those defaults, and
  `test_migrations` fails on any object left granted to `anon`.

## Documents, extraction and confirm (from M2)

Specs 004 and 005. The flow: `POST /docs` stores the bytes, `POST
/docs/{id}/extract` queues `ingest.extract`, the worker reads, OCRs, redacts
and asks the gateway, `GET /docs/{id}` shows the proposal, `POST
/docs/{id}/confirm` stores what the user sent and deletes the bytes.

- **The API process never parses a document.** `app/` must not import
  `ingest.reader`, `ingest.ocr`, `ingest.redact`, `ingest.pipeline`,
  pdfplumber, pypdfium2, pytesseract or PIL; `tests/unit/test_boundaries.py`
  enforces it and checks `import app.main` loads none of them. The upload
  route sniffs magic bytes only.
- `ingest/store.py` is the only module that touches `document_blobs` (also
  enforced). Retention is `store.expire_unconfirmed(now)` in the scheduler tick
  (7 days), which also prunes `rate_limit_counters` (`app/ratelimit.py`).
- **Everything the model reads is redacted first** (`ingest/pipeline.py`):
  text-layer pages through `redact_text`, other pages as images through OCR and
  `redact_image` (black boxes), pages under OCR mean confidence 60 withheld.
  `tests/integration/ingest/test_extract_job.py` asserts the gateway never
  receives the SSN, re-OCR'ing the image it was sent.
- **The model's answer is a proposal.** `ingest/proposal.py` turns it into
  reviewable fields (kind, role, note), computes `other_deductions_cents` in
  code from line items with no column, and links fields to redacted source
  lines. `documents.proposal` holds it; `jobs.result` holds ids and counts only.
  Confirm validates the body with `PayStubValues` / `PlanValues`, runs the
  arithmetic gate in `calc/pay_stub.py` (422 `pay_stub_unbalanced` with
  `details`), and stores the body's values, never the proposal's.
- Refusal, a spent budget or no readable page make the document
  `manual_entry_required`; schema and API errors retry and the last attempt
  falls back to manual entry. The handler writes its outcome only while the
  document is still `extracting` under its job.
- `AppError` takes `details` (machine-readable, e.g. the confirm diff) and
  `headers` (e.g. `Retry-After`). Money types and two-place percentages shared
  by calculators and request models live in `calc/types.py`.
- Swagger UI is at `/api-docs`: `/docs` is the documents API.
- The request clock is the `Now` dependency (`app/deps.py:get_now`); tests
  override it to freeze time (the upload rate limit is per clock hour, UTC).

## Calculators, decisions and explain (from M3)

Specs 006, 007 and 008. The flow: `POST /calc/401k-match` computes and saves
nothing, `POST /decisions` recomputes and saves the user's pick as a new
immutable version, `POST /explain` drafts, verifies and stores an
explanation, `GET /calendar` shows the check it implies.

- **Calculators** (`calc/`) are pure functions `f(Input) -> Result`: stdlib,
  `decimal`, `pydantic` and `calc` only, no floats (a test walks the AST),
  integer cents, `Decimal` rates under `calc.money.CONTEXT`, one
  `round_half_up` per output. Federal constants live in `calc/data/<year>.json`
  behind `tax_year(year)`; a year without a file is a validation error, never
  a silent fallback. Every calculator gets a spec example test per row and
  Hypothesis properties. Register a new one in `calc/registry.py` (keys are
  `calculator_kind` values) so `POST /decisions` can recompute it.
- **Decisions are immutable.** `POST /decisions` (`app/routers/decisions.py`)
  is the only writer: it validates the inputs, reruns the calculator, compares
  field by field with the client's result (422 `result_mismatch` with
  `details.fields`) and stores the server's `model_dump(mode="json")`. A new
  version supersedes the current one; conflicts are 409 `decision_conflict`
  from the unique indexes. The `decisions_immutable` trigger refuses every
  UPDATE and DELETE except the cascade from deleting the owner's
  `auth.users` row (`pg_trigger_depth() > 1` and the owner gone). Side effects
  (the `election_check` calendar event, dismissing the superseded one) run in
  the same transaction.
- **Explain never shows an unchecked number.** `verify/` is plain code:
  `extract_numbers`, `AllowedNumbers.from_decision(inputs, result)` (keys with
  a `_cents` part are money, `_pct`/`_rate` parts are percentages) and
  `verify_explanation`. `verify/flow.py:run_explain` drafts, verifies, retries
  once with the verifier's feedback, then falls back to
  `verify/fallback.py`'s code-written text; every attempt is an
  `explanations` row. The context the model sees comes from
  `retrieval/context.py` (facts formatted with `verify/format.py`, which the
  verifier reads back), the seed IRS passages and the user's redacted benefits
  text.
- **No transaction across a model call.** `POST /explain` takes `UserSessions`
  (a factory, `app/deps.py`): read in one session, call the gateway with none
  open, write in a second. `LlmGateway` is lazy, so a 404 or a stored verified
  explanation needs no model; an unconfigured model is 503 `llm_unavailable`.
  A run that reaches the model counts against `ratelimit.EXPLAIN_RUNS` (30 per
  clock hour, 429 with `Retry-After`); stored answers, 404s and 503s are free.
- **IRS passages** are curated in `db/seed/irs_citations/<prefix>.yaml`,
  quoted exactly from irs.gov (under 80 words, `...` for omissions, every part
  verified against the live page; `verified: false` entries are not loaded).
  `make seed` upserts them; `irs_citations` is read-only to users.
- Tests that need the passages take the `seeded_citations` fixture. Flow and
  route tests script the model with `llm.gateway.ScriptedGateway` (a
  `FakeGateway` that answers from a list of replies, errors or `None` for the
  default fake answer) through `app.dependency_overrides[get_llm_gateway]`.
- `GET /spending/summary` is one `GROUP BY category` under RLS rolled up by
  the pure `calc/spending.py:summarize`; buckets are
  `sync/categories.py:CATEGORY_BUCKETS`.

## Logging and operations (from M4)

- `app/logs.py` is the one logging setup: JSON lines on stderr (`ts`, `level`,
  `logger`, `message`, then fields), plain text only when `APP_ENV=development`
  on a TTY. `configure_logging()` for CLIs and the worker; `app.serve api`
  hands `logging_config()` to uvicorn, whose own lines then share the format;
  a bare `uvicorn app.main:app` gets it from `ensure_logging()` in the lifespan.
- Log fields with `extra={...}` or bind them with `log_context(...)`; ids,
  counts and durations only. Never tokens, headers, request bodies, document
  bytes, extracted values or secrets.
- `app/request_log.py` writes one `app.request` line per request (`method`,
  `path` without the query, `status`, `duration_ms`, `request_id`, `user_id`
  once the token verified) and returns `X-Request-Id` (kept from the request
  when it is a plain token, else generated), also on unhandled 500s. The worker
  logs each run (`job_id`, `kind`, `user_id`, `attempt`, `outcome`,
  `duration_ms`) and binds them for the handler's own lines; a job that goes
  `dead` logs at ERROR with its traceback.
- Sentry (`app/sentry.py`) runs only when `SENTRY_DSN` is set (Render's env
  group; blank everywhere else, and tests blank it), from `create_app` and
  `jobs.worker.main`, tagged `component=api|worker`. No PII, no request
  bodies, no frame locals; `before_send` drops bodies, cookies and
  `Authorization`. Without a DSN `sentry_sdk` is never imported.
- `GET /health` adds `worker: ok | stale` from `jobs/scheduler.py:worker_status`
  (a running job's heartbeat or a succeeded tick in the last 5 minutes, read on
  the privileged connection; spec 002 rule 38). It stays 200 when the worker is
  stale or the read fails. Tests point `get_queue_bind` at their connection
  (the `app` fixture does) or override `worker_state`.

## Recurring charges, cash flow and CSV import (from M5)

Specs 009 and 010. Migration `0005_checkins` adds `recurring_charges`,
`check_ins`, `check_in_findings` and the deferred keys `decisions.check_in_id`
(no ON DELETE action) and `explanations.finding_id`.

- **Recurring detection** (`sync/recurring.py`): `detect(charges, today)` is
  pure: money-out transactions grouped by `merchant_norm`, the series is the
  charges within 15% of the group median, a cadence band (weekly 6-8 d,
  monthly 27-33 d, yearly 350-380 d) must hold three quarters of the gaps, and
  each cadence has a minimum length (4, 3, 2). Amount arithmetic is
  `calc/recurring.py`. `next_status` / `undetected_status` decide `status`;
  `new` and `changed` are sticky until the check-in (M8) sets `active`.
  `run_detection` writes under RLS and a per-user advisory lock; it never
  overwrites `merchant_clean` (the user's rename) or `user_status`, and deletes
  rows whose merchant has no charges left (unlink queues `recurring.detect`).
- Job handlers read time from `Services.clock` (`jobs/context.py`), so tests
  pass a fixed clock to the `Worker`.
- **`GET /cashflow`** (`app/routers/cashflow.py`): stage-1 lines per pay stub
  from the pure `calc/cashflow.py:withholding` (seven fixed lines with roles
  tax, retirement, health, other, plus role and period totals) and the
  spending summary through `spending.summary_for`, the same code as `GET
  /spending/summary`, so the two never disagree.
- **`POST /accounts/import`** (`app/routers/accounts.py`, `sync/csv_provider.py`):
  `parse_csv` checks the whole file before any write (422 `csv_invalid` with
  `details.errors` of `{row, column, message}`), converts to positive-is-out
  per the `sign` field, and derives `provider_txn_id` from date, amount,
  description and the occurrence number, so re-imports never duplicate. The
  route runs `run_sync` with `CsvProvider` inside the request's own session (no
  network, so one transaction); a stale cursor is 409 `import_conflict`. Its
  10 MB limit is a second `BodySizeLimit` in `app/main.py`.
- `tests/support/spending_month.py` holds spec 007's September month, shared by
  the spending and cash-flow tests.

## Emergency fund, health plans and benefits (from M6)

Specs 011, 012 and 013. Migration `0008_goals_and_birth_year` revises
`0005_checkins`: `goal_status` and `goals.status`/`reached_at`, one
emergency-fund goal per user (`uq_goals_user_emergency_fund`), the calendar
kinds `goal_contribution` and `goal_review`, `profiles.birth_year` and
`benefits_plans.position`. No new table or function.

- **Calculators.** `calc/emergency_fund.py` (`POST /calc/emergency-fund`) and
  `calc/health_plans.py` (`POST /calc/health-plans`), both in
  `calc/registry.py` as `emergency_fund` and `health_plans`. Essentials come
  in as an input; `calc/` never reads the database. HSA and HDHP constants
  live in `calc/data/2026.json` (`hsa`, Rev. Proc. 2025-19);
  `calc/brackets.py:marginal_rate` is shared with the 401(k) calculator.
  `calc/pay_dates.py:add_months` clamps to the month's end.
- **Decision side effects** live in `app/decision_effects.py`:
  `check_saveable` (a health-plan decision needs `selected_plan_index`, else
  422 `plan_not_selected`) runs before the version check, `apply` after the
  insert, in the same transaction. The 401(k) election check moved there; an
  emergency-fund decision upserts the goal and its `goal_contribution` and
  `goal_review` events; a health-plan decision with an `enrollment_deadline`
  creates that event. A superseded decision's events are dismissed.
- **Goals.** `GET /goals` (progress from the latest balance of the linked
  account) and `PATCH /goals/{id}` (status, contribution, linked account; an
  account the user cannot see is 404).
- **Benefits** (spec 013). `extract_benefits/v2` returns
  `BenefitsSummaryExtraction` (plans, match tiers as printed, vesting); v1 and
  `BenefitsExtraction` stay for the ledger. `ingest/proposal.py` turns the
  bands into cumulative tiers with `calc.k401.cumulative_bounds`, so the model
  never adds. Every proposal carries `kind`; read stored ones with
  `Proposal.stored(data, document_type)`. Confirm writes plans with their list
  `position` and, when the body has `retirement`, only the profile's
  `match_tiers` and `vesting_years`. `GET /benefits-plans`
  (`app/routers/benefits.py`) lists the most recently confirmed summary first.
- **Explain for health plans.** Facts are numbers only; plan names and usage
  go in `retrieval/context.py:health_notes`. `name_numbers` lets digits in a
  plan's name pass the verifier, and `AllowedNumbers` matches money by
  magnitude (a negative expected cost is printed as `-$403.00`). Citations:
  `db/seed/irs_citations/health_plans.yaml`. An emergency-fund decision has no
  IRS citation to give, so explaining one is 422 `explanation_unavailable`.
- **Birth year.** `profiles.birth_year` (1900 to the current year, the upper
  bound checked in `PUT /profile`) settles spec 006 open question 2; the
  401(k) calculator still takes `age`, which the client derives as
  `tax_year - birth_year`.

## W-4 withholding (from M7)

Spec 014. Migration `0009_w4_calendar_kind` revises `0011_no_model_reason` and
adds the `calendar_kind` label `w4_submit`; no new table or function.

- **Calculator.** `calc/w4.py` (`POST /calc/w4`, `w4` in `calc/registry.py`):
  Pub 15-T Worksheet 1A per paycheck, the projected tax from
  `calc/brackets.py:income_tax`, the refund (negative is a balance due) and a
  whole-dollar Step 4(c) or 4(b) suggestion closest to zero. The 401(k) rate
  and the health premium per paycheck are inputs the client copies from the
  saved decisions; `calc/` never reads them. `expected_deductions_cents` keeps
  the projection honest when a Step 4(b) entry is only a withholding
  adjustment; `other_jobs_*` feed the projection, never this job's withholding.
- **Constants.** `calc/data/pub15t_<year>.json` behind `calc.data.pub15t(year)`
  (Worksheet 1A line 1g and the annual STANDARD and Step 2 checkbox tables,
  column B implied by the next row). `tests/unit/calc/test_pub15t_data.py`
  rebuilds every row from the year's brackets and standard deduction, so a
  typo in either file fails. A year needs both files.
- **Decision effect.** `decision_effects._w4`: one `w4_submit` event ("Give your
  employer your updated Form W-4") due the next expected pay date; a new
  version dismisses the old one.
- **Explain.** `retrieval/context.py` has W-4 facts (numbers only) and
  `w4_notes` (no digits); `verify/fallback.py` writes the W-4 fallback.
  Citations: `db/seed/irs_citations/w4.yaml` (Pub 15-T web edition, the 2026
  Form W-4, IR-2025-103, the 401(k) Resource Guide). The verifier skips Form
  W-4 step numbers ("Step 2", "Steps 3") the way it skips "Form 1040".

## The plan and its export (from M9)

Spec 016. Migration `0013_plan_export_job` adds the `job_kind` label
`plan.export`, `jobs UNIQUE (id, user_id)` and the table `plan_exports`
(`enable_rls`, SELECT and INSERT only).

- **`GET /plan`** (`app/plan.py:build_plan`, shared with the worker): the
  current decisions in `calculator_kind` order with `figures` (fields copied by
  their path, `inputs.x` or `result.plans[i].y`; no arithmetic, a test follows
  every key), the explanation status from the latest row (`verified`,
  `fallback`, `none`) with its citations, `GET /goals`'s goals (`goal_out`),
  upcoming events from today to today + 90 days ordered by `due_at`, `kind`,
  `id`, the newest pay stub and `completeness`. A total the plan needs belongs
  in `calc/`, not here.
- **`GET /plan/calendar.ics`** (`export/calendar.py`, standard library):
  every event in any status, `UID` = event id, all-day `DTSTART;VALUE=DATE`,
  `STATUS:CANCELLED` for dismissed, TEXT escaping, CRLF, folding at 75 octets
  without splitting a UTF-8 character. Each `calendar_kind` needs a sentence in
  `DESCRIPTIONS` (a test fails otherwise). `.gitattributes` keeps `*.ics`
  fixtures byte for byte.
- **PDF.** `POST /plan/export` queues `plan.export` (`enqueue_unless_queued`,
  payload `{}`); `jobs/handlers/plan_export.py` builds the plan in one user
  session as of `Services.clock`, renders `export/templates/plan.html.j2`
  (`export/html.py`, Jinja2, autoescaped, numbers via `verify.format`) with
  `export/pdf.py` (WeasyPrint imported inside the function, URL fetcher refuses
  everything) with no session open, and stores it in a second session; a rerun
  keeps the first PDF. `GET /plan/export/{job_id}` streams it only when the job
  is a succeeded `plan.export` of the user and the row exists, else 404.
- **Worker only.** `app/` never imports `export.html`, `export.pdf`, `jinja2`
  or `weasyprint`, and `import app.main` loads none of them
  (`tests/unit/test_boundaries.py`). `export/store.py` is the only module that
  touches `plan_exports`; `expire_old` runs in the scheduler tick (7 days).
- **Look.** Page 1 is the plan, page 2 starts with the calendar and "Why, with
  sources" (citation URLs printed in full). Ledger ink on white, hairlines, no
  fills or images, US Letter, `DejaVu Sans` first (the image installs
  `fonts-dejavu-core`; `XDG_CACHE_HOME=/tmp/app-cache` gives fontconfig a writable
  cache as the `app` user).
- **Tests.** The plan user (`tests/support/plan_user.py`) saves all four
  decisions through the API at 2026-10-21 15:00 UTC and writes fixed
  explanations. `tests/fixtures/export/plan.html` is the expected page byte for
  byte; review a template change by rendering it and replacing the fixture.
  PDF tests take the `weasyprint` fixture: they skip when pango cannot load and
  fail in CI, which installs pango and runs `tests/*/export` in the image too.
  On macOS run them with `DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib uv run
  pytest ...` (make's shell drops `DYLD_*` variables).

## Testing

- `make test-api`. Unit tests need nothing; integration tests need
  `TEST_DATABASE_URL` (a disposable local Postgres) and are skipped without it,
  except in CI where a missing URL fails the run.
- `tests/conftest.py` pins the environment (`APP_ENV=test` ignores `.env`),
  migrates the test database once, wraps each test in a transaction that is
  rolled back, inserts `user_a` and `user_b` into `auth.users`, and provides
  `client_as(user)` (a TestClient sending a signed ES256 JWT) plus `app_api_url`
  for tests that must connect exactly as production does.
- Calculator tests come from the spec's hand-worked examples, plus Hypothesis
  properties (`derandomize=True` in CI).
- Marks: `plaid_sandbox` and `llm_live` call real services and are excluded by
  default (`-m "not plaid_sandbox and not llm_live"`). They read keys through
  `tests.support.env.live_credential` (the pinned environment blanks them) and
  skip when none are set.
- Anything that touches Postgres lives under `tests/integration/` (queue,
  pipeline, gateway ledger, routes), even when the plan calls it a unit test.
- The `app` fixture replaces Plaid with `tests/support/fake_plaid.py`; sync
  tests use `tests/support/fake_provider.py`, rows come from
  `tests/support/factories.py` (written as the owning user, under RLS).
- `tests/rls/test_cross_user.py`: every new route needs a `ROUTE_CASES` entry
  (user B against user A's data); a meta-test fails on any uncovered route.
- Plaid fixtures in `tests/fixtures/plaid/` are hand-written scenarios (pagination, modified and removed rows); `tests/fixtures/plaid/recorded/` holds real sandbox responses, scrubbed, for shape tests. The hand-written ones are in Plaid's
  response shapes; `scripts/record_plaid_fixtures.py` re-records them from the
  sandbox when keys are available. `tests/unit/test_fixture_secrets.py` fails
  on any token, key or configured live credential in a committed fixture.
- OCR tests take the `tesseract` fixture (`tests/conftest.py`): they skip on a
  laptop without the binary and fail when `CI` is set. The `ingest-in-docker`
  CI job runs `tests/unit/ingest` and `tests/integration/ingest` inside the
  image against its pinned Debian tesseract (`api/Dockerfile`, target `test`).
- Documents for ingest tests are built in memory by `tests/support/documents.py`
  (a hand-written text PDF, Pillow-rendered pages, a scanned-PDF wrapper);
  `tests/support/spy_gateway.py` is a `FakeGateway` that records what it was
  sent and can refuse or fail.
- Coverage gate in CI: 85%.

## Running

```
cd api && uv run uvicorn app.main:app --reload     # or `make dev` from the root
cd api && uv run python -m jobs.worker              # or `make worker`
cd api && uv run python -m app.serve                # API plus worker in one process tree (Render Free)
cd api && uv run python -m app.serve api            # the API alone, as Render runs it (JSON logs)
cd api && uv run alembic upgrade head               # or `make migrate`
docker build -f api/Dockerfile -t first-paycheck-api .   # from the repo root
```
