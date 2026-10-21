# 015: Monthly check-ins, net worth and holdings

Status: Implemented, M8. Every example is a test; the finder scenarios are also the `checkin` eval suite.

## Goal

Once a month, and again whenever a sync lands new data that month, compare the user's newest data with the plan they saved and say what changed: an election that did not reach the pay stub, a savings goal that fell behind, a new, repriced or stopped recurring charge, a change in pay or in a deduction, and a dated checkpoint coming up. Each change is a typed **finding** with a severity, the decision it affects, and a payload of plain numbers the client prints without adding anything. The user marks a finding done or dismissed, or undoes that. The check-in screen also shows the month's cash flow next to the plan's targets, the user's net worth by month, and their newest investment holdings.

Code: pure finders in `api/checkin/findings.py` (one function per kind, `f(facts) -> list[Finding]`), the facts loader in `api/checkin/facts.py`, the engine (pure reconciliation plus the writer) in `api/checkin/engine.py`, the `checkin.monthly` handler in `api/jobs/handlers/checkin.py`, the monthly enqueue in `api/jobs/scheduler.py`, the sync-triggered refresh in `api/jobs/handlers/recurring.py`, routes in `api/app/routers/checkins.py` and `api/app/routers/net_worth.py`, money math in `api/calc/checkin.py`, `api/calc/cashflow.py` (`against_plan`) and `api/calc/net_worth.py`, migration `0012_checkin_findings`, eval suite `evals/suites/checkin.py`.

## Inputs

### Facts (`checkin/findings.py:Facts`, read under RLS by `checkin/facts.py`)

| Field | Type | What it holds |
|---|---|---|
| `period` | date | First day of the check-in's month |
| `today` | date | The job clock's UTC date, capped at the period's last day |
| `pay_stubs` | list, newest first, at most 2 | The two newest confirmed `pay_stubs` by `pay_date`, then `created_at`, then `id` (descending): `id`, `pay_date`, `period_start`, `period_end`, `gross_cents`, the seven deduction columns, `net_cents` |
| `k401` | object or null | The current `k401_match` decision: `decision_id`, `decided_on` (its `created_at` as a UTC date), `contribution_pct` (Decimal) |
| `health` | object or null | The current `health_plans` decision: `decision_id`, `decided_on`, `plan_name` and `premium_per_period_cents` of `inputs.plans[selected_plan_index]` |
| `w4_decision_id` | uuid or null | The current `w4` decision, when there is one |
| `goals` | list | Every `active` goal with a linked account: `id`, `kind`, `decision_id`, `started_on` (the goal's decision's `created_at` as a UTC date, else the goal's own `created_at`), `target_amount_cents`, `monthly_contribution_cents`, `balances` (the linked account's snapshots, oldest first: `as_of` UTC date, `balance_cents`) |
| `recurring` | list | Every `recurring_charges` row with `status` `new`, `changed` or `stopped`: `id`, `merchant` (`merchant_clean`), `cadence`, `status`, `user_status`, `typical_amount_cents`, `first_seen`, `last_seen`, `last_reported_amount_cents` (the `typical_amount_cents` of the newest earlier recurring finding about this charge, or null) |
| `events` | list | `upcoming` `calendar_events` with `today <= due_at <= today + 30 days`: `id`, `kind`, `title`, `due_at`, `decision_id` |

### Routes

| Route | Input |
|---|---|
| `GET /check-ins` | none |
| `GET /check-ins/{id}` | path id |
| `PATCH /check-ins/{id}/findings/{fid}` | `{"user_action": "done" \| "dismissed" \| null}`, the field required, nothing else allowed |
| `GET /net-worth` | `months`, 1-60, default 12: how many calendar months, ending with the current one |
| `GET /holdings` | none |
| `GET /calendar` | `from`, `to`: optional inclusive ISO dates on `due_at`, each on its own; `from > to` is 422 |

## Outputs

### `Finding` (pure) and `FindingOut` (API)

`kind` (`finding_kind`), `severity` (`info`, `warning`, `alert`), `key` (what the finding is about, rule 12), `decision_id` (the decision it affects, or null) and `payload`, one model per kind with `kind` as its discriminator and a common `affects` (`k401_match`, `health_plans`, `emergency_fund`, `w4`, `spending`, or null):

| Kind | Payload fields |
|---|---|
| `election_mismatch` | `calculator` (`k401_match` or `health_plans`), `pay_stub_id`, `pay_date`, `expected_cents`, `actual_cents`, `difference_cents` (actual minus expected), `elected_pct` and `actual_pct` (401(k) only, two places, else null), `plan_name` (health only, else null) |
| `goal_off_pace` | `goal_id`, `started_on`, `start_balance_cents`, `monthly_contribution_cents`, `months_elapsed`, `expected_cents`, `balance_cents`, `balance_as_of`, `shortfall_cents`, `target_amount_cents` |
| `recurring_new`, `recurring_changed`, `recurring_stopped` | `recurring_charge_id`, `merchant`, `cadence`, `typical_amount_cents`, `previous_amount_cents` and `change_cents` (changed only, null when unknown), `first_seen`, `last_seen`, `user_status` |
| `pay_change` | `pay_stub_id`, `pay_date`, `previous_pay_stub_id`, `previous_pay_date`, `gross_cents`, `previous_gross_cents`, `gross_change_cents`, `net_cents`, `previous_net_cents`, `net_change_cents` |
| `deduction_change` | the four stub fields of `pay_change`, `line` (a `calc/cashflow.py` line key), `label`, `amount_cents`, `previous_cents`, `change_cents` |
| `upcoming_deadline` | `calendar_event_id`, `calendar_kind`, `title`, `due_at`, `days_until` |

`FindingOut` adds `id`, `check_in_id`, `user_action` (`done`, `dismissed` or null), `user_action_at`, `created_at`, `updated_at`.

### Check-ins

- `GET /check-ins`: `CheckInSummary` items, newest `period` first: `id`, `period`, `triggered_by`, `status` (`open`, `completed`), `completed_at`, `finding_count`, `handled_count` (findings with a user action), `created_at`, `updated_at`.
- `GET /check-ins/{id}`: `CheckInDetail`, the summary plus `findings` (ordered by severity `alert`, `warning`, `info`, then kind in enum order, then `created_at`, `id`) and `cash_flow`: `CheckInCashFlow` with `cash_flow` (exactly what `GET /cashflow` returns for `start = period`, `end = min(last day of period, today)`) and `plan`, a list of `PlanLine` (`key`, `label`, `actual_cents`, `plan_cents` or null, `difference_cents` = actual minus plan, or null).
- `PATCH /check-ins/{id}/findings/{fid}`: the updated `FindingOut`.
- Job result of `checkin.monthly`: `{"outcome": "created" | "refreshed" | "skipped", "check_in_id", "inserted", "updated", "retracted", "dropped", "marked_active"}`.

### Net worth and holdings

- `GET /net-worth` (`NetWorthOut`): `as_of` (date of the newest snapshot used, or null), `assets_cents`, `liabilities_cents`, `net_worth_cents`, `change_cents` (the last series point's net worth minus the first's, null with fewer than two points), `accounts` (each active account with a snapshot, by name: `account_id`, `name`, `mask`, `kind`, `role`, `institution_name`, `side` `asset` or `liability`, `balance_cents`, `balance_as_of`), `by_kind` (one row per kind present, in `account_kind` order: `kind`, `side`, `total_cents`) and `series` (one point per month with data: `month` first day, `as_of` cutoff, `assets_cents`, `liabilities_cents`, `net_worth_cents`).
- `GET /holdings` (`HoldingsOut`): `accounts`, each active investment or retirement account with holdings, by name: `account_id`, `name`, `mask`, `kind`, `as_of` (its newest holdings date), `value_cents`, `cost_basis_cents`, `gain_cents`, and `holdings` (`security_id`, `name`, `ticker`, `quantity` as a decimal string, `value_cents`, `cost_basis_cents`, `gain_cents`), plus `value_cents`, `cost_basis_cents` and `gain_cents` over every account.

## Rules

### Finders (`checkin/findings.py`, pure)

Each finder is `f(facts) -> list[Finding]`, with no I/O and no clock. `all_findings` runs them in the order below and fails on a repeated key. Every amount a finder reports is computed by `calc/checkin.py` (integer cents, `Decimal` rates, one `round_half_up`); the finders compare the cents they are handed, and do date arithmetic themselves.

1. **401(k) election.** Uses the newest stub, and only when its `period_start > k401.decided_on` (a whole pay period after the election was saved). `expected = round_half_up(gross * contribution_pct / 100)`. A finding when `|actual - expected| > 1` cent (payrolls round differently), where `actual = retirement_contribution_cents`. Severity `alert`. `actual_pct = actual / gross * 100`, two places half up. Affects `k401_match`. Key `election_mismatch:k401_match:{decision_id}:{pay_stub_id}`.
2. **Health plan election.** Same stub rule against `health.decided_on`. `expected = premium_per_period_cents`, `actual = medical_premium_cents`, a finding when they differ at all. Severity `warning`. Affects `health_plans`. Key `election_mismatch:health_plans:{decision_id}:{pay_stub_id}`.
3. **Goal off pace.** For each goal with at least one balance: the start balance is the newest balance with `as_of <= started_on`, else the oldest balance; the current balance is the newest. `months_elapsed` is the largest `k >= 0` with `add_months(started_on, k) <= current.as_of` (the current balance's own date, so stale data is judged at its date). `expected = start + monthly_contribution * months_elapsed`; `shortfall = expected - current`. A finding when `shortfall > 0` and `current < target_amount_cents` (a goal at or past its target is never behind). Severity `warning`. Affects `emergency_fund` for an emergency-fund goal, else null. Key `goal_off_pace:{goal_id}:{period}`, so it is judged again each month.
4. **Recurring charges.** Charges with `user_status = ignored` are skipped (spec 009 rule 17). Status `new`: `recurring_new`, `warning`. Status `changed`: `recurring_changed`; `previous_amount_cents = last_reported_amount_cents`, `change_cents = typical - previous` when known; `info` when `change_cents < 0`, else `warning`. Status `stopped`: `recurring_stopped`, `info` (with `user_status = cancelled` it confirms a cancellation). Affects `spending`, no decision. Keys `{kind}:{charge_id}:{last_seen}`.
5. **Pay change.** With two stubs, a finding when `gross_cents` differs: `warning` when it fell, `info` when it rose. Affects `w4` (withholding follows pay) with the current `w4` decision. Key `pay_change:{newest_stub_id}`.
6. **Deduction change.** With two stubs, one finding per changed line among `federal_withholding`, `state_tax`, `retirement_contribution`, `medical_premium` and `other_deductions`, in that order; Social Security and Medicare are fixed shares of gross and are covered by rule 5. Severity `info`. Affects `w4`, null, `k401_match`, `health_plans` and null respectively, with that calculator's current decision. Key `deduction_change:{newest_stub_id}:{line}`.
7. **Upcoming deadline.** One finding per fact event: `days_until = due_at - today`; `warning` when `days_until <= 7`, else `info`. Affects by calendar kind: `election_check` `k401_match`; `enrollment_deadline` and `open_enrollment` `health_plans`; `goal_contribution`, `goal_review` and `goal_target` `emergency_fund`; `tax_season` `w4`. `decision_id` is the event's. Key `upcoming_deadline:{event_id}`.

### Engine (`checkin/engine.py`)

8. **One check-in per user and month.** The `checkin.monthly` job with `trigger = schedule` gets or creates the user's `check_ins` row for its `period` (`triggered_by = schedule`; the partial unique index makes a second one impossible), then refreshes it. A job with `trigger = sync` only refreshes that row when it exists and is `open`; otherwise its outcome is `skipped`.
9. **Refresh.** Load the facts, run `all_findings`, reconcile (rule 10) and write, in one user session under RLS, holding a per-user transaction advisory lock (`checkin:{user_id}`) and then the recurring detector's (`recurring.detect:{user_id}`, spec 009 rule 15), so two refreshes, or a refresh and a detection run, never interleave.
10. **Reconcile** (pure, `reconcile(existing, candidates, reported_elsewhere)`):
    1. A candidate whose key is already on a finding of another of the user's check-ins is **dropped**: a finding is reported once.
    2. A candidate whose key is on this check-in **updates** that finding's severity, decision and payload, keeping the user's action.
    3. Any other candidate is **inserted**.
    4. An existing finding no candidate matches is **retracted** (deleted) when it is a condition (`election_mismatch`, `goal_off_pace`, `upcoming_deadline`) with no user action: the condition cleared. Every other finding is kept, because events (`recurring_*`, `pay_change`, `deduction_change`) stay true once reported, and the user's action is history.
11. **Surfacing consumes recurring flags.** After writing, every `new` or `changed` charge the finders saw (inserted, updated or dropped) is set to `active` (spec 009 rule 13). `stopped` charges keep their status; the key's `last_seen` stops them being reported twice. Ignored charges are left alone.
12. **Keys** name the event a finding reports (rules 1-7). They are unique per check-in (`UNIQUE (check_in_id, key)`, migration `0012`).
13. **Status.** A check-in is `completed`, with `completed_at` set, when it has at least one finding and every finding has a user action; otherwise it is `open` with `completed_at` null. The engine and `PATCH` both apply this after writing.

### Jobs

14. **Monthly enqueue.** Every `schedule.tick` (on the privileged connection, under its advisory lock 42) queues one `checkin.monthly` job for each `auth.users` row that has no job with the idempotency key `checkin.monthly:{YYYY-MM}` of the tick clock's UTC month, with payload `{"period": "YYYY-MM-01", "trigger": "schedule"}`. The first tick of a month queues every user; a later tick that month only reaches a user still without one (the worker was down on the 1st, or the user signed up since). The tick's result adds `checkins_queued`.
15. **Sync-triggered refresh.** A finished sync queues `recurring.detect` (spec 002 rule 16). When that job has written, in the same transaction, it queues `checkin.monthly` with `{"period": <the clock's month>, "trigger": "sync"}` through `enqueue_unless_queued`, but only when that month's check-in exists and is `open`. Queueing from the detector rather than the sync means the refresh always reads the charges the sync revealed; repeated syncs share one waiting job.
16. **Handler.** `checkin.monthly` runs under `user_session_for(job.user_id)`. Its date is `min(clock().date(), last day of period)`. A payload without a first-of-month `period` or with an unknown `trigger` fails the job.

### Routes

17. `GET /check-ins/{id}` and `PATCH` read under RLS; another user's check-in, a finding of another check-in, or another user's finding is 404.
18. **PATCH.** `done` or `dismissed` sets `user_action` and `user_action_at` to the request time; the same action again changes nothing. `null` clears both (undo, spec amendment 14). Then rule 13. Recurring charges keep the status rule 11 gave them.
19. **Cash flow against the plan** (`calc/cashflow.py:against_plan`, pure). Lines, in order, with actuals from the period's cash flow: `take_home` (the spending summary's `income_cents`), `essentials`, `flexible`, `other`, `savings` (spending buckets), `retirement` and `health` (the summed stub lines `retirement_contribution` and `medical_premium`), `left_over` (the summary's). Plans: `essentials` is the current `emergency_fund` decision's `monthly_essentials_cents`; `savings` is the emergency-fund goal's `monthly_contribution_cents` when the goal is `active`; `retirement` is `round_half_up(period gross * contribution_pct / 100)` from the current `k401_match` decision; `health` is the selected plan's `premium_per_period_cents * paycheck_count`. Every other plan is null, and a missing decision makes its plan null. Plans are monthly figures; for the current month the actuals run only to today.
20. **Net worth** (`calc/net_worth.py:net_worth`, pure). Active accounts only. A snapshot counts on its UTC date. Each month's cutoff is its last day, or today for the current month; an account contributes its newest snapshot on or before the cutoff, and nothing before its first snapshot. `checking`, `savings`, `investment` and `retirement` are assets; `credit` is a liability whose balance is the amount owed (spec 001 rule 22). A month in which no account has a snapshot is left out of the series. The current figures use each account's newest snapshot on or before today.
21. **Holdings** (`calc/net_worth.py:holdings`, pure). For each `investment` or `retirement` account, the holdings on its newest `as_of` date, by value descending, then name. `gain = value - cost basis` when the basis is known. An account's or the total's `cost_basis_cents` and `gain_cents` are null when any holding in it lacks a basis, so a partial basis is never shown as a whole one.
22. `GET /calendar` keeps spec 007 rule 19 (`upcoming` only, by `due_at`, then `created_at`) and filters `from <= due_at <= to` when given.

## Hand-worked examples

The November user: semimonthly at Acme, a 4% 401(k) election and the "HDHP + HSA" plan (premium 3,125 per paycheck) saved on 2026-10-20. Stub **S1** paid 2026-10-31 for 10-16 to 10-31: gross 270,833; federal 29,776, Social Security 16,792, Medicare 3,927, state 9,814, 401(k) 0, medical 6,250, other 4,670; net 199,604. Stub **S2** paid 2026-11-15 for 11-01 to 11-15: gross 270,833; federal 21,196, Social Security 16,792, Medicare 3,927, state 9,814, 401(k) 5,417, medical 3,125, other 4,670; net 205,892. Period 2026-11-01, today 2026-11-16 unless a row says otherwise.

### Finders (`api/tests/unit/checkin/test_findings.py`; eval `checkin`)

| # | Test | Facts | Expected |
|---|---|---|---|
| 1 | `test_election_not_applied` | 401(k) 4%, stub S2 alone | `election_mismatch`, `alert`: expected 10,833, actual 5,417, difference -5,416, elected 4, actual 2.00 |
| 2 | `test_election_applied_within_a_cent` | S2 with 401(k) 10,834 | none |
| 3 | `test_election_not_yet_due` | 401(k) 4%, stubs S1 only | none |
| 4 | `test_health_premium_mismatch` | HDHP 3,125; S2 with medical 6,250 | `election_mismatch`, `warning`: expected 3,125, actual 6,250, difference 3,125, plan "HDHP + HSA" |
| 5 | `test_goal_off_pace` | Goal started 2026-08-01, 30,000 a month, target 547,000; balances 2026-07-31 200,000 and 2026-11-15 274,000 | `goal_off_pace`, `warning`: 3 months, expected 290,000, shortfall 16,000 |
| 6 | `test_goal_on_pace` | Row 5 with 290,000 on 2026-11-15 | none |
| 7 | `test_goal_at_target_is_not_behind` | Row 5 with target 274,000 | none |
| 8 | `test_recurring_new` | Equinox, `new`, monthly, 18,500, seen 2026-09-03 to 2026-11-03 | `recurring_new`, `warning`, key `recurring_new:{id}:2026-11-03` |
| 9 | `test_recurring_price_rise` | Netflix, `changed`, 1,699, last reported 1,549 | `recurring_changed`, `warning`, previous 1,549, change 150 |
| 10 | `test_recurring_price_drop` | Spotify, `changed`, 999, last reported 1,199 | `recurring_changed`, `info`, change -200 |
| 11 | `test_recurring_change_without_history` | Netflix, `changed`, 1,699, nothing reported before | `recurring_changed`, `warning`, previous and change null |
| 12 | `test_recurring_stopped_after_cancel` | Hulu, `stopped`, last seen 2026-09-03, `cancelled` | `recurring_stopped`, `info`, `user_status` cancelled |
| 13 | `test_ignored_charge_is_not_reported` | Equinox `new`, `ignored` | none |
| 14 | `test_raise` | Stubs S3, S1 (S3 below) | `pay_change`, `info`: gross +20,834, net +19,241; no `deduction_change` |
| 15 | `test_pay_cut` | Stubs S1, S3 | `pay_change`, `warning`: gross -20,834, net -19,241 |
| 16 | `test_deduction_changes` | Stubs S2, S1, no decisions | three `deduction_change`, `info`: federal -8,580 (affects `w4`), 401(k) +5,417 (`k401_match`), medical -3,125 (`health_plans`) |
| 17 | `test_upcoming_deadlines` | Events due 2026-11-20 (`goal_contribution`) and 2026-12-16 (`enrollment_deadline`) | `warning` with 4 days, `info` with 30 days |
| 18 | `test_nothing_to_report` | Period and today only | none |

S3 is S1 with a raise to 291,667 gross: Social Security 18,083 and Medicare 4,229, every other line as S1, net 218,845.

Arithmetic:

- Row 1: `270,833 * 4 / 100 = 10,833.32`, so 10,833. `|5,417 - 10,833| = 5,416 > 1`. `5,417 / 270,833 * 100 = 2.0001...`, "2.00". S2's `period_start` 2026-11-01 is after 2026-10-20.
- Row 2: `|10,834 - 10,833| = 1`, not more than 1. Row 3: S1 starts 2026-10-16, not after 2026-10-20.
- Row 5: no balance on or before 2026-08-01 except 2026-07-31, so the start is 200,000. `add_months(2026-08-01, k)` for k = 1, 2, 3 is 09-01, 10-01, 11-01, all on or before 11-15; k = 4 is 12-01. `200,000 + 3 * 30,000 = 290,000`; `290,000 - 274,000 = 16,000 > 0` and `274,000 < 547,000`.
- Row 7: shortfall is still 16,000, but 274,000 is not below the 274,000 target.
- Rows 9-10: `1,699 - 1,549 = 150`; `999 - 1,199 = -200`.
- S3: `291,667 * 6.2% = 18,083.354`, `* 1.45% = 4,229.17`; deductions `29,776 + 18,083 + 4,229 + 9,814 + 0 + 6,250 + 4,670 = 72,822`; net `291,667 - 72,822 = 218,845`. Row 14: `291,667 - 270,833 = 20,834`, `218,845 - 199,604 = 19,241`.
- S2's net: `21,196 + 16,792 + 3,927 + 9,814 + 5,417 + 3,125 + 4,670 = 64,941`, `270,833 - 64,941 = 205,892`. Row 16: `21,196 - 29,776 = -8,580`; `5,417 - 0`; `3,125 - 6,250 = -3,125`; state and other are equal.
- Row 17: 2026-11-20 minus 2026-11-16 is 4 days (at most 7); 2026-12-16 is 30 days. An event due 2026-12-17 (31 days) or 2026-11-15 (past) is not a fact (Inputs).

### Reconcile (`api/tests/unit/checkin/test_engine.py`)

| # | Test | Existing on this check-in | Candidates, elsewhere | Expected |
|---|---|---|---|---|
| 1 | `test_new_candidates_are_inserted` | none | K1, K2 | insert K1, K2 |
| 2 | `test_refresh_keeps_the_users_action` | K1 `done`, old payload | K1 with a new payload | update K1; its action stays `done` |
| 3 | `test_cleared_condition_is_retracted` | `goal_off_pace` G1 unhandled, G2 `dismissed` | none | retract G1; keep G2 |
| 4 | `test_reported_events_are_kept` | `recurring_new` R1 unhandled | none | keep R1 |
| 5 | `test_reported_elsewhere_is_dropped` | none | P1; P1 elsewhere | drop P1 |

### Jobs (`api/tests/integration/checkin/test_checkin_job.py`)

| # | Test | Setup | Expected |
|---|---|---|---|
| 1 | `test_tick_queues_one_check_in_per_user_per_month` | Users A and B; tick at 2026-11-01 08:00 UTC twice, then at 2026-12-01 | Two jobs with key `checkin.monthly:2026-11` after the first tick, none more after the second, two `2026-12` jobs after the third |
| 2 | `test_monthly_job_builds_the_check_in` | The November user with S1, S2, the decisions, the goal of row 5 and the Equinox charge; clock 2026-11-16 | One scheduled check-in for 2026-11-01, `open`; findings `election_mismatch` (401(k), alert), `goal_off_pace`, `recurring_new`, three `deduction_change`; Equinox is `active` |
| 3 | `test_rerunning_changes_nothing` | Run row 2's job, then a `sync` job | Same finding ids; second outcome `refreshed` with 0 inserted |
| 4 | `test_detect_queues_a_refresh_for_an_open_check_in` | An open November check-in; `recurring.detect` at 2026-11-16 | One queued `checkin.monthly` with `trigger = sync`; a second detection reuses it |
| 5 | `test_no_refresh_without_an_open_check_in` | None, then a completed one | No `checkin.monthly` job |
| 6 | `test_refresh_keeps_actions_and_retracts_cleared_conditions` | Row 2, mark the 401(k) finding `done`; the goal reaches 290,000; a `sync` refresh | 401(k) finding still `done`; `goal_off_pace` gone |
| 7 | `test_sync_refresh_never_creates_a_check_in` | No check-in; a `sync` job | outcome `skipped`, no row |

### Routes (`api/tests/integration/checkin/test_checkin_routes.py`, `test_net_worth.py`)

| # | Test | Setup | Expected |
|---|---|---|---|
| 1 | `test_list_check_ins` | Two check-ins, one with 2 findings, 1 handled | Newest first; counts 2 and 1 |
| 2 | `test_cash_flow_against_the_plan` | Spec 007's September month for a September check-in, now 2026-10-21; 401(k) 4%, health 6,250 a paycheck, emergency fund essentials 250,000 and contribution 50,000 | `essentials` 180,000 vs 250,000 (-70,000); `savings` 40,000 vs 50,000 (-10,000); `retirement` 0 vs 21,667; `health` 12,500 vs 12,500 (0); `take_home` 399,208, `flexible` 8,500, `other` 3,900, `left_over` 166,808 with no plan |
| 3 | `test_patch_done_dismissed_and_undo` | Two findings | `done`, then the other `dismissed`: check-in `completed`; `null` on one: `open`, `completed_at` null |
| 4 | `test_patch_validation_and_404` | Unknown action, extra field, a finding of another check-in | 422, 422, 404 |
| 5 | `test_net_worth_by_month` | Accounts and snapshots below; today 2026-11-16; `months=3` | Series Sep 450,000, Oct 465,000, Nov 547,754; change 97,754; assets 607,754, liabilities 60,000 |
| 6 | `test_holdings_newest_per_account` | Holdings below | Retirement 21,710, basis 21,668, gain 42; brokerage 128,000 with null basis and gain; totals 149,710, null, null |
| 7 | `test_calendar_window` | Events due 2026-10-30, 2026-11-20, 2027-01-31 | `from=2026-11-01` lists two; `to=2026-11-30` two; both lists one; `from` after `to` is 422 |

Row 2: September gross `2 * 270,833 = 541,666`; `541,666 * 4 / 100 = 21,666.64`, so 21,667. Health `6,250 * 2 = 12,500`. The actuals are spec 007's.

Row 5: checking (snapshots 2026-09-20 250,000, 10-20 280,000, 11-15 312,044), savings (200,000, 230,000, 274,000 on the same days), credit (10-20 45,000, 11-15 60,000 owed), retirement (11-15 21,710). September: `250,000 + 200,000 = 450,000`. October: `280,000 + 230,000 - 45,000 = 465,000`. November: `312,044 + 274,000 + 21,710 = 607,754` assets, `- 60,000 = 547,754`. Change `547,754 - 450,000 = 97,754`.

Row 6: retirement on 2026-11-15, one target-date fund, 14.21 shares, value 21,710, basis 21,668 (an older 2026-11-14 row is ignored); brokerage on 2026-11-15, VTI value 98,000 basis 90,000 and VXUS value 30,000 with no basis.

## Edge cases

- A user with no data gets an empty, `open` check-in; the job succeeds.
- A stub showing 0 for the 401(k) because the year's 402(g) limit was reached reads as a mismatch; the finder does not track year-to-date totals.
- A health premium line that includes dental or vision differs from the medical plan's premium and reads as a mismatch, at `warning` rather than `alert` for that reason.
- A goal whose account was unlinked has no account and is not judged; a paused or reached goal is not judged.
- A charge that stops and resumes gets a new `last_seen`, so its new `recurring_new` is reported again.
- A check-in completed by the user is not refreshed; whatever appears afterwards waits for next month's check-in (new and changed charges stay flagged until then).
- A job that runs after its month ended is dated the period's last day, so it never judges another month's data as this one's.
- `GET /net-worth` with no snapshots returns zeros, `as_of` null and an empty series.

## Out of scope

- `POST /check-ins` (run a check-in on demand) and the `manual` trigger.
- Explaining a finding (`POST /explain` with `finding_id`).
- Marking calendar events done from a finding, and a new decision version from a finding (`decisions.check_in_id`).
- Holdings history and investment transactions.
