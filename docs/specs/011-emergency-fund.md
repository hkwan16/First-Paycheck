# 011: Emergency fund calculator, goals and their calendar

Status: Implemented, M6. Every example is a test. Explaining an emergency-fund decision is out of scope until the explain verifier can run without an IRS citation (see Out of scope).

## Goal

Size the user's emergency fund from their own essential spending, show how far their savings already go, how many months of their chosen contribution it takes to get there and what that contribution is per paycheck. The calculator is a pure function in `api/calc/emergency_fund.py`, served by `POST /calc/emergency-fund`; it saves nothing. `POST /decisions` with `calculator = emergency_fund` saves the user's pick, creates or updates their emergency-fund `goals` row and adds the two calendar checkpoints the pick implies. `GET /goals` and `PATCH /goals/{id}` (`api/app/routers/goals.py`) read and adjust the goal.

## Inputs

| Field | Type | Meaning and validation |
|---|---|---|
| `monthly_essentials_cents` | `PositiveCents` | Essential spending per month. The client sends what the user confirmed: their own figure, or the spending summary's `essentials_cents` (spec 007 part B). `calc/` never reads it from the database. Must be > 0. |
| `target_months` | int | How many months of essentials the fund should hold, 1 to 12. The product suggests 3 to 6. |
| `current_balance_cents` | `Cents` | What the fund holds today: the balance of the account the user marked `emergency_fund`, or a figure the user typed (technical spec, Current savings). |
| `monthly_contribution_cents` | `Cents` | What the user plans to add each month. May be 0. |
| `pay_periods_per_year` | int | One of 12, 24, 26, 52 (spec 006). |

## Outputs

| Field | Type | Meaning |
|---|---|---|
| `target_cents` | `Cents` | `monthly_essentials_cents * target_months`. |
| `three_month_target_cents` | `Cents` | Three months of essentials, the low end of the suggested range. |
| `six_month_target_cents` | `Cents` | Six months of essentials, the high end. |
| `shortfall_cents` | `Cents` | What is still missing: `max(0, target - balance)`. |
| `funded` | bool | True when the balance is at or above the target. |
| `funded_pct` | Decimal | The balance as a share of the target, in percent with two places, capped at 100. |
| `months_to_target` | int or null | Monthly contributions needed to close the shortfall; 0 when funded; null when the contribution never closes it within 120 months. |
| `reachable` | bool | True when funded or `months_to_target` is not null. |
| `per_paycheck_contribution_cents` | `Cents` | The monthly contribution spread over the user's paychecks. |
| `horizon_months` | int | Always 120: the longest projection the calculator makes (10 years). |

## Rules

Notation: `E = monthly_essentials_cents`, `m = target_months`, `B = current_balance_cents`, `C = monthly_contribution_cents`, `P = pay_periods_per_year`, `H = 120`.

1. **Targets.** `target_cents = E * m`, `three_month_target_cents = 3E`, `six_month_target_cents = 6E`. Integer products; no rounding.
2. **Shortfall.** `S = max(0, E * m - B)`. `funded = B >= E * m`.
3. **Funded percentage.** `funded_pct = min(100, B / (E * m) * 100)`, rounded half up to two places. The target is never 0 (`E > 0`, `m >= 1`).
4. **Months to target.** 0 when funded. Otherwise, when `C = 0` it is null; when `C > 0` it is `n = ceil(S / C)`, computed in integers as `(S + C - 1) // C`, and null when `n > H`. Contributions are assumed to land once a month; the projection earns no interest.
5. **Reachable.** `reachable = funded or months_to_target is not null`.
6. **Per paycheck.** `per_paycheck_contribution_cents = round_half_up(C * 12 / P)`.
7. **Purity.** No I/O, no clock; imports only the standard library, `pydantic` and `calc` (spec 006 rule 12).
8. **Validation.** Any input outside the ranges above is a 422 from the route and a `ValidationError` from the model.

### Properties (Hypothesis, `tests/unit/calc/test_emergency_fund_properties.py`)

- Every money output is an `int`; `three_month_target_cents <= six_month_target_cents`.
- `shortfall_cents == 0` exactly when `funded`, and then `months_to_target == 0` and `funded_pct == 100`.
- When `months_to_target = n > 0`: `n * C >= S` and `(n - 1) * C < S` (the fewest months that close the gap), and `n <= 120`.
- `months_to_target` never increases when `C` grows, everything else fixed.
- `0 <= funded_pct <= 100`.

### Saving a decision (`app/decision_effects.py`)

9. **One goal per user.** The user's emergency-fund goal is the `goals` row with `kind = emergency_fund`; a partial unique index `uq_goals_user_emergency_fund ON goals (user_id) WHERE kind = 'emergency_fund'` (migration `0008_goals_and_birth_year`) keeps it to one. Saving an `emergency_fund` decision inserts it, or updates the existing one, in the decision's transaction: `target_amount_cents = target_cents`, `monthly_contribution_cents = C`, `decision_id` = the new decision, `status = active`, `reached_at = null`, and `target_date` from rule 11.
10. **Linked account.** A new goal links the user's oldest active account with role `emergency_fund`, or none. An existing goal keeps its `account_id` when it has one, and otherwise gets that account.
11. **First contribution.** The first contribution date is the next expected pay date (spec 007 rule 16: the profile's pay frequency, or the one `P` implies, anchored on the latest confirmed pay stub). `target_date` is that date plus `months_to_target - 1` months (`calc/pay_dates.py:add_months`, the day clamped to the month's last day) when `months_to_target >= 1`, and null when the fund is already funded or not reachable.
12. **Calendar.** When `C > 0` and the fund is not funded, a `goal_contribution` event titled "Make your first emergency fund contribution" is due on the first contribution date. Every save adds a `goal_review` event titled "Review your emergency fund progress", due three months after the first contribution date (`add_months(first, 3)`). Both link the new decision. `goal_contribution` and `goal_review` are new `calendar_kind` values in `0008`.
13. **Superseding.** Saving version `n + 1` dismisses version `n`'s `upcoming` `goal_contribution` and `goal_review` events in the same transaction, so the calendar holds one pair per goal.
14. `DecisionSaved.goal_id` is the goal's id and `calendar_event_id` the `goal_review` event's id.

### Goals

15. **`goals` columns added in `0008`.** `status goal_status NOT NULL DEFAULT 'active'` (`active`, `paused`, `reached`) and `reached_at timestamptz` with `CHECK ((status = 'reached') = (reached_at IS NOT NULL))`.
16. **`GET /goals`** lists the user's goals, oldest first, as `GoalOut`: `id`, `kind`, `status`, `target_amount_cents`, `monthly_contribution_cents`, `account_id`, `decision_id`, `target_date`, `reached_at`, `current_balance_cents` (the linked account's latest balance snapshot, or null), `progress_pct` (rule 3's percentage of that balance against the target, from `calc/emergency_fund.py:funded_pct`, or null without a balance), `created_at`, `updated_at`.
17. **`PATCH /goals/{id}`** accepts any of `status` (`active`, `paused`, `reached`), `monthly_contribution_cents` (`Cents`) and `account_id` (an account id or null). Fields left out are unchanged. Setting `reached` sets `reached_at` to the request time; leaving it clears `reached_at`. A changed contribution clears `target_date`, because the projection belongs to the saved decision; saving a new decision projects again. An `account_id` the user cannot see is 404, the same as another user's goal. An empty body is 422.

## Hand-worked examples

Each row is one test in `api/tests/unit/calc/test_emergency_fund_examples.py` and one case in `evals/fixtures/calc/emergency_fund.json` (`spec-011-<name>`). Money columns are cents; `pct` is `funded_pct`; `n` is `months_to_target`.

| # | Test | E | m | B | C | P | target | 3 mo | 6 mo | shortfall | funded | pct | n | reachable | per pp |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `test_zero_balance` | 250,000 | 3 | 0 | 50,000 | 26 | 750,000 | 750,000 | 1,500,000 | 750,000 | no | 0.00 | 15 | yes | 23,077 |
| 2 | `test_partly_funded_semimonthly` | 320,000 | 6 | 450,000 | 40,000 | 24 | 1,920,000 | 960,000 | 1,920,000 | 1,470,000 | no | 23.44 | 37 | yes | 20,000 |
| 3 | `test_already_funded` | 200,000 | 3 | 700,000 | 30,000 | 26 | 600,000 | 600,000 | 1,200,000 | 0 | yes | 100.00 | 0 | yes | 13,846 |
| 4 | `test_exactly_at_target` | 200,000 | 3 | 600,000 | 0 | 12 | 600,000 | 600,000 | 1,200,000 | 0 | yes | 100.00 | 0 | yes | 0 |
| 5 | `test_never_within_ten_years` | 300,000 | 6 | 10,000 | 10,000 | 26 | 1,800,000 | 900,000 | 1,800,000 | 1,790,000 | no | 0.56 | null | no | 4,615 |
| 6 | `test_zero_contribution_not_funded` | 150,000 | 3 | 100,000 | 0 | 52 | 450,000 | 450,000 | 900,000 | 350,000 | no | 22.22 | null | no | 0 |
| 7 | `test_exactly_ten_years` | 100,000 | 6 | 0 | 5,000 | 12 | 600,000 | 300,000 | 600,000 | 600,000 | no | 0.00 | 120 | yes | 5,000 |
| 8 | `test_half_cent_per_paycheck_rounds_up` | 180,000 | 4 | 360,000 | 25,001 | 24 | 720,000 | 540,000 | 1,080,000 | 360,000 | no | 50.00 | 15 | yes | 12,501 |

### Arithmetic

**1. Zero balance.** $2,500 of essentials a month, a three-month target, nothing saved, $500 a month, paid biweekly.
- Target `250,000 * 3 = 750,000`; the range is `3E = 750,000` to `6E = 1,500,000`.
- Shortfall `750,000 - 0 = 750,000`; `funded_pct = 0 / 750,000 * 100 = 0.00`.
- `n = ceil(750,000 / 50,000) = 15` months.
- Per paycheck `50,000 * 12 / 26 = 600,000 / 26 = 23,076.92...`, rounds to 23,077 ($230.77).

**2. Partly funded, semimonthly.** $3,200 a month, six months, $4,500 saved, $400 a month.
- Target `320,000 * 6 = 1,920,000`; range 960,000 to 1,920,000.
- Shortfall `1,920,000 - 450,000 = 1,470,000`. `funded_pct = 450,000 / 1,920,000 * 100 = 23.4375`, rounds half up to 23.44.
- `n = ceil(1,470,000 / 40,000) = ceil(36.75) = 37`; in integers `(1,470,000 + 39,999) // 40,000 = 37`.
- Per paycheck `40,000 * 12 / 24 = 20,000` exactly.

**3. Already funded.** $2,000 a month, three months, $7,000 saved, still adding $300 a month.
- Target 600,000; `B = 700,000 >= 600,000`, so funded, shortfall 0, `n = 0`.
- `funded_pct = min(100, 700,000 / 600,000 * 100) = min(100, 116.67) = 100.00`.
- Per paycheck `30,000 * 12 / 26 = 13,846.15...`, rounds to 13,846.

**4. Exactly at the target.** As example 3 with `B = 600,000` and no contribution, paid monthly: `B >= target` holds with equality, so funded, `funded_pct = 100.00`, `n = 0`: with nothing left to save, a zero contribution still reaches the target. Per paycheck `0 * 12 / 12 = 0`.

**5. Never within ten years.** $3,000 a month, six months, $100 saved, $100 a month.
- Target 1,800,000; shortfall 1,790,000; `funded_pct = 10,000 / 1,800,000 * 100 = 0.5555...`, rounds to 0.56.
- `n = ceil(1,790,000 / 10,000) = 179 > 120`, so `months_to_target` is null and `reachable` is false.
- Per paycheck `10,000 * 12 / 26 = 4,615.38...`, rounds to 4,615.

**6. No contribution, not funded.** $1,500 a month, three months, $1,000 saved, nothing added, paid weekly.
- Target 450,000; shortfall 350,000; `funded_pct = 100,000 / 450,000 * 100 = 22.222...`, 22.22.
- `C = 0` and not funded: null, not reachable. Per paycheck 0.

**7. Exactly ten years.** $1,000 a month, six months, nothing saved, $50 a month, monthly pay.
- Target and shortfall 600,000; `n = 600,000 / 5,000 = 120`, which is not over the horizon, so it is reachable in 120 months. Per paycheck `5,000 * 12 / 12 = 5,000`.

**8. A half cent per paycheck rounds up.** $1,800 a month, four months, $3,600 saved, $250.01 a month, semimonthly.
- Target `180,000 * 4 = 720,000`; range 540,000 to 1,080,000; shortfall 360,000; `funded_pct = 50.00`.
- `n = ceil(360,000 / 25,001) = ceil(14.399...) = 15` (14 contributions are 350,014, short by 9,986).
- Per paycheck `25,001 * 12 / 24 = 12,500.5`, rounds half up to 12,501.

### Decisions and goals (`api/tests/integration/test_goals.py`)

| # | Test | Setup | Expected |
|---|---|---|---|
| 1 | `test_save_creates_goal_and_events` | Biweekly profile, latest stub paid 2026-10-16, today 2026-10-21, an `emergency_fund` savings account; save example 1 | One goal: target 750,000, contribution 50,000, the account linked, `target_date` 2027-12-30 (2026-10-30 plus 14 months), `status` active. Events: `goal_contribution` due 2026-10-30 and `goal_review` due 2027-01-30 |
| 2 | `test_v2_updates_goal_and_dismisses_events` | Save example 1, then v2 with `C = 75,000` | Still one goal, contribution 75,000, `target_date` 2027-07-30 (10 months: 2026-10-30 plus 9), `decision_id` = v2; v1's two events dismissed, v2's two upcoming |
| 3 | `test_funded_save_has_no_contribution_event` | Save example 3 | Goal with `target_date` null; only a `goal_review` event, due 2027-01-30 |
| 4 | `test_patch_pause_and_reach` | PATCH `status = paused`, then `reached` | `paused` with `reached_at` null; then `reached` with `reached_at` the request time |
| 5 | `test_patch_contribution_clears_target_date` | PATCH `monthly_contribution_cents = 60,000` | contribution 60,000, `target_date` null |
| 6 | `test_goal_progress_from_latest_snapshot` | Linked account with snapshots 100,000 then 187,500 | `current_balance_cents = 187,500`, `progress_pct = "25.00"` against 750,000 |

## Edge cases

- `target_months` 0 or 13, `monthly_essentials_cents` 0, a negative balance or contribution, or a float amount: 422.
- A balance far above the target: `funded_pct` is 100.00, never more.
- A contribution larger than the shortfall: `months_to_target = 1`.
- A user with no profile and no pay stub: the first contribution date comes from `P` with no anchor (spec 007 rule 16).
- A goal whose linked account is unlinked keeps its row with `account_id` null (spec 001 rule 25); `GET /goals` then shows no balance.
- PATCH with `account_id` of the user's own account that is inactive is allowed; the balance read still uses its latest snapshot.

## Out of scope

- Interest on the fund, inflation, and irregular contributions.
- Custom goals (`goal_kind = custom`): the table allows them; no route creates them yet.
- Explaining an emergency-fund decision. Spec 008's verifier requires at least one curated IRS citation and none applies; `POST /explain` on such a decision is 422 `explanation_unavailable` until a later spec settles what a non-tax explanation cites.
- Checking progress against the plan each month (the check-in's `goal_off_pace` finding, M8).
