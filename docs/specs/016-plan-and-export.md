# 016: The plan, its calendar file and the PDF export

Status: Implemented, M9 (backend). The web Plan screen reads `GET /plan` and downloads the two files.

## Goal

Show the user their whole plan in one read: the current version of every saved decision with the figures the calculator produced and whether its explanation was verified, their goals, what is due in the next 90 days and the pay stub the plan was built on. Give them the same plan as a printable PDF and their decision calendar as an iCalendar file they can import into any calendar app. Nothing here computes money: every figure is a field a calculator already produced, copied by its path. Code: `api/app/plan.py` (assembly and response models), `api/app/routers/plan.py` (routes), `api/export/` (`calendar.py` for the `.ics` text, `store.py` for `plan_exports`, `html.py` and `templates/plan.html.j2` for the page, `pdf.py` for WeasyPrint), `api/jobs/handlers/plan_export.py` (the `plan.export` job) and migration `0013_plan_export_job`.

## Inputs

| Route | Input |
|---|---|
| `GET /plan` | None. Today is the request's UTC date (`Now`). |
| `GET /plan/calendar.ics` | None. `DTSTAMP` is the request's time (`Now`). |
| `POST /plan/export` | None (no body). |
| `GET /plan/export/{job_id}` | `job_id` (uuid): the job `POST /plan/export` returned. |

The data read, all under the user's RLS session: `current_decisions` and `decisions`, `explanations`, `irs_citations`, `goals` with the linked account's latest `balance_snapshots` row, `calendar_events`, `pay_stubs`, `jobs` and `plan_exports`.

## Outputs

### `GET /plan` returns `PlanOut`

| Field | Type | Meaning |
|---|---|---|
| `as_of` | date | Today (UTC). |
| `calendar_through` | date | `as_of + 90 days`, the last due date `calendar` includes. |
| `completeness` | `PlanCompleteness` | `saved` and `missing`: lists of `calculator_kind`, each in enum order (`emergency_fund`, `k401_match`, `health_plans`, `w4`). |
| `decisions` | list of `PlanDecision` | One per saved calculator, in enum order: `id`, `calculator`, `version`, `created_at`, `inputs`, `result` (as stored, spec 007 rule 3), `figures` and `explanation`. |
| `goals` | list of `GoalOut` | Exactly what `GET /goals` returns (spec 011 rule 15). |
| `calendar` | list of `CalendarEventOut` | Upcoming events due from `as_of` to `calendar_through`, inclusive. |
| `pay_stub` | `PlanPayStub` or null | The newest confirmed pay stub: `id`, `employer_name`, `pay_frequency`, `pay_date`, `gross_cents`, `federal_withholding_cents`, `social_security_cents`, `medicare_cents`, `state_tax_cents`, `retirement_contribution_cents`, `medical_premium_cents`, `other_deductions_cents`, `net_cents`. |

`PlanFigure`: `key` (where the value comes from: `inputs.<field>` or `result.<field>`, with `[i]` for a list item), `label` (plain words), `kind` (`money`, `percent`, `count` or `text`) and `value` (integer cents, a two-place percentage string, an integer, a string, or null).

`PlanExplanation`: `status` (`verified`, `fallback` or `none`), `id`, `concept`, `text`, `created_at` (all null for `none`) and `citations` (`CitationOut`: `key`, `title`, `url`, `passage`, `source`; empty for `none`).

### `GET /plan/calendar.ics`

`200`, `Content-Type: text/calendar; charset=utf-8`, `Content-Disposition: attachment; filename="first-paycheck-calendar.ics"`, the body per rules 12-17.

### `POST /plan/export`

`202` with `PlanExportQueued`: `job_id`. The client polls `GET /jobs/{job_id}` (spec 002) until `succeeded`.

### `GET /plan/export/{job_id}`

`200`, `Content-Type: application/pdf`, `Content-Disposition: attachment; filename="first-paycheck-plan-<YYYY-MM-DD>.pdf"` (the export's UTC creation date), the PDF bytes. `404 not_found` otherwise (rule 22).

## Rules

### `GET /plan`

1. **One read, no arithmetic.** The route opens one RLS session and copies fields. It adds, subtracts, multiplies and divides no amount; a total the plan needs belongs in the calculator that owns it, with its own tests. Dates are moved only by `calendar_through = as_of + 90 days`.
2. **Decisions.** The rows of `current_decisions`, in `calculator_kind` order, with `inputs` and `result` exactly as stored. `completeness.saved` lists their calculators; `missing` lists the rest.
3. **Figures** are chosen per calculator. The stored `result` (and `inputs`) are validated with the calculator's registered models (`calc/registry.py`) and the listed fields copied. Each figure's `value` equals the field its `key` names, so a test can check every figure by following its key.

    | Calculator | Figures, in order (`key`: label, kind) |
    |---|---|
    | `emergency_fund` | `result.target_cents`: Target, money; `inputs.monthly_contribution_cents`: Monthly contribution, money; `result.per_paycheck_contribution_cents`: Per paycheck, money; `result.months_to_target`: Months to target, count (null when not reachable in `horizon_months`); `result.funded_pct`: Funded today, percent |
    | `k401_match` | `inputs.contribution_pct`: Your contribution, percent; `result.full_match_pct`: Contribution for the full match, percent; `result.employer_match_cents_current`: Employer match a year, money; `result.missed_cents`: Match missed a year, money |
    | `health_plans` | for the selected plan `i = result.selected_index`: `result.plans[i].name`: Plan, text; `result.plans[i].<usage>_cost_cents` with `<usage> = inputs.expected_usage`: Expected cost a year at <usage> use, money; `result.plans[i].annual_premium_cents`: Premiums a year, money; `result.plans[i].worst_case_cents`: Worst case a year, money |
    | `w4` | `result.withholding_per_paycheck_cents`: Federal withholding per paycheck, money; `result.projected_tax_after_credits_cents`: Projected federal tax for <tax_year>, money; `result.projected_refund_cents`: Projected refund (negative is owed), money; then, when `result.suggestion` is `increase_extra_withholding` or `decrease_extra_withholding`, `result.suggested_extra_withholding_cents`: Suggested Step 4(c) extra withholding per paycheck, money; when it is `increase_deductions`, `result.suggested_deductions_cents`: Suggested Step 4(b) deductions, money |

4. **Explanation status** comes from the decision's latest `explanations` row by `(created_at, attempt)` (spec 008 rule 19): `verified` when it is verified, `fallback` when it is the fallback, `none` when there is no row (or, which a finished run never leaves, a row that is neither). `citations` are that row's keys resolved against the decision's calculator and `tax_year` (`retrieval.citations.for_calculator` and `by_key`): unknown keys are skipped, the row's order is kept.
5. **Goals** are built by the same function as `GET /goals`, oldest first.
6. **Calendar.** `upcoming` events with `as_of <= due_at <= calendar_through`, ordered by `due_at`, then `kind` (enum order), then `id`. Done and dismissed events are left out.
7. **Pay stub.** The confirmed pay stub with the greatest `pay_date` (ties: the newest `created_at`), or null when there is none.
8. **RLS.** Every read is the user's; another user's rows are invisible, so a user with none sees an empty plan.

### PDF export

9. **Queue.** `POST /plan/export` enqueues `plan.export` for the user with payload `{}` (spec 001 rule 28) through `jobs.queue.enqueue_unless_queued`, so a second click while one is waiting returns the same job.
10. **The job** (`jobs/handlers/plan_export.py`) reads the plan with `app.plan.build_plan` in one user session (`ctx.user_session()`, RLS), as of the job clock's UTC date (`Services.clock`), renders it with no session open, and stores the bytes in a second user session. Its result is `{"size_bytes": n}`. A rerun of the same job (a stale requeue after the bytes were stored) keeps the first export and renders nothing.
11. **Template.** `api/export/templates/plan.html.j2` (Jinja2, autoescaped) renders `PlanOut` and the export time. Page 1 is the plan: the title, the employer and preparation date, the pay stub's figures, each saved decision with its version, figures and explanation status, the calculators still missing, and the goals. Page 2 starts with the decision calendar (rule 6's events) and then "Why, with sources": for each decision with an explanation, its concept and text and, for every citation, the title, the IRS document name and the full URL printed as text. Money is written `$1,234.56` (`verify.format.dollars`), percentages `4%` (`verify.format.percent`), dates `Oct 31, 2026`. The page carries no ids and no timestamps other than the preparation date, so the same plan renders to the same HTML.
12. **Print-safe Ledger look.** Ink `#16181D` text on white, secondary text `#3F4650` and `#5B6370`, hairlines `#D0D3D9`; no background fills, shadows, images or screenshots; US Letter with 0.6 in margins; `"DejaVu Sans"` first in the font stack (the Docker image installs `fonts-dejavu-core`); a footer with "Page n of m".
13. **Rendering** is `export/pdf.py:render_pdf(html) -> bytes`, which imports WeasyPrint inside the function. Only the worker calls it; the API process never imports `weasyprint`, `export.pdf` or `export.html` (`tests/unit/test_boundaries.py`).
14. **Storage.** `plan_exports` (migration `0013_plan_export_job`): `job_id uuid` primary key, `user_id` (as convention), `bytes bytea NOT NULL` with `CHECK (octet_length(bytes) > 0)`, `content_type text NOT NULL` with `CHECK (content_type = 'application/pdf')`, `created_at timestamptz NOT NULL DEFAULT now()`; foreign key `(job_id, user_id) -> jobs(id, user_id) ON DELETE CASCADE`, for which `jobs` gains `UNIQUE (id, user_id)`; index `(created_at)` for retention. `enable_rls("plan_exports", privileges=("SELECT", "INSERT"))`. `export/store.py` is the only module that touches the table.
15. **Retention.** The scheduler tick deletes exports older than 7 days (`export/store.py:expire_old(connection, now)`, on the scheduler's privileged connection), as it expires unconfirmed uploads (spec 004 rule 21).
16. **Download.** `GET /plan/export/{job_id}` returns the bytes when, under RLS, the job exists, is a `plan.export` job, has `succeeded`, and its export row still exists. Anything else, including another user's job, is `404 not_found`.
17. **The job kind.** `job_kind` gains `plan.export` (migration `0013_plan_export_job`, which also creates the table). The downgrade drops the table, deletes `plan.export` jobs and rebuilds `job_kind` with its earlier labels.

### `GET /plan/calendar.ics` (RFC 5545)

18. **All events.** Every `calendar_events` row of the user, in any status, ordered by `due_at`, `kind`, `id`, so a re-import updates or cancels what an earlier import added.
19. **Calendar.** `BEGIN:VCALENDAR`, `VERSION:2.0`, `PRODID:-//First Paycheck//Plan calendar//EN`, `CALSCALE:GREGORIAN`, `METHOD:PUBLISH`, `X-WR-CALNAME:First Paycheck`, the events, `END:VCALENDAR`.
20. **Event.** `BEGIN:VEVENT`, `UID:<event id>@first-paycheck`, `DTSTAMP:<now, UTC, YYYYMMDDTHHMMSSZ>`, `DTSTART;VALUE=DATE:<due_at, YYYYMMDD>` (an all-day event; with no `DTEND` it lasts that one day, RFC 5545 section 3.6.1), `SUMMARY:<title>`, `DESCRIPTION:<the kind's sentence>`, `STATUS:CANCELLED` for a dismissed event and `STATUS:CONFIRMED` otherwise, `END:VEVENT`. Each `calendar_kind` has one fixed sentence in `export/calendar.py`; a kind without one is an error, so a new kind cannot ship without its text.
21. **Text values** escape `\` as `\\`, `;` as `\;`, `,` as `\,` and a newline as `\n` (section 3.3.11).
22. **Lines** end in CRLF. A content line longer than 75 octets of UTF-8 is folded: CRLF and one space are inserted before octet 76 and then every 74 octets, never inside a multi-octet character (section 3.1). Nothing else is generated: the standard library writes it, so the API gains no dependency.

## Hand-worked examples

The plan user (`api/tests/support/plan_user.py`), with the request clock at 2026-10-21 15:00 UTC: a semimonthly profile with a $65,000.00 salary; the Confirm mockup's pay stub (Acme Corp, paid 2026-10-15, gross $2,708.33, net $1,996.04) plus an older one paid 2026-09-30; an emergency-fund savings account holding $2,140.00; and four decisions saved through `POST /decisions`:

- `emergency_fund`: essentials $1,823.00 a month, 3 months, balance $2,140.00, $300.00 a month, 24 periods. Target `182,300 * 3 = 546,900`; shortfall `546,900 - 214,000 = 332,900`; `11 * 30,000 = 330,000 < 332,900 <= 12 * 30,000`, so 12 months; funded `214,000 / 546,900 = 39.129...%`, 39.13; per paycheck `30,000 * 12 / 24 = 15,000`.
- `k401_match`: v1 at 3%, then v2 at 4% (salary $65,000.00, 24 periods, 100% of the first 4%, single, age 25). v2's full-match percentage is 4.00, its match `6,500,000 * 4% = 260,000` and nothing is missed.
- `health_plans`: spec 012's Bronze HSA and Gold PPO at 24 periods, medium use, Bronze selected, enrollment deadline 2026-11-14.
- `w4`: single, 24 periods, 4% to the 401(k), $25.00 premium per paycheck.

Explanations are written directly: the 401(k) v2 has an unverified attempt 1 and then a verified attempt 2 citing `k401.employer_match` and `k401.deferral_limit`; the health decision has a fallback citing `health.hsa_limit`; the W-4 has a verified row citing `w4.percentage_method`; the emergency fund has none.

The next pay date is 2026-10-31 (semimonthly, anchored on the 15th, spec 007 rule 16), so the calendar holds: goal contribution 2026-10-31, election check 2026-10-31 (v2's; v1's is dismissed), W-4 submit 2026-10-31, enrollment deadline 2026-11-14, and the goal review `add_months(2026-10-31, 3) = 2027-01-31`, which is after `calendar_through = 2026-10-21 + 90 days = 2027-01-19`.

### `GET /plan` (`api/tests/integration/test_plan.py`)

| # | Test | Setup | Expected |
|---|---|---|---|
| 1 | `test_plan_for_a_new_user_is_empty` | No data | `decisions`, `goals`, `calendar` empty; `pay_stub` null; `missing` is all four calculators; `calendar_through` 2027-01-19 |
| 2 | `test_plan_lists_current_decisions_in_calculator_order` | Plan user | Four decisions, `emergency_fund, k401_match, health_plans, w4`; the 401(k) is version 2 with `contribution_pct` "4.00"; `missing` empty |
| 3 | `test_every_figure_is_the_field_its_key_names` | Plan user | Each figure's value equals the field at its key; the emergency fund's are 546,900, 30,000, 15,000, 12 and "39.13"; the 401(k)'s "4.00", "4.00", 260,000, 0 |
| 4 | `test_health_figures_follow_the_selected_plan_and_usage` | Plan user | Keys `result.plans[0].name`, `result.plans[0].medium_cost_cents`, ...; the first value is "Bronze HSA" |
| 5 | `test_w4_suggestion_figure_matches_the_suggestion` | W-4 decisions with each suggestion | Step 4(c) figure for the withholding suggestions, Step 4(b) for deductions, neither for `none` |
| 6 | `test_explanation_status_from_the_latest_row` | Plan user | 401(k) `verified` with two citations in row order and their irs.gov URLs; health `fallback`; W-4 `verified`; emergency fund `none` with no citations |
| 7 | `test_calendar_is_the_next_90_days_of_upcoming_events` | Plan user | Four events: 2026-10-31 goal contribution, election check, W-4 submit (kind order), 2026-11-14 enrollment deadline; no review, no dismissed v1 check |
| 8 | `test_pay_stub_is_the_newest` | Plan user | `pay_date` 2026-10-15, gross 270,833, net 199,604 |
| 9 | `test_goals_match_get_goals` | Plan user | `goals` equals `GET /goals`: target 546,900, balance 214,000, progress "39.13" |
| 10 | Cross-user (`tests/rls/test_cross_user.py`) | A is the plan user | B's `GET /plan` is empty |

### Calendar file (`api/tests/unit/export/test_calendar.py`, `api/tests/integration/test_plan_calendar.py`)

| # | Test | Setup | Expected |
|---|---|---|---|
| 11 | `test_calendar_file_matches_the_fixture` | Four events inserted with fixed ids: an upcoming election check 2026-10-31, a dismissed one 2026-10-31, a done W-4 submit 2026-10-15, an enrollment deadline 2026-11-14 titled `Health plan enrollment deadline; Acme, 2027 plans` | Byte for byte `api/tests/fixtures/export/calendar.ics`; `DTSTAMP:20261021T150000Z` |
| 12 | `test_long_lines_fold_at_75_octets` | A 200-character summary | Every physical line is at most 75 octets; unfolding (removing CRLF + space) gives the original line |
| 13 | `test_folding_never_splits_a_character` | A summary of `é` (2 octets each) | Every physical line decodes as UTF-8 and is at most 75 octets |
| 14 | `test_text_is_escaped` | `a\b;c,d` and a newline | `a\\b\;c\,d\n` |
| 15 | `test_every_calendar_kind_has_a_description` | Each `CalendarKind` | A non-empty sentence |
| 16 | Cross-user | A has events | B's file has no `VEVENT` |

### Export (`api/tests/integration/export/`)

| # | Test | Setup | Expected |
|---|---|---|---|
| 17 | `test_export_queues_one_job` | Plan user posts twice | 202 twice, the same `job_id`; one queued `plan.export` job with payload `{}` |
| 18 | `test_download_is_404_until_the_job_succeeds` | Queued job | 404; after the worker runs it, 200 |
| 19 | `test_html_matches_the_fixture` | Plan user, export time 2026-10-21 15:00 UTC | `render_html` equals `api/tests/fixtures/export/plan.html` byte for byte |
| 20 | `test_pdf_has_two_pages_and_the_plan_text` | Plan user, the worker runs the job | 200, `filename="first-paycheck-plan-2026-10-21.pdf"`, 2 pages; page 1 has "Acme Corp", "$5,469.00", "Bronze HSA"; page 2 has the citation URLs |
| 21 | `test_export_job_reads_as_its_user` | A is the plan user; B exports | B's row belongs to B; B's PDF has none of A's figures; B can download it, A cannot |
| 22 | `test_tick_deletes_week_old_exports` (`api/tests/integration/test_retention.py`) | Exports created 8 days, 7 days plus 1 second, and 6 days before the tick | The first two are deleted (older than `now - 7 days`), the third stays |
| 23 | Cross-user | A's succeeded export | B's `GET /plan/export/{A's job}` is 404; B's `POST /plan/export` queues B's own job and leaves A's untouched |

## Edge cases

- A user with no decisions still gets a plan (rule 8) and a calendar file with no events; the PDF says no decisions are saved yet.
- A decision without an explanation has `status = none` and no citations.
- A health-plan decision always has a selected plan (spec 012 rule 14); an emergency fund that is not reachable has a null months figure and the PDF prints "Not within 10 years".
- A job id that is not a `plan.export` job (for example an `ingest.extract` the user owns) is 404 from the download route.
- An export past 7 days is gone: the download is 404 and the user exports again.
- A WeasyPrint failure fails the job, which backs off and retries (spec 002); nothing is stored.

## Out of scope

- Emailing the PDF ("Email me a copy" in the mockup).
- A `.ics` subscription URL: the file is a one-off download, so a change needs a new import (the stable `UID` makes it an update).
- Recurring events (`RRULE`), alarms (`VALARM`) and time zones: every event is an all-day date.
- Check-in findings and the decision version history in the PDF; the web Plan screen shows history from `GET /decisions`.
