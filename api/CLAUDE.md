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
            data/<year>.json (federal constants), registry.py, pay_dates.py, spending.py
db/         models.py (Base), rls.py (enable_rls), enums.py, seed/ (load.py, data files)
alembic/    env.py, versions/NNNN_name.py
sync/       provider.py (protocol), pipeline.py, crypto.py, categorize.py, categories.py,
            plaid/ (client, provider, webhook); CSV provider and recurring later
ingest/     store (document_blobs), chunk, proposal (API-safe); reader, ocr, redact,
            layout, pipeline (worker only)
llm/        gateway.py (the only anthropic import), schemas.py, cost.py, prompts/<name>/vN.md
retrieval/  IRS citations, benefits full-text search, context.py (what explain sends)
verify/     numbers, allowed, verify (checks), flow (draft-verify-retry-fallback), fallback
jobs/       queue.py, worker.py, scheduler.py, registry.py, services.py, context.py,
            handlers/ (sync, categorize, recurring, ingest_extract)
checkin/    engine and one pure function per finding kind
export/     plan PDF (WeasyPrint, worker only), calendar
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
  the next revision (`0003_documents`) revises `0006_webhook_fn`.

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
- Plaid fixtures in `tests/fixtures/plaid/` are hand-written in Plaid's
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
cd api && uv run alembic upgrade head               # or `make migrate`
docker build -f api/Dockerfile -t first-paycheck-api .   # from the repo root
```
