# 015: Monthly check-ins, net worth and holdings

Status: Implemented, M8; `POST /check-ins` (rule 23) and plan line status (rule 19a) in M10. Issue 194: pay stub findings name the paycheck, not the stub row (rules 1, 2, 5, 10.4, 12 and 13a). Issue 202: one paycheck change is one finding, its deduction lines inside it (rules 5-6, migration `0021_paycheck_change`). Issue 233: a past check-in is a record of its date (rule 9b), a date that passed unsettled is an `overdue_deadline` (rule 7), and the person's action on a date's finding settles the date (rule 24). Issue 234: a reminder is keyed by its date, not by the event row of a decision version (rule 12, migration `0022_deadline_dates`, rule 13b). Issue 235: the cash flow's deposits line is "Income deposited", and a month without a pay stub has no 401(k) or health plan yet (rule 19). Every example is a test; the finder scenarios are also the `checkin` eval suite.

## Goal

Once a month, again whenever a sync lands new data that month, and whenever the user asks to check in now, compare the user's newest data with the plan they saved and say what changed: an election that did not reach the pay stub, a savings goal that fell behind, a new, repriced or stopped recurring charge, a paycheck that differs from the one before it (in pay or in a deduction), and a dated checkpoint coming up or gone past. Each change is a typed **finding** with a severity, the decision it affects, and a payload of plain numbers the client prints without adding anything. The user marks a finding done or dismissed, or undoes that. The check-in screen also shows the month's cash flow next to the plan's targets, the user's net worth by month, and their newest investment holdings.

Code: pure finders in `api/checkin/findings.py` (one function per kind, `f(facts) -> list[Finding]`), the facts loader in `api/checkin/facts.py`, the engine (pure reconciliation plus the writer) in `api/checkin/engine.py`, the `checkin.monthly` handler in `api/jobs/handlers/checkin.py`, the monthly enqueue in `api/jobs/scheduler.py`, the on-demand enqueue `queue_check_in_now` in `api/checkin/engine.py`, the sync-triggered refresh in `api/jobs/handlers/recurring.py`, routes in `api/app/routers/checkins.py` and `api/app/routers/net_worth.py`, open and overdue dates and the one count of days in `api/db/calendar.py`, money math in `api/calc/checkin.py`, `api/calc/cashflow.py` (`against_plan`, `plan_status`) and `api/calc/net_worth.py`, migrations `0012_checkin_findings`, `0021_paycheck_change` and `0022_deadline_dates`, eval suite `evals/suites/checkin.py`.

## Inputs

### Facts (`checkin/findings.py:Facts`, read under RLS by `checkin/facts.py`)

| Field | Type | What it holds |
|---|---|---|
| `period` | date | First day of the check-in's month |
| `today` | date | The job clock's UTC date, capped at the period's last day |
| `pay_stubs` | list, newest first, at most 2 | The two newest current confirmed `pay_stubs` (superseded copies left out, spec 005 rule 22d) by `pay_date`, then `created_at`, then `id` (descending): `id`, `paycheck_id` (below), `pay_date`, `period_start`, `period_end`, `gross_cents`, the seven deduction columns, `net_cents` |
| `k401` | object or null | The current `k401_match` decision: `decision_id`, `decided_on` (its `created_at` as a UTC date), `contribution_pct` (Decimal) |
| `health` | object or null | The current `health_plans` decision: `decision_id`, `decided_on`, `plan_name` and `premium_per_period_cents` of `inputs.plans[selected_plan_index]` |
| `w4_decision_id` | uuid or null | The current `w4` decision, when there is one |
| `goals` | list | Every `active` goal with a linked account: `id`, `kind`, `decision_id`, `started_on` (the goal's decision's `created_at` as a UTC date, else the goal's own `created_at`), `target_amount_cents`, `monthly_contribution_cents`, `balances` (the linked account's snapshots, oldest first: `as_of` UTC date, `balance_cents`) |
| `recurring` | list | Every `recurring_charges` row with `status` `new`, `changed` or `stopped`: `id`, `merchant` (`merchant_clean`), `cadence`, `status`, `user_status`, `typical_amount_cents`, `first_seen`, `last_seen`, `last_reported_amount_cents` (the `typical_amount_cents` of the newest earlier recurring finding about this charge, or null) |
| `events` | list | Open `calendar_events` (rule 24) with `due_at <= today + 30 days`, so also the open ones whose date has passed, by `due_at`, `created_at`, `id`: `id`, `kind`, `title`, `due_at`, `decision_id` |

**Paycheck id.** A stub's `paycheck_id` is the id of the first confirmed copy of its paycheck: of the stub and every stub it superseded, directly or through earlier copies (spec 005 rule 22b), the one that superseded nothing (`db/pay_stubs.py:paycheck_ids`). A stub that superseded nothing is its own paycheck id, and a newer copy never changes it, because a newer copy always supersedes something. When one confirm supersedes two current stubs at once (rule 22b's same paycheck and a replaced document's stub), the two become one paycheck, named by the older of their first copies (`created_at`, then `id`).

### Routes

| Route | Input |
|---|---|
| `GET /check-ins` | none |
| `POST /check-ins` | none (no body); the month is the request clock's UTC month |
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
| `pay_change` | `pay_stub_id`, `pay_date`, `previous_pay_stub_id`, `previous_pay_date`, `gross_cents`, `previous_gross_cents`, `gross_change_cents`, `net_cents`, `previous_net_cents`, `net_change_cents`, `deductions` (a list, in rule 6's order, of each changed line: `line`, a `calc/cashflow.py` line key, `label`, `amount_cents`, `previous_cents`, `change_cents`) |
| `upcoming_deadline`, `overdue_deadline` (`DeadlinePayload`) | `calendar_event_id`, `calendar_kind`, `title`, `due_at`, `days_until` (counted from the run's date, so negative for `overdue_deadline`) |

`FindingOut` adds `id`, `check_in_id`, `user_action` (`done`, `dismissed` or null), `user_action_at`, `created_at`, `updated_at` and `charge_gone`: true for a `recurring_*` finding whose `recurring_charge_id` is not one of the user's `recurring_charges` any more (rule 10.4's test, read when the check-in is read), false for every other finding.

### Check-ins

- `GET /check-ins`: `CheckInSummary` items, newest `period` first: `id`, `period`, `triggered_by`, `status` (`open`, `completed`), `completed_at`, `finding_count`, `handled_count` (findings with a user action), `created_at`, `updated_at`, `last_run_at` (when the finders last ran on it, rule 9a), `as_of` (the date its findings were judged as of: `min(UTC date of last_run_at, last day of period)`, rule 16's date for that run) and `past` (true once the request's date is after the period's last day: the check-in is a record, rule 9b).
- `GET /check-ins/{id}`: `CheckInDetail`, the summary plus `findings` (ordered by severity `alert`, `warning`, `info`, then kind in enum order, then `created_at`, `id`) and `cash_flow`: `CheckInCashFlow` with `cash_flow` (exactly what `GET /cashflow` returns for `start = period`, `end = min(last day of period, today)`) and `plan`, a list of `PlanLine` (`key`, `label`, `actual_cents`, `plan_cents` or null, `difference_cents` = actual minus plan, or null, `status` `on_plan`, `over` or `under`, or null with no plan, rule 19a; `needs_pay_stub`, rule 19).
- `PATCH /check-ins/{id}/findings/{fid}`: the updated `FindingOut`.
- `POST /check-ins`: 202 `CheckInQueued`: `job_id` (the `checkin.monthly` job that will create or refresh this month's check-in; poll `GET /jobs/{job_id}`, whose `result` carries `check_in_id`) and `check_in_id` (this month's check-in when it exists at request time, else null).
- Job result of `checkin.monthly`: `{"outcome": "created" | "refreshed" | "skipped", "check_in_id", "inserted", "updated", "retracted", "dropped", "marked_active"}`.

### Net worth and holdings

- `GET /net-worth` (`NetWorthOut`): `as_of` (date of the newest snapshot used, or null), `assets_cents`, `liabilities_cents`, `net_worth_cents`, `change_cents` (the last series point's net worth minus the first's, null with fewer than two points), `accounts` (each active account with a snapshot, by name: `account_id`, `name`, `mask`, `kind`, `role`, `institution_name`, `side` `asset` or `liability`, `balance_cents`, `balance_as_of`), `by_kind` (one row per kind present, in `account_kind` order: `kind`, `side`, `total_cents`) and `series` (one point per month with data: `month` first day, `as_of` cutoff, `assets_cents`, `liabilities_cents`, `net_worth_cents`).
- `GET /holdings` (`HoldingsOut`): `accounts`, each active investment or retirement account with holdings, by name: `account_id`, `name`, `mask`, `kind`, `as_of` (its newest holdings date), `value_cents`, `cost_basis_cents`, `gain_cents`, and `holdings` (`security_id`, `name`, `ticker`, `quantity` as a decimal string, `value_cents`, `cost_basis_cents`, `gain_cents`), plus `value_cents`, `cost_basis_cents` and `gain_cents` over every account.

## Rules

### Finders (`checkin/findings.py`, pure)

Each finder is `f(facts) -> list[Finding]`, with no I/O and no clock. `all_findings` runs them in the order below and fails on a repeated key. Every amount a finder reports is computed by `calc/checkin.py` (integer cents, `Decimal` rates, one `round_half_up`); the finders compare the cents they are handed, and do date arithmetic themselves.

1. **401(k) election.** Uses the newest stub, and only when its `period_start > k401.decided_on` (a whole pay period after the election was saved). `expected = round_half_up(gross * contribution_pct / 100)`. A finding when `|actual - expected| > 1` cent (payrolls round differently), where `actual = retirement_contribution_cents`. Severity `alert`. `actual_pct = actual / gross * 100`, two places half up. Affects `k401_match`. Key `election_mismatch:k401_match:{decision_id}:{paycheck_id}`.
2. **Health plan election.** Same stub rule against `health.decided_on`. `expected = premium_per_period_cents`, `actual = medical_premium_cents`, a finding when they differ at all. Severity `warning`. Affects `health_plans`. Key `election_mismatch:health_plans:{decision_id}:{paycheck_id}`.
3. **Goal off pace.** For each goal with at least one balance: the start balance is the newest balance with `as_of <= started_on`, else the oldest balance; the current balance is the newest. `months_elapsed` is the largest `k >= 0` with `add_months(started_on, k) <= current.as_of` (the current balance's own date, so stale data is judged at its date). `expected = start + monthly_contribution * months_elapsed`; `shortfall = expected - current`. A finding when `shortfall > 0` and `current < target_amount_cents` (a goal at or past its target is never behind). Severity `warning`. Affects `emergency_fund` for an emergency-fund goal, else null. Key `goal_off_pace:{goal_id}:{period}`, so it is judged again each month.
4. **Recurring charges.** Charges with `user_status = ignored` are skipped (spec 009 rule 17). Status `new`: `recurring_new`, `warning`. Status `changed`: `recurring_changed`; `previous_amount_cents = last_reported_amount_cents`, `change_cents = typical - previous` when known; `info` when `change_cents < 0`, else `warning`. Status `stopped`: `recurring_stopped`, `info` (with `user_status = cancelled` it confirms a cancellation). Affects `spending`, no decision. Keys `{kind}:{charge_id}:{last_seen}`.
5. **Paycheck change.** With two stubs, one `pay_change` finding when `gross_cents` or any of rule 6's lines differs: the newest stub against the one before it, with the gross and net pay of both and their changes, and every changed line in `deductions`. One paycheck that differs is one finding, so the person marks it done once (issue 202: a changed stub used to make a pay change plus one finding per deduction line, each with its own Done). Severity `warning` when gross fell, else `info`. Affects `w4` with the current `w4` decision: withholding follows gross pay and the pre-tax 401(k) and health lines, which the W-4 calculator reads. Key `pay_change:{paycheck_id}` of the newest stub.
6. **Deduction lines.** The lines rule 5 compares and lists, in this order: `federal_withholding`, `state_tax`, `retirement_contribution`, `medical_premium` and `other_deductions`, each with its `calc/cashflow.py` label. Social Security and Medicare are fixed shares of gross, so the gross change covers them and they are not listed.
7. **Dates.** One finding per fact event, with `days_until = db/calendar.py:days_until(due_at, today)` (rule 24's one day count). When `days_until >= 0` it is an `upcoming_deadline`, `warning` when `days_until <= 7`, else `info`. When it is negative the date passed and nothing settled it (rule 24): an `overdue_deadline`, `alert`. Before issue 233 there was no such finding: the October check-in reported the W-4 hand-in as coming up, November's dropped it as already reported (rule 10.1), and once the day passed nothing said it was late. Affects by calendar kind: `election_check` `k401_match`; `enrollment_deadline` and `open_enrollment` `health_plans`; `goal_contribution`, `goal_review` and `goal_target` `emergency_fund`; `tax_season` and `w4_submit` `w4`. Every calendar kind affects a calculator: the mapping is total over `calendar_kind`, so a new kind cannot ship without one (`checkin/findings.py:calendar_affects`, a `match` that mypy checks is exhaustive, and a test over every kind; issue #170, where `w4_submit` had none and its finding had no Affects link). `decision_id` is the event's. Key `{kind}:{calendar_kind}:{due_at}` (`upcoming_deadline:w4_submit:2026-10-31`): the date, not the event's row (rule 12). An overdue date has its own key, so after one check-in reported it as coming up it is reported once more, in the check-in of the month it is late in. Two open events of one kind on one day (no decision effect makes them: a newer version dismisses the older one's) are one finding, about the last of them in the facts' order.

### Engine (`checkin/engine.py`)

8. **One check-in per user and month.** The `checkin.monthly` job with `trigger = schedule` gets or creates the user's `check_ins` row for its `period` (`triggered_by = schedule`; the partial unique index makes a second one impossible), then refreshes it. A job with `trigger = sync` only refreshes that row when it exists and is `open`; otherwise its outcome is `skipped`.
9. **Refresh.** Load the facts, run `all_findings`, reconcile (rule 10) and write, in one user session under RLS, holding a per-user transaction advisory lock (`checkin:{user_id}`) and then the recurring detector's (`recurring.detect:{user_id}`, spec 009 rule 15), so two refreshes, or a refresh and a detection run, never interleave.
9a. **Last run.** Every run that creates or refreshes a check-in sets `check_ins.last_run_at` to the job's clock (`Services.clock`, the time it ran, not the period-capped date of rule 16) in the same transaction, also when reconcile changes nothing. A skipped run (rule 8, a completed check-in) and a `PATCH` of a finding leave it. The check-in screen says "Compared with your plan on {last_run_at}". It is its own column because `updated_at` moves only when the row itself changes: a refresh that changed only findings, or nothing at all, left it at the day the check-in was made, so right after Check in now the screen said "Checked again just now" under an older date (issue #171). Migration `0018_check_in_last_run_at` adds it `NOT NULL`; rows from before it take their `updated_at`, the latest time they are known to have run.
9b. **A past check-in is a record of its date.** No run reaches a check-in once its month has ended: the tick, a sync and Check in now each run the request clock's month (rules 14, 15 and 23), and a job that runs after its month is dated the month's last day (rule 16). So a check-in's findings are what its last run found on `as_of`, with that run's numbers (`days_until` counts from `as_of`, not from the day the page is read), and the check-in is never recomputed: a record that states its date is simpler and more honest than one whose findings change under it, and whatever changed since is the next check-in's to report (rule 7's overdue dates, a new paycheck). The screen of a `past` check-in says it is a record of `as_of`, words its findings in the past and prints no count of days (issue 233: the October check-in opened on November 9 said "Due Nov 6, 2026, in 6 days", counted from October 31). What the page reads when it is opened it presents as current, not as part of the record: the person's action on each finding (which can still be marked or undone, and settles a date, rule 24), `charge_gone` (the October record kept "Interest looks like a monthly charge of $111.47" after issue 200 made the detector stop counting loan interest and drop the charge; the record keeps the finding and now says Spending no longer lists it), and the cash flow card (rule 19), the whole month's data as it stands now against the plan saved now. The dates coming up (`GET /calendar`) are today's, so only a check-in that is not `past` shows them. No screen prints a count of days for a finding, this month's included: a count is true only on the day it is worked out, and the run's day is rarely the day the page is read.
10. **Reconcile** (pure, `reconcile(existing, candidates, reported_elsewhere)`):
    1. A candidate whose key is already on a finding of another of the user's check-ins is **dropped**: a finding is reported once.
    2. A candidate whose key is on this check-in **updates** that finding's severity, decision and payload, keeping the user's action.
    3. Any other candidate is **inserted**.
    4. An existing finding no candidate matches is **retracted** (deleted) when it has no user action and either it is a condition (`election_mismatch`, `goal_off_pace`, `upcoming_deadline`, `overdue_deadline`), so the condition cleared (a date clears when it passes, turning overdue, and when it is settled, rule 24), or its subject is gone: a `recurring_*` finding whose `recurring_charge_id` is not one of the user's `recurring_charges` any more (the institution was unlinked, spec 017 rule 14), or a `pay_change` whose `pay_stub_id` or `previous_pay_stub_id` is not a current stub any more (a confirm superseded it, spec 005 rule 22b, and no candidate took its key: a Replace that corrected the stub's dates, so the two stubs compared are not the newest two now). Every other finding is kept, because events (`recurring_*`, `pay_change`, `deduction_change`) stay true once reported, and the user's action is history.
11. **Surfacing consumes recurring flags.** After writing, every `new` or `changed` charge the finders saw (inserted, updated or dropped) is set to `active` (spec 009 rule 13). `stopped` charges keep their status; the key's `last_seen` stops them being reported twice. Ignored charges are left alone.
12. **Keys** name the event a finding reports (rules 1-7). They are unique per check-in (`UNIQUE (check_in_id, key)`, migration `0012`). A pay stub finding names the paycheck (`paycheck_id`), never the stub row: confirming the same paycheck again (spec 005 rule 22b) updates the finding in place and keeps the user's action, and a paycheck change reported in one month's check-in is not reported again in the next. Before issue 194 the keys named the newest stub's row, so each new copy made a second set of findings (production's November check-in went from 7 findings to 13: six twice, plus one). In the same way a date's finding names the date (`calendar_kind` and `due_at`, rule 7), never the event row: a newer version of a decision dismisses its old events and adds its own (spec 007 rule 14), and a new event on the same day is the same reminder, so its finding is updated in place (its decision and `calendar_event_id`) and keeps the user's action. Before issue 234 the key named the row, so after a new 401(k) version Check in now said "1 new finding. 1 finding no longer applies." over cards that read the same. An `election_mismatch` keeps the decision in its key: against a new election the expected amount differs, so it is a different finding, and rule 1 never judges a new version against a stub whose pay period began before it was saved.
13. **Status.** A check-in is `completed`, with `completed_at` set, when it has at least one finding and every finding has a user action; otherwise it is `open` with `completed_at` null. The engine and `PATCH` both apply this after writing.
13a. **Findings stored before issues 194 and 202.** Migration `0021_paycheck_change` rewrites a check-in's pay stub findings the way rules 5, 6 and 12 write them now, then drops `deduction_change` from `finding_kind`:
    1. Its `pay_change` and `deduction_change` findings whose `pay_stub_id` has one paycheck id (Inputs) are one paycheck change. That covers the findings a copy repeated (issue 194) as well as a stub's pay change and its deduction lines (issue 202). They become one `pay_change` keyed `pay_change:{paycheck_id}`: the newest copy's pay change, kept with its id, severity and decision, or, when that copy had deduction lines only, a new one with rule 5's severity and no decision, built from its two stubs (`calc/checkin.py:change_cents` for the gross and net changes) and dated as the oldest finding folded in. Its `deductions` are the newest copy's deduction lines in rule 6's order.
    2. Its `election_mismatch` findings with one calculator, decision and paycheck id are one, keyed `election_mismatch:{calculator}:{decision_id}:{paycheck_id}`: the newest, about the newest copy.
    3. The finding left has a user action only when every finding it stands for had one: the newest of them, at its time. A check-in with an open finding keeps one, and a completed one stays completed, so rule 13's status holds without being worked out again.

    The downgrade writes each `pay_change`'s lines back as `deduction_change` findings (keyed `deduction_change:{pay_stub_id}:{line}`, with the pay change's action), drops the pay changes whose gross did not change, which only carried lines, and restores the label. It leaves the keys and the merged findings as they are.
13b. **Date findings stored before issues 233 and 234.** Migration `0022_deadline_dates` adds `overdue_deadline` to `finding_kind`, after `upcoming_deadline`, and rekeys every `upcoming_deadline` finding `upcoming_deadline:{calendar_kind}:{due_at}` from its payload (rule 7). Findings of one check-in that now share a key (a decision's reminder and its newer version's on the same day, when the first was handled and so stayed) become one: the newest by `created_at`, then `id`, keeps its id, severity, decision and payload, and it has a user action only when every one of them had one (the newest action, as rule 13a.3), so the check-in keeps its status. The downgrade deletes the `overdue_deadline` findings and applies rule 13 to every check-in again (one whose only open finding was overdue is completed), rekeys the date findings `upcoming_deadline:{calendar_event_id}` and rebuilds `finding_kind` without the label.

### Jobs

14. **Monthly enqueue.** Every `schedule.tick` (on the privileged connection, under its advisory lock 42) queues one `checkin.monthly` job for each `auth.users` row that has no job with the idempotency key `checkin.monthly:{YYYY-MM}` of the tick clock's UTC month, with payload `{"period": "YYYY-MM-01", "trigger": "schedule"}`. The first tick of a month queues every user; a later tick that month only reaches a user still without one (the worker was down on the 1st, or the user signed up since). The tick's result adds `checkins_queued`.
15. **Sync-triggered refresh.** A finished sync queues `recurring.detect` (spec 002 rule 16). When that job has written, in the same transaction, it queues `checkin.monthly` with `{"period": <the clock's month>, "trigger": "sync"}` through `enqueue_unless_queued`, but only when that month's check-in exists and is `open`. Queueing from the detector rather than the sync means the refresh always reads the charges the sync revealed; repeated syncs share one waiting job.
16. **Handler.** `checkin.monthly` runs under `user_session_for(job.user_id)`. Its date is `min(clock().date(), last day of period)`. A payload without a first-of-month `period` or with an unknown `trigger` fails the job.

### Routes

17. `GET /check-ins/{id}` and `PATCH` read under RLS; another user's check-in, a finding of another check-in, or another user's finding is 404.
18. **PATCH.** `done` or `dismissed` sets `user_action` and `user_action_at` to the request time; the same action again changes nothing. `null` clears both (undo, spec amendment 14). Then rule 13. Recurring charges keep the status rule 11 gave them.
19. **Cash flow against the plan** (`calc/cashflow.py:against_plan`, pure). Lines, in order, with actuals from the period's cash flow, whose spending summary reads only `checking`, `savings` and `credit` accounts (spec 007 rule 21a: a loan's ledger never adds its payments received to income or its interest to spending): `income`, labeled "Income deposited" (the spending summary's `income_cents`, the money deposited into the cash accounts, which Spending calls Income deposited; money in only, so never negative, spec 007 rule 22a), `essentials`, `flexible`, `other`, `savings` (spending buckets), `retirement` and `health` (the summed stub lines `retirement_contribution` and `medical_premium`), `left_over` (the summary's). Plans: `essentials` is the current `emergency_fund` decision's `monthly_essentials_cents`; `savings` is the emergency-fund goal's `monthly_contribution_cents` when the goal is `active`; `retirement` is `round_half_up(period gross * contribution_pct / 100)` from the current `k401_match` decision; `health` is the selected plan's `premium_per_period_cents * paycheck_count`. Every other plan is null, and a missing decision makes its plan null. The `retirement` and `health` plans follow the period's pay stubs, so in a period with none (`paycheck_count = 0`) they are null even with a decision saved, and the line's `needs_pay_stub` is true; it is false on every other line. Plans are monthly figures; for the current month the actuals run only to today, and for a month that has ended they cover the whole month, against the decisions current when the page is read (rule 9b). Issue 235: `income` was `take_home`, "Take-home pay", which is the pay stub's net: the October check-in read "Take-home pay $3,240.12" where the October 15 stub's take-home was $1,996.04 and Spending called the same $3,240.12 Income deposited. In the same review the November check-in, with no November stub yet, read "401(k) from pay stubs: plan $0.00, On plan" against a saved election: the plan was a share of no pay at all.
19a. **Plan line status** (`calc/cashflow.py:plan_status`, pure). A line with a plan has a tolerance of `max(round_half_up(plan * 5 / 100), 2,500)`: 5% of the plan or $25, whichever is larger, so a small plan is not flagged for a few dollars and a large one is not flagged for a rounding-sized slip. `on_plan` when `|actual - plan| <= tolerance`, `over` when `actual - plan > tolerance`, `under` when `plan - actual > tolerance`; null when the plan is null. The status says only which side of the plan the month is on: whether that is good depends on the line (over on `essentials` is spending more, over on `savings` is saving more), and the client colours it by line. For the current month the actuals run only to today, so a line can read `under` until the month ends.
20. **Net worth** (`calc/net_worth.py:net_worth`, pure). Active accounts only. A snapshot counts on its UTC date. Each month's cutoff is its last day, or today for the current month; an account contributes its newest snapshot on or before the cutoff, and nothing before its first snapshot. `checking`, `savings`, `investment` and `retirement` are assets; `credit` and `loan` are liabilities whose balance is the amount owed (spec 001 rule 22). A month in which no account has a snapshot is left out of the series. The current figures use each account's newest snapshot on or before today.
21. **Holdings** (`calc/net_worth.py:holdings`, pure). For each `investment` or `retirement` account, the holdings on its newest `as_of` date, by value descending, then name. `gain = value - cost basis` when the basis is known. An account's or the total's `cost_basis_cents` and `gain_cents` are null when any holding in it lacks a basis, so a partial basis is never shown as a whole one.
22. `GET /calendar` lists open events (rule 24; spec 007 rule 19's `upcoming` ones less those a finding settled), by `due_at`, then `created_at`, filters `from <= due_at <= to` when given, and marks each `overdue` (rule 24) as of the request's date.
23. **Check in now** (`POST /check-ins`, `checkin/engine.py:queue_check_in_now`). In the request's RLS session, for the request clock's UTC month with first day `P` and the payload `{"period": P, "trigger": "schedule"}` (the scheduled job's, rule 14):
    1. When the user has no job with the key `checkin.monthly:{YYYY-MM}` yet, queue one with that key, so the month's tick (rule 14) queues nothing more for this user and two concurrent requests still make one job.
    2. Otherwise return the user's waiting (`queued`) `checkin.monthly` job with the same payload, which is the keyed job until it starts, or queue a new one without a key (`enqueue_unless_queued`), so the user can refresh a check-in the keyed job already built and repeated requests share one waiting job.
    3. The job then follows rule 8: it creates the month's check-in or refreshes the open one; a completed check-in is not refreshed (outcome `skipped`, the edge case below).
    4. The response is 202 with `job_id` and `check_in_id`, the month's check-in when it exists, else null. Its `triggered_by` stays `schedule`: this is the month's one check-in run early, not a second one (the `manual` trigger stays unused).
    5. Limited to 10 requests per user per clock hour (`app/ratelimit.py:CHECK_INS`, 429 `rate_limited`); every request counts, including one that returns a waiting job. Another user's jobs and check-ins are invisible (RLS), so their keyed job or check-in never answers this user's request.
    6. **What the screen says** when the job succeeds comes from its result (Outputs): `inserted` new findings and `retracted` findings that no longer apply, counted, or "No new findings." when both are 0. It never says the page is up to date on its own: issue 194's run said "This page is up to date." while it added six findings.

24. **Open and overdue dates** (`db/calendar.py`). A calendar event is *settled* when its status is not `upcoming` (spec 007 rule 14: a newer version of its decision dismissed it) or when a date finding about it (`upcoming_deadline` or `overdue_deadline` with its `calendar_kind` and `due_at`, on any of the user's check-ins) has a user action; every other event is *open*. Marking a reminder done or dismissed settles its date everywhere, on whichever check-in it was marked, and undo opens it again. Nothing writes the event's status for it: the finding's action is the one record of what the person did, so an undo never reopens an event a newer version dismissed and there is no second copy to keep in step. An open event is *overdue* when `days_until(due_at, today) < 0`. `db/calendar.py:days_until` is the one count of days, and every reader goes through it with its own date as today: the finders (rule 7, the run's date), `GET /calendar` (rule 22) and the plan's calendar (spec 016 rule 6, the request's). Those readers see open events only, and `CalendarEventOut.overdue` says which are late. The calendar file (spec 016 rule 18) still lists every event with its stored status.

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
| 14 | `test_raise` | Stubs S3, S1 (S3 below) | `pay_change`, `info`: gross +20,834, net +19,241, `deductions` empty |
| 15 | `test_pay_cut` | Stubs S1, S3 | `pay_change`, `warning`: gross -20,834, net -19,241 |
| 16 | `test_deduction_changes` | Stubs S2, S1, no decisions | one `pay_change`, `info`, affects `w4`, key `pay_change:{S2}`: gross 270,833, change 0; net 205,892 from 199,604, +6,288; `deductions` federal 21,196 from 29,776 (-8,580), 401(k) 5,417 from 0 (+5,417), medical 3,125 from 6,250 (-3,125) |
| 17 | `test_upcoming_deadlines` | Events due 2026-11-20 (`goal_contribution`) and 2026-12-16 (`enrollment_deadline`) | `warning` with 4 days, `info` with 30 days; keys `upcoming_deadline:goal_contribution:2026-11-20` and `upcoming_deadline:enrollment_deadline:2026-12-16` |
| 18 | `test_nothing_to_report` | Period and today only | none |
| 19 | `test_keys_name_the_paycheck` | 401(k) 4%; stubs S2 (paycheck id S2a, an earlier copy it superseded) and S1 | keys `election_mismatch:k401_match:{K401}:{S2a}` and `pay_change:{S2a}`; both payloads' `pay_stub_id` is S2 |
| 20 | `test_overdue_date` | Event due 2026-11-15 (`w4_submit`), open | `overdue_deadline`, `alert`, -1 days, affects `w4`, key `overdue_deadline:w4_submit:2026-11-15` |
| 21 | `test_due_today_is_not_overdue` | Event due 2026-11-16 | `upcoming_deadline`, `warning`, 0 days |
| 22 | `test_one_finding_per_date` | Two `election_check` events due 2026-11-30, E1 then E2 | one finding, about E2 |

S3 is S1 with a raise to 291,667 gross: Social Security 18,083 and Medicare 4,229, every other line as S1, net 218,845.

Arithmetic:

- Row 1: `270,833 * 4 / 100 = 10,833.32`, so 10,833. `|5,417 - 10,833| = 5,416 > 1`. `5,417 / 270,833 * 100 = 2.0001...`, "2.00". S2's `period_start` 2026-11-01 is after 2026-10-20.
- Row 2: `|10,834 - 10,833| = 1`, not more than 1. Row 3: S1 starts 2026-10-16, not after 2026-10-20.
- Row 5: no balance on or before 2026-08-01 except 2026-07-31, so the start is 200,000. `add_months(2026-08-01, k)` for k = 1, 2, 3 is 09-01, 10-01, 11-01, all on or before 11-15; k = 4 is 12-01. `200,000 + 3 * 30,000 = 290,000`; `290,000 - 274,000 = 16,000 > 0` and `274,000 < 547,000`.
- Row 7: shortfall is still 16,000, but 274,000 is not below the 274,000 target.
- Rows 9-10: `1,699 - 1,549 = 150`; `999 - 1,199 = -200`.
- S3: `291,667 * 6.2% = 18,083.354`, `* 1.45% = 4,229.17`; deductions `29,776 + 18,083 + 4,229 + 9,814 + 0 + 6,250 + 4,670 = 72,822`; net `291,667 - 72,822 = 218,845`. Row 14: `291,667 - 270,833 = 20,834`, `218,845 - 199,604 = 19,241`.
- S2's net: `21,196 + 16,792 + 3,927 + 9,814 + 5,417 + 3,125 + 4,670 = 64,941`, `270,833 - 64,941 = 205,892`. Row 16: `21,196 - 29,776 = -8,580`; `5,417 - 0`; `3,125 - 6,250 = -3,125`; state and other are equal; net `205,892 - 199,604 = 6,288`, which is the three line changes with their signs turned: `8,580 - 5,417 + 3,125 = 6,288`.
- Row 17: 2026-11-20 minus 2026-11-16 is 4 days (at most 7); 2026-12-16 is 30 days. An event due 2026-12-17 (31 days) is not a fact (Inputs). Row 20: 2026-11-15 minus 2026-11-16 is -1; a past date is a fact while it is open (rule 24), and only then.

### Reconcile (`api/tests/unit/checkin/test_engine.py`)

| # | Test | Existing on this check-in | Candidates, elsewhere | Expected |
|---|---|---|---|---|
| 1 | `test_new_candidates_are_inserted` | none | K1, K2 | insert K1, K2 |
| 2 | `test_refresh_keeps_the_users_action` | K1 `done`, old payload | K1 with a new payload | update K1; its action stays `done` |
| 3 | `test_cleared_condition_is_retracted` | `goal_off_pace` G1 unhandled, G2 `dismissed` | none | retract G1; keep G2 |
| 4 | `test_reported_events_are_kept` | `recurring_new` R1 unhandled | none | keep R1 |
| 5 | `test_reported_elsewhere_is_dropped` | none | P1; P1 elsewhere | drop P1 |
| 6 | `test_paycheck_change_about_a_superseded_stub_is_retracted_unless_handled` | `pay_change` P1 about S2 unhandled, P2 about S2 `done`; S2 superseded | none | retract P1; keep P2 |
| 7 | `test_newer_copy_updates_the_paycheck_change` | `pay_change` P1 about S2, `done`; S2 superseded by S2b, the same paycheck | P1 about S2b | update P1; its action stays `done` |

### Jobs (`api/tests/integration/checkin/test_checkin_job.py`)

| # | Test | Setup | Expected |
|---|---|---|---|
| 1 | `test_tick_queues_one_check_in_per_user_per_month` | Users A and B; tick at 2026-11-01 08:00 UTC twice, then at 2026-12-01 | Two jobs with key `checkin.monthly:2026-11` after the first tick, none more after the second, two `2026-12` jobs after the third |
| 2 | `test_monthly_job_builds_the_check_in` | The November user with S1, S2, the decisions, the goal of row 5 and the Equinox charge; clock 2026-11-16 | One scheduled check-in for 2026-11-01, `open`; findings `election_mismatch` (401(k), alert), `goal_off_pace`, `recurring_new`, one `pay_change` (S2 against S1, three lines); Equinox is `active` |
| 3 | `test_rerunning_changes_nothing` | Run row 2's job, then a `sync` job | Same finding ids; second outcome `refreshed` with 0 inserted |
| 4 | `test_detect_queues_a_refresh_for_an_open_check_in` | An open November check-in; `recurring.detect` at 2026-11-16 | One queued `checkin.monthly` with `trigger = sync`; a second detection reuses it |
| 5 | `test_no_refresh_without_an_open_check_in` | None, then a completed one | No `checkin.monthly` job |
| 6 | `test_refresh_keeps_actions_and_retracts_cleared_conditions` | Row 2, mark the 401(k) finding `done`; the goal reaches 290,000; a `sync` refresh | 401(k) finding still `done`; `goal_off_pace` gone |
| 7 | `test_sync_refresh_never_creates_a_check_in` | No check-in; a `sync` job | outcome `skipped`, no row |
| 8 | `test_a_newer_copy_is_the_same_paycheck` | Row 2 with S2 confirmed through `POST /docs/{id}/confirm`; mark the `pay_change` `done`; confirm a copy of S2 (S2b supersedes S2); a `sync` refresh | Same finding ids, nothing inserted or retracted; the `pay_change` is still `done`, keyed `pay_change:{S2}`, its `pay_stub_id` S2b |
| 9 | `test_a_corrected_stub_retracts_the_change_it_made` | Row 2 with S2 confirmed through the route; the user replaces S2's document and confirms the correction with S1's lines (S2 was read wrong); a `sync` refresh | The `pay_change` is retracted: its stub S2 is superseded and the correction and S1 differ in nothing (rule 10.4) |

### The October user (`api/tests/integration/checkin/test_check_in_records.py`, rules 7, 9b, 12, 19 and 24)

A semimonthly earner (the 2026-10-15 stub, spec 016's plan user's decisions) saves the emergency fund, 4% 401(k), health plan (enrollment deadline 2026-11-25) and W-4 through `POST /decisions` on 2026-10-21 15:00 UTC, so the dates come from the side effects: the election check, the W-4 hand-in and the first contribution are due the next payday, 2026-10-31, and the review 2027-01-31. They press Check in now on 2026-10-28 12:00 and 2026-11-01 12:00 UTC (the worker runs each job then) and open the app again on 2026-11-09 18:00 UTC, having marked nothing.

| # | Test | Setup | Expected |
|---|---|---|---|
| 1 | `test_a_past_check_in_is_a_record_of_its_date` | Read October | `past` true, `as_of` 2026-10-28; four `upcoming_deadline` findings as that run found them, 3 days for each 2026-10-31 date and 28 for 2026-11-25; cash flow 2026-10-01 to 2026-10-31. November: `past` false, `as_of` 2026-11-01 |
| 2 | `test_an_overdue_date_is_a_finding_in_this_months_check_in` | Read November | Three `overdue_deadline` findings, `alert`, -1 days: election check, first contribution, W-4 hand-in (October reported them as coming up; before issue 233 November had nothing for them) |
| 3 | `test_the_plan_and_coming_up_mark_an_overdue_date` | `GET /plan`; `GET /calendar?to=2026-12-31` | The three 2026-10-31 dates first, `overdue` true, then 2026-11-25 (and on the plan 2027-01-31), `overdue` false |
| 4 | `test_a_date_marked_done_is_settled` | Mark October's W-4 reminder done; Check in now; undo | The plan and the calendar leave the W-4 date out; the run inserts nothing and retracts November's overdue W-4 finding; after undo the plan lists the date again |
| 5 | `test_a_charge_spending_dropped_is_marked_on_the_record` | A `new` charge "Interest" (11,147 a month, no transactions on a cash account); October's run; a detection run on 2026-11-09 deletes the charge | October's `recurring_new` finding stays, `charge_gone` true |
| 6 | `test_deposits_are_not_called_take_home` | Read October | A line `income`, "Income deposited"; no `take_home` |
| 7 | `test_a_month_without_a_pay_stub_has_no_pay_stub_plan_yet` | Read November (no stub yet) | `retirement` and `health`: actual 0, plan and status null, `needs_pay_stub` true; October's `retirement` plan 10,833 with `needs_pay_stub` false |
| 8 | `test_a_new_version_keeps_its_reminder` | Only the 2026-10-15 stub. Save a 3% 401(k) on 2026-11-02 and Check in now (1 inserted: the election check due 2026-11-15); save 4% superseding it on 2026-11-03 and Check in now | 0 inserted, 0 retracted, 1 updated: the one finding, due 2026-11-15, now has the 4% version's decision |

Row 7: `270,833 * 4 / 100 = 10,833.32`, so 10,833. Row 8: the next payday after 2026-11-02 and after 2026-11-03 is 2026-11-15 (anchored on the 15th), so both versions' events fall on one day.

### Findings stored before issues 194 and 202 (`api/tests/integration/test_migrations.py::test_0021_folds_paycheck_findings`, rule 13a)

One check-in each, upgraded from `0020_pay_stub_superseded_by`; S2b is a copy of S2 confirmed later (it supersedes S2).

| # | Before | After |
|---|---|---|
| 1 | `pay_change` about S2, written for a raise (`done`); `deduction_change` about S2 for federal (`done`), 401(k) (`done`) and medical (open) | the same `pay_change` row, key `pay_change:{S2}`, `deductions` federal, 401(k), medical; open |
| 2 | `deduction_change` about S2 for federal, 401(k) and medical, all `dismissed` | a new `pay_change`, `info`, key `pay_change:{S2}`: gross 270,833 from 270,833 (0), net 205,892 from 199,604 (+6,288), the three lines; `dismissed` at the newest of their times |
| 3 | Issue 194's November: an `election_mismatch` and three `deduction_change` about S2, then the same four about S2b (keyed by S2b's id), all open | one `election_mismatch` and one `pay_change`, both keyed by S2 (the first copy) and about S2b; open |

The downgrade turns row 1's `pay_change` back into it and three `deduction_change`, and row 2's into three `deduction_change` (`dismissed`) with no `pay_change`.

### Date findings stored before issues 233 and 234 (`api/tests/integration/test_migrations.py::test_0022_keys_dates_by_day`, rule 13b)

One check-in each, upgraded from `0021_paycheck_change`.

| # | Before | After |
|---|---|---|
| 1 | An `upcoming_deadline` about event E1 (`w4_submit`, due 2026-11-06), keyed `upcoming_deadline:{E1}`, open | The same row keyed `upcoming_deadline:w4_submit:2026-11-06` |
| 2 | The election check of a 3% version (E1, due 2026-11-15, `done`) and of the 4% version that superseded it (E2, the same day, open, written later) | One finding: E2's row and payload, open |
| 3 | Two `upcoming_deadline` findings on different days, both `done`; the check-in `completed` | Both rekeyed, both `done`; the check-in still `completed` |

The downgrade keys row 1 `upcoming_deadline:{E1}` again; an `overdue_deadline` finding written after the upgrade is deleted, and a check-in whose only open finding it was is `completed`.

### Routes (`api/tests/integration/checkin/test_checkin_routes.py`, `test_net_worth.py`, `test_check_in_now.py`)

| # | Test | Setup | Expected |
|---|---|---|---|
| 1 | `test_list_check_ins` | Two check-ins, one with 2 findings, 1 handled | Newest first; counts 2 and 1 |
| 2 | `test_cash_flow_against_the_plan` | Spec 007's September month for a September check-in, now 2026-10-21; 401(k) 4%, health 6,250 a paycheck, emergency fund essentials 250,000 and contribution 50,000 | `essentials` 180,000 vs 250,000 (-70,000); `savings` 40,000 vs 50,000 (-10,000); `retirement` 0 vs 21,667; `health` 12,500 vs 12,500 (0); `income` 399,208, `flexible` 8,500, `other` 3,900, `left_over` 166,808 with no plan |
| 2a | `test_cash_flow_skips_loan_ledgers` | Spec 007's loan ledger month for a September check-in, now 2026-10-21, no decisions | `income` 250,000 (291,500 when the loan's payment received counted as income), `other` 40,000, `left_over` 70,000; `cash_flow.spending.ledger_rows_skipped` count 3 |
| 3 | `test_patch_done_dismissed_and_undo` | Two findings | `done`, then the other `dismissed`: check-in `completed`; `null` on one: `open`, `completed_at` null |
| 4 | `test_patch_validation_and_404` | Unknown action, extra field, a finding of another check-in | 422, 422, 404 |
| 5 | `test_net_worth_by_month` | Accounts and snapshots below; today 2026-11-16; `months=3` | Series Sep 450,000, Oct 465,000, Nov 547,754; change 97,754; assets 607,754, liabilities 60,000 |
| 6 | `test_holdings_newest_per_account` | Holdings below | Retirement 21,710, basis 21,668, gain 42; brokerage 128,000 with null basis and gain; totals 149,710, null, null |
| 7 | `test_calendar_window` | Events due 2026-10-30, 2026-11-20, 2027-01-31 | `from=2026-11-01` lists two; `to=2026-11-30` two; both lists one; `from` after `to` is 422 |
| 8 | `test_check_in_now_queues_the_months_job` | The November user, no jobs; now 2026-11-16 12:00 UTC | 202, `check_in_id` null, one job with key `checkin.monthly:2026-11` and payload `{"period": "2026-11-01", "trigger": "schedule"}`; a second request returns the same job; a tick then queues nothing; running the job creates the November check-in (`schedule`, `open`) with row 2 of the job table's findings |
| 9 | `test_check_in_now_refreshes_the_open_check_in` | Row 8 after its job ran; the goal reaches 290,000 | 202 with a new, unkeyed job and the November check-in's id; a second request returns that job; running it: outcome `refreshed` on the same check-in, `goal_off_pace` retracted |
| 9a | `test_check_in_now_records_a_run_that_changes_nothing` | Row 8 after its job ran at 2026-11-16 12:00 UTC; nothing changes; Check in now again, its job running at 2026-11-18 09:00 UTC | `last_run_at` 2026-11-16 12:00 UTC after the first run; the second run's outcome is `refreshed` with nothing inserted or retracted, and `GET /check-ins` and `GET /check-ins/{id}` say `last_run_at` 2026-11-18 09:00 UTC |
| 10 | `test_check_in_now_leaves_a_completed_check_in` | A completed November check-in | 202 with its id; the job's outcome is `skipped` and the check-in stays `completed`, its `last_run_at` unchanged |
| 11 | `test_rate_limits.py` (`check_in_now`) | 10 requests counted this hour | The 11th is 429 `rate_limited` with `Retry-After`; no job is queued |
| 12 | `test_net_worth_counts_a_loan_as_owed` | Row 5's accounts and snapshots plus a student loan (`loan`, snapshots 2026-10-20 1,210,000 and 2026-11-15 1,200,000 owed) | Series Sep 450,000, Oct -745,000, Nov -652,246; change -1,102,246; assets 607,754, liabilities 1,260,000; the loan's `side` is `liability`; `by_kind` checking 312,044, savings 274,000, credit 60,000, loan 1,200,000, retirement 21,710 |
| 13 | `test_income_counts_money_in_only` | The Plaid sandbox's October (spec 007 part B), an October check-in, now 2026-10-22, no decisions | `income` 422 (never negative; before spec 007 rule 22a it was -584,578), `left_over` -168,541 |

Row 2: September gross `2 * 270,833 = 541,666`; `541,666 * 4 / 100 = 21,666.64`, so 21,667. Health `6,250 * 2 = 12,500`. The actuals are spec 007's.

Row 5: checking (snapshots 2026-09-20 250,000, 10-20 280,000, 11-15 312,044), savings (200,000, 230,000, 274,000 on the same days), credit (10-20 45,000, 11-15 60,000 owed), retirement (11-15 21,710). September: `250,000 + 200,000 = 450,000`. October: `280,000 + 230,000 - 45,000 = 465,000`. November: `312,044 + 274,000 + 21,710 = 607,754` assets, `- 60,000 = 547,754`. Change `547,754 - 450,000 = 97,754`.

Row 6: retirement on 2026-11-15, one target-date fund, 14.21 shares, value 21,710, basis 21,668 (an older 2026-11-14 row is ignored); brokerage on 2026-11-15, VTI value 98,000 basis 90,000 and VXUS value 30,000 with no basis.

Row 12: the loan has no snapshot before October, so September is row 5's 450,000. October: `465,000 - 1,210,000 = -745,000`. November: assets 607,754 as in row 5; liabilities `60,000 + 1,200,000 = 1,260,000`; `607,754 - 1,260,000 = -652,246`. Change `-652,246 - 450,000 = -1,102,246`. The loan sorts after `credit` in `by_kind` because `account_kind` lists it there.

### Plan line status (`api/tests/unit/calc/test_cashflow.py`)

| # | Plan | Actual | Tolerance | Status |
|---|---|---|---|---|
| 1 | 250,000 (essentials, route row 2) | 180,000 | 12,500 | `under` (-70,000) |
| 2 | 50,000 (savings, route row 2) | 40,000 | 2,500 | `under` (-10,000) |
| 3 | 21,667 (retirement, route row 2) | 0 | 2,500 | `under` (-21,667) |
| 4 | 12,500 (health, route row 2) | 12,500 | 2,500 | `on_plan` (0) |
| 5 | 250,000 | 262,500 | 12,500 | `on_plan` (+12,500, on the edge) |
| 6 | 250,000 | 262,501 | 12,500 | `over` (+12,501) |
| 7 | 250,000 | 237,500 | 12,500 | `on_plan` (-12,500, on the edge) |
| 8 | 250,000 | 237,499 | 12,500 | `under` (-12,501) |
| 9 | 10,000 | 12,500 | 2,500 | `on_plan` (the $25 floor) |
| 10 | 10,000 | 7,499 | 2,500 | `under` (-2,501) |
| 11 | 0 | 2,501 | 2,500 | `over` (a plan of 0 still has the floor) |
| 12 | 250,010 | 262,511 | 12,501 | `on_plan` (+12,501) |
| 13 | 250,010 | 262,512 | 12,501 | `over` (+12,502) |
| 14 | null (income, flexible, other, left over) | any | none | null |

Arithmetic: `250,000 * 5% = 12,500` (above the 2,500 floor); `50,000 * 5% = 2,500`, equal to the floor; `21,667 * 5% = 1,083.35`, so 1,083 and the floor 2,500 wins; `12,500 * 5% = 625` and `10,000 * 5% = 500`, both below the floor; `250,010 * 5% = 12,500.5`, half up to 12,501.

Route row 2 adds these statuses: `essentials`, `savings` and `retirement` `under`, `health` `on_plan`, every line without a plan null.

## Edge cases

- A user with no data gets an empty, `open` check-in; the job succeeds.
- A stub showing 0 for the 401(k) because the year's 402(g) limit was reached reads as a mismatch; the finder does not track year-to-date totals.
- A health premium line that includes dental or vision differs from the medical plan's premium and reads as a mismatch, at `warning` rather than `alert` for that reason.
- A goal whose account was unlinked has no account and is not judged; a paused or reached goal is not judged.
- A charge that stops and resumes gets a new `last_seen`, so its new `recurring_new` is reported again.
- A pay stub confirmed again (the same paycheck, or a Replace of its document) is the same paycheck (rule 12): its findings are updated, never repeated, and the payloads point at the newest copy's row.
- A check-in completed by the user is not refreshed; whatever appears afterwards waits for next month's check-in (new and changed charges stay flagged until then).
- A job that runs after its month ended is dated the period's last day, so it never judges another month's data as this one's.
- `GET /net-worth` with no snapshots returns zeros, `as_of` null and an empty series.
- `POST /check-ins` while the keyed job is running queues a refresh after it, because the running job may have read the data before the change the user is checking for.
- A date reported as coming up and then marked done, on that check-in or a later one, is settled: no overdue finding is made for it, and an unhandled one already made is retracted on the next run (rule 10.4). The plan leaves it out at once.
- A date nobody settles is reported as overdue once, in the check-in of the month it is late in; a later month's check-in does not report it again (rule 10.1), but the plan and the dates coming up keep marking it overdue until it is settled.
- A date whose decision gets a newer version is dismissed (spec 007 rule 14), so it is settled; the new version's date, if it falls on the same day, is the same reminder (rule 12).
- `POST /check-ins` on the last day of a month just before midnight UTC queues that month's job; the job is dated by its own clock capped at the period's last day (rule 16), so it judges that month even when it runs after midnight.

## Out of scope

- The `manual` trigger: an on-demand check-in is the month's check-in (rule 23), never a second one.
- Explaining a finding (`POST /explain` with `finding_id`).
- Writing a calendar event's `status` from a finding (rule 24 reads the finding's action instead), and a new decision version from a finding (`decisions.check_in_id`).
- Counting days from today on a finding: no screen prints one (rule 9b).
- Holdings history and investment transactions.
