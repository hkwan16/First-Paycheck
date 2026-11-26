# Quality numbers

What the test suites, the coverage reports and the eval suites say about First Paycheck, measured on November 26, 2026 at `main` commit `a3946d5`, on a MacBook without Tesseract or WeasyPrint's libraries. The page answers two course rubric lines: document coverage, and evaluate the project against the success metrics in `docs/technical-spec.md` section 5. Every number below comes from a command named beside it or a file named beside it.

## Test suites

| Layer | Where it lives | Count | Runs where, needs what |
|---|---|---|---|
| API unit | `api/tests/unit/` | 1,835 collected | Locally and in CI (`api-test`); no database, no network. 10 skipped here: 9 OCR tests without Tesseract, 1 without live credentials. |
| API integration | `api/tests/integration/` | 912 collected | Locally against `TEST_DATABASE_URL` (a disposable Postgres) and in CI against a Postgres 16 service. 7 skipped here: 5 plan PDF tests without WeasyPrint's pango, 2 OCR tests without Tesseract. |
| RLS cross-user | `api/tests/rls/` | 51 collected | Same as integration. Every user route is attempted by user B on user A's data; a meta-test fails when a route has no case. |
| Hypothesis properties | `api/tests/unit/calc/` | 45 `@given` tests in 12 files, counted in the unit total | Locally and in CI; the profiles are in `api/tests/support/hypothesis_profiles.py`. |
| Eval runner tests | `evals/tests/` | 160 collected | Locally and in CI (`api-test` runs every pytest path). The extraction-smoke tests need Tesseract. |
| Script tests | `scripts/tests/` | 80 collected | Locally and in CI. |
| Eval suites | `evals/suites/`, 11 suites | 6 free, 5 LLM (cases per suite are in the scorecard below) | Free suites locally (`make eval`), in CI (`evals-free`, Tesseract installed) and nightly; LLM suites locally with an Anthropic key (`make eval-llm`). |
| Web unit (Vitest) | `web/src/**/*.test.{ts,tsx}` | 175 files, 1,963 tests | Locally (`pnpm --dir web test`) and in CI (`web-test` in `ci.yml`, `check` in `web.yml`); jsdom, MSW for the API, no browser. |
| Playwright e2e | `web/e2e/*.spec.ts` | 19 spec files, 133 `test(...)` blocks, 68 committed screenshots | Chromium. `web.yml` runs `pnpm e2e` in the Playwright Linux image; without the sign-in variables that is the smoke project (`smoke.spec.ts`: axe accessibility checks and screenshot comparison over every screen and the dev kit's sample screens). `e2e.yml` runs the real-API projects (`alpha`, `authenticated*`, `persons-day`) against the API, the worker, an auth stand-in and Postgres through `scripts/e2e_stack.py`, the same harness as `make e2e-full`; the Plaid link steps need the sandbox secrets. `spending.spec.ts` also runs axe. |

Totals from the commands used:

- `uv run pytest --collect-only -q -p no:cacheprovider -m "not plaid_sandbox and not llm_live" api/tests evals/tests scripts/tests`: 3,038 tests collected, 6 deselected (3,044 in all). The deselected tests are the live Plaid sandbox test module (`plaid_sandbox`) and the live gateway test module (`llm_live`), which never run by default.
- `uv run pytest api/tests -m "not plaid_sandbox and not llm_live" -q -p no:cacheprovider --cov=api --cov-report=term-missing`: 2,781 passed, 17 skipped, 6 deselected in 3 minutes 49 seconds. The 17 skips are the 11 OCR tests (Tesseract is not installed here; they run in the `ingest-in-docker` CI job and in `api-test`, which installs Tesseract), the 5 plan PDF tests (WeasyPrint cannot load pango on this machine; they run in CI) and 1 test that needs live credentials.
- `pnpm --dir web test:coverage`: 175 files, 1,963 tests passed in 65.6 seconds.
- The Playwright counts are static: `ls web/e2e/*.spec.ts | wc -l` and a grep for `test(` lines. The e2e projects were not run for this page; CI runs them on every pull request.

## Coverage

Measured on November 26, 2026 with the commands shown. `make coverage` runs both.

### API (Python)

```
uv run pytest api/tests -m "not plaid_sandbox and not llm_live" -q -p no:cacheprovider --cov=api --cov-report=term-missing
```

Result: **98%** as coverage.py reports it with `branch = true` (statements and branch arcs together): 10,185 statements, 191 missed; 1,764 branches, 85 partial. Statements alone: 9,994 of 10,185 executed, 98.1%. The configuration is in `pyproject.toml` under `[tool.coverage.*]`: branch coverage on, `api/tests/*` omitted, `if TYPE_CHECKING:` and `__main__` blocks excluded. CI's `api-test` job runs the same measurement over every pytest path with `--cov-fail-under=85` and prints the terminal report in the job log; nothing is published as an artifact.

Modules with five or more missed statements, from the `term-missing` report:

| Module | Statements | Missed | Cover | Why it is uncovered here |
|---|---|---|---|---|
| `api/app/serve.py` | 87 | 19 | 78% | The one-container process supervisor for Render: signal forwarding to the children, the wait-and-kill loop, `supervise()` and `main()`. Tests drive `Supervisor` with fake child commands; the real signal path runs only in production. |
| `api/ingest/ocr.py` | 30 | 16 | 41% | The Tesseract call (lines 33-63). The OCR tests skip without the binary and run in the `ingest-in-docker` job against the image's pinned Tesseract. |
| `api/ingest/pipeline.py` | 70 | 16 | 73% | `_prepare_image` and `_png`, the image page path (OCR, redact the image, shrink the PNG for the model). Same reason. |
| `api/jobs/handlers/plan_export.py` | 23 | 13 | 37% | The plan PDF job. WeasyPrint needs pango, which this machine lacks; the five plan PDF tests skip here and run in CI and in the Docker job. |
| `api/app/deps.py` | 138 | 13 | 90% | The "Plaid is not configured" and "token encryption is not configured" branches of the dependency providers, which only a misconfigured deployment reaches. |
| `api/llm/gateway.py` | 326 | 9 | 97% | Live-only branches and `FakeGateway`'s missing-fixture errors. The live gateway tests are behind the `llm_live` marker. |
| `api/sync/plaid/client.py` | 119 | 7 | 93% | Network and non-JSON error handling around the Plaid SDK. The live sandbox test module is behind the `plaid_sandbox` marker; the rest of the provider is tested with recorded responses. |
| `api/alembic/env.py` | 34 | 6 | 78% | Offline mode (`alembic upgrade --sql`) and the logging setup; the migration tests run online. |
| `api/calc/data/__init__.py` | 113 | 6 | 92% | Error branches for a malformed or missing tax-year constants file. |
| `api/db/seed/load.py` | 148 | 6 | 95% | The `main()` entry and a few error branches; tests call `load()` directly. |
| `api/jobs/worker.py` | 93 | 5 | 95% | The heartbeat thread's failure log and the main loop's "queue unreachable" back-off. |
| `api/sync/plaid/webhook.py` | 71 | 5 | 93% | Error branches in webhook handling. |
| `api/export/pdf.py` | 10 | 4 | 60% | `render_pdf`, the WeasyPrint call; same reason as the plan PDF job. |

Every other module in the report misses four statements or fewer, and a module not in the report is fully covered (`skip_covered = true`). `api/calc/`, where the money math lives, misses 9 statements in all, none of them arithmetic: the six file-loading errors in `calc/data/__init__.py` above and one `ValueError` guard each in `cashflow.py` (an unbalanced diagram), `emergency_fund.py` (a target of zero or less) and `net_worth.py` (fewer than one month).

### Web (TypeScript)

```
pnpm --dir web test:coverage
```

Result: **97.57% of statements** (4,789 of 4,908), 93.77% of branches (3,885 of 4,143), 98.23% of functions (1,506 of 1,533), 98.28% of lines (4,236 of 4,310). The provider is `@vitest/coverage-v8`, configured in `web/vitest.config.mts`: `src/**` is measured, minus the tests, `src/test/` (MSW handlers and setup), `src/app/dev/` (the sample screens the smoke tests photograph) and the generated `src/lib/api/schema.d.ts`. The reporters are `text` and `json-summary` (`web/coverage/coverage-summary.json`, git-ignored). Nothing runs this in CI yet.

Files below 90% of statements:

| File | Statements | Missed | Cover | Why |
|---|---|---|---|---|
| `src/components/screens/spending/FlowDetails.tsx` | 60 | 13 | 78.3% | Branches of the cash-flow detail panel. `web/e2e/spending.spec.ts` drives the diagram's nodes in a browser. |
| `src/components/ui/DropZone.tsx` | 43 | 5 | 88.4% | The drag-over and drag-leave handlers (lines 73-75 and 90); the unit tests deliver files through the input. |
| `src/components/screens/dev-kit/KitGallery.tsx` | 20 | 3 | 85.0% | The dev kit's gallery (lines 144 and 613); the smoke spec photographs `/dev/kit`. |
| `src/app/auth/sign-out/route.ts` | 14 | 2 | 85.7% | The cookie callbacks handed to the Supabase server client (lines 29-31), which Supabase calls, not the test. |
| `src/components/screens/check-in/NetWorthChart.tsx` | 15 | 2 | 86.7% | Two statements in the chart; not examined for this page. |
| `src/app/(app)/error.tsx` | 9 | 1 | 88.9% | The server snapshot of `useSyncExternalStore` (line 30), which returns null where there is no `window`; jsdom always has one. |
| `src/components/screens/confirm/MathNotice.tsx` | 8 | 1 | 87.5% | The `none` case, which renders nothing (line 37). |
| `src/components/screens/why/Sources.tsx` | 4 | 1 | 75.0% | One branch in the citation list; `web/e2e/why.spec.ts` renders the full card. |
| `src/lib/navigation.ts` | 2 | 1 | 50.0% | `reloadPage()`, a one-line wrapper over `window.location.reload()`. |
| `src/app/(app)/layout.tsx`, `src/app/(auth)/layout.tsx` | 1 each | 1 each | 0% | Route-group layouts, rendered by Next.js, not by Vitest; the e2e specs load them. |

## Eval scorecard

The spec's section 5 lists nine success metrics. Seven are measured by the eval suites in `evals/`; the committed values are in `evals/baseline.json`, and `make eval` and `make eval-llm` compare a run against them. Two need people and are not measured.

| Spec metric | Target | Measured (`evals/baseline.json`) | Suite and cases | Met |
|---|---|---|---|---|
| Extraction accuracy | At least 95% of fields over 30 labeled synthetic stubs, offers and benefit summaries | `extraction`: `field_accuracy` 1.0, `document_accuracy` 1.0. `benefits-extraction`: `plan_field_accuracy` 1.0, `retirement_accuracy` 1.0, `document_accuracy` 1.0 | `extraction` (LLM): 34 labeled pay stubs in `evals/fixtures/pay_stubs/` (68 files: 34 documents, a JSON label beside each; 13 scored fields a stub, 442 fields). `benefits-extraction` (LLM): 5 labeled summaries in `evals/fixtures/benefits/` (10 files). 39 labeled documents, which meets the 30 the spec asks for. There are no offer letter fixtures. | Yes |
| Transaction categorization accuracy | At least 90% over 500 labeled transactions | `categorization`: `accuracy` 1.0, `llm_accuracy` 1.0. `categorization-rules`: `rules_precision` 1.0, `rules_coverage` 0.7806 | `categorization` (LLM) and `categorization-rules` (free) over `evals/fixtures/transactions.csv`: 547 rows (500 generated from a fixed seed, 47 written by hand). The seed rules alone label 78.06% of the rows with no mistakes; the rest, 34 merchants and 120 rows, go to the model. | Yes |
| Recurring charge detection | At least 90% precision and recall on seeded Plaid sandbox accounts with known subscriptions | `recurring`: `precision` 1.0, `recall` 0.9545, `fields_exact` 1.0 | `recurring` (free): 2 cases, a recorded Plaid sandbox sync page (12 labeled series) and a seeded custom sandbox user (10 labeled series), 22 labeled series in all. Recall is 21 of 22: a utility bill that swings about 22% around its median falls partly outside the 15% series, a known miss recorded in the baseline. Two histories is a thin sample. | Yes |
| Calculator correctness | 100% against hand-worked IRS and plan examples | `calc`: `pass_rate` 1.0 | `calc` (free): 46 cases in `evals/fixtures/calc/` (14 for the 401(k) match, 16 for the W-4, 8 for the emergency fund, 8 for the health plans), each a spec example posted to its HTTP route. A test fails when a spec example table row has no case. | Yes |
| Check-in findings correctness | 100% against seeded scenarios | `checkin`: `precision` 1.0, `recall` 1.0, `fields_exact` 1.0 | `checkin` (free): 22 cases in `evals/fixtures/checkin/scenarios.json`, one per row of spec 015's finder table. | Yes |
| Displayed explanations that cite a source | 100% | `explain`: `cited` 1.0. `explain-w4`: `cited` 1.0 | `explain` (LLM): 31 synthetic 401(k) decisions. `explain-w4` (LLM): 12 synthetic W-4 decisions. The flow is the real draft-verify-retry-fallback path, `verify.flow.run_explain`. | Yes |
| Explanation fallback rate | At most 5% of eval decisions | `explain`: `no_fallback` 1.0. `explain-w4`: `no_fallback` 1.0 (a fallback rate of 0%) | The same 31 and 12 decisions. | Yes |
| Setup finished in 2 sittings or fewer | At least 80% of users, from a user test with 5 to 8 people | Not measured | No eval suite can measure it. The kit for the moderated test (consent, script, quiz, observation sheet) is in `docs/user-test/`; no sessions have been run and `docs/user-test/results.md` does not exist. | Not measured |
| Understanding gain | +2 points on average on a 5-question quiz, before and after setup | Not measured | Same user test; the quiz and its key are `docs/user-test/quiz.md`. | Not measured |

Other metrics the suites record, which are not among the nine spec targets:

| Suite | Metric | Baseline | What it measures |
|---|---|---|---|
| `explain`, `explain-w4` | `first_try_verified` | 1.0, 1.0 | The share of decisions whose first draft passed the number check. |
| `explain` | `rate_framing`, `judge_accuracy` | 1.0, 1.0 | Over the 20 decisions whose stub shows another 401(k) rate or none, the share that does not claim the chosen rate is already in effect, as an LLM judge reads it; and the judge's accuracy over 37 hand-labeled items. |
| `explain-w4` | `withholding_framing`, `judge_accuracy` | 1.0, 1.0 | The same for the W-4 entries' withholding, over 9 decisions and 24 labeled items. |
| `explain`, `explain-w4` | `concise` | 1.0, 1.0 | The share of drafted explanations of at most 150 words (spec 008 rule 24f). |
| `explain` | `whole_dollars` | 1.0 | The share of drafted explanations that write no amount of $100 or more with cents, except an amount per paycheck, which the person checks against the stub to the cent (`evals/suites/readability.py`). |
| `explain-w4` | `whole_dollars` | 0.5833 | The same over the 12 W-4 decisions: the model keeps the cents on some yearly W-4 amounts (7 of 12 drafts are in whole dollars). The verifier accepts both forms, so this measures readability, never gates a draft, and is not a spec target. Two live runs on November 1 measured 0.58 and 0.75; the lower one is recorded. |
| `extraction-smoke` | `pipeline_ok`, `redaction_recall`, `ssn_free` | 1.0, 1.0, 1.0 | Over the 34 stubs with a fake model: every stub yields a proposal, every printed SSN is redacted, and neither the SSN nor the unmasked account number reaches the model input (image pages are OCR'd again to check). Free, zero tolerance. |
| `explain-smoke` | `flow_correct` | 1.0 | Ten scripted draft-verify-retry-fallback scenarios with a fake model. Free. |

How the baselines were measured:

- The free suites (`calc`, `categorization-rules`, `checkin`, `recurring`, `extraction-smoke`, `explain-smoke`) are deterministic and tolerate no drop. They run on every pull request (`evals-free` in `ci.yml`) and every night (`nightly.yml`). `categorization-rules` was last re-baselined on November 11, 2026 over 547 rows.
- The LLM suites' baselines are what live runs measured, not the spec's targets, recorded with `--update-baseline` in commits of their own (`git log -- evals/baseline.json`): extraction, benefits-extraction and categorization on October 29, 2026 (the `docs/ai-log.md` entry "2026-10-29 to 2026-10-31: the live model"); categorization again on `categorize/v3` and explain and explain-w4 on October 30; explain and explain-w4 on `explain/v4` on November 1 (the entry "2026-11-01: the Why page, the plan and the app chrome in plain words"). `evals/CLAUDE.md` records each run's numbers and cost. Two things have changed since without a live run: `categorize/v4` (the `cash` category, November 11) and the two issue 223 decisions in the explain fixtures.
- The nightly workflow runs only the free suites, because `ANTHROPIC_API_KEY` is not a GitHub secret (issue #145). The LLM baselines are therefore checked only when someone runs `make eval-llm` locally.

## How to reproduce

| Command | What it runs | Prerequisites |
|---|---|---|
| `make test` | Every Python test (api, evals, scripts) and the web unit tests | `make setup`; `TEST_DATABASE_URL` in `.env` pointing at a disposable local Postgres for the integration and RLS tests; Tesseract for the OCR tests and `evals/tests` (without it the OCR tests skip and one eval runner test errors); WeasyPrint's libraries (pango) for the plan PDF tests, which skip without them |
| `make coverage` | The API tests with `--cov=api --cov-report=term-missing`, then `pnpm --dir web test:coverage` | The same as `make test` |
| `make eval` | The six free eval suites against `evals/baseline.json` | Tesseract, for `extraction-smoke` |
| `make eval-llm` | The five LLM eval suites, capped at `EVAL_MAX_COST_CENTS` (200 cents by default) | `ANTHROPIC_API_KEY` in `.env`. The first full run of every suite cost $0.77 (`docs/ai-log.md`, October 29); the nightly cap is 300 cents. |
| `make e2e-full` | Playwright against a local API, worker, auth stand-in and Postgres | Chromium (`pnpm --dir web exec playwright install chromium`), `E2E_DATABASE_URL`, and the Plaid sandbox keys for the link steps |

On a Mac, `brew install tesseract` provides the OCR binary. The screenshot baselines were made in the Playwright Linux image, so visual comparison runs in CI or in that image, not on a Mac.
