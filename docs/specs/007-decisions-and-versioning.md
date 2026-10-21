# 007: Decisions, versioning, the calendar and the spending summary

Status: Implemented, M3. Part B (`GET /spending/summary`) is pulled forward from M5 because the Spending tiles need it.

## Goal

Save the calculator result a user picks as an immutable, versioned `decisions` row that the server has recomputed itself, show the current decision per calculator with its history, and turn a decision into the dated checkpoint it implies (`calendar_events`). Code: migration `api/alembic/versions/0004_decisions.py`, `api/app/routers/decisions.py`, `api/app/routers/calendar.py`, `api/calc/registry.py`, `api/calc/pay_dates.py`, `api/decisions/` (save and side effects). Part B adds `GET /spending/summary` (`api/app/routers/spending.py`, `api/calc/spending.py`), a read-only total of the user's transactions by spending bucket.

## Inputs

### `POST /decisions`

| Field | Type | Meaning and validation |
|---|---|---|
| `calculator` | `calculator_kind` | `emergency_fund`, `k401_match`, `health_plans`, `w4`. Only `k401_match` is registered in M3; the others are 422 `calculator_unavailable`. |
| `inputs` | object | The calculator's input model (for `k401_match`, the request body of `POST /calc/401k-match`, spec 006). Invalid inputs are 422 `validation_error`. |
| `result` | object | The result the user saw, as `POST /calc/...` returned it. |
| `supersedes_id` | uuid or null | The current decision for this calculator, or null when there is none. |

### Reads

`GET /decisions`, `GET /decisions/{id}`, `GET /calendar`: no parameters. `GET /spending/summary`: optional `start` and `end` (ISO dates, inclusive).

## Outputs

- `POST /decisions` is 201 with `DecisionSaved`: `decision_id`, `calculator`, `version`, `supersedes_id`, `created_at`, `calendar_event_id` (null when the decision implies none) and `goal_id` (always null for `k401_match`).
- `DecisionOut`: `id`, `calculator`, `version`, `supersedes_id`, `check_in_id`, `inputs`, `result`, `created_at`, `is_current`.
- `GET /decisions` returns `DecisionList`: `items`, one `CalculatorDecisions` per calculator the user has saved, in `calculator_kind` order: `calculator`, `current` (a `DecisionOut`) and `versions` (every version, newest first, as `DecisionVersion`: `id`, `version`, `supersedes_id`, `created_at`).
- `GET /decisions/{id}` returns `DecisionOut` for any version the user owns; another user's id is 404.
- `GET /calendar` returns `CalendarEventOut` items (`id`, `kind`, `title`, `due_at`, `decision_id`, `status`) with status `upcoming`, ordered by `due_at`, then `created_at`.
- `GET /spending/summary`: see Part B.

## Rules

### Saving a decision

1. **Registry.** `calc/registry.py` maps each registered calculator name to its input model, result model and pure function. A test asserts every registered name is a `calculator_kind` value.
2. **Validate, recompute, compare.** The route validates `inputs` with the input model, runs the calculator, validates `result` with the result model and compares the two models field by field (Decimal fields compare by value, so `"5"` equals `"5.00"`). Any difference is 422 `result_mismatch` with `details.fields` naming the differing fields. A `result` that does not validate is also `result_mismatch`. The client's `result` is never stored.
3. **Canonical storage.** `decisions.inputs` and `decisions.result` hold the server's `model_dump(mode="json")` of the validated input and the recomputed result: money as integer cents, percentages as two-place strings, `tax_year` inside `inputs`.
4. **Version.** With `supersedes_id` null the row is version 1. With `supersedes_id` set, the parent must be visible to the user (else 404 `not_found`, which is what another user's id gives), have the same calculator (else 422 `supersedes_mismatch`) and be current (else 409 `decision_conflict`); the new row is `parent.version + 1`.
5. **Conflicts.** A version 1 when one already exists, or a second successor to the same parent, violates `UNIQUE (user_id, calculator, version)` or the partial unique index on `supersedes_id`; the route returns 409 `decision_conflict` and writes nothing. Concurrent saves of the same next version therefore cannot both succeed.
6. **One writer.** `POST /decisions` is the only code that inserts decisions. `/calc/*` routes save nothing.

### Database (migration `0004_decisions`)

7. `decisions` follows spec 001 rules 13-18 and its table: `calculator calculator_kind`, `inputs jsonb` and `result jsonb` (both `CHECK (jsonb_typeof(...) = 'object')`), `version integer CHECK (version >= 1)`, `supersedes_id` with the composite same-user foreign key `(supersedes_id, user_id) -> decisions(id, user_id) ON DELETE CASCADE`, `check_in_id uuid` (nullable; its foreign key to `check_ins` arrives with `0005`), `UNIQUE (user_id, calculator, version)` (whose index also serves the version history), `UNIQUE (id, user_id)`, the partial unique index on `supersedes_id` and `CHECK ((version = 1) = (supersedes_id IS NULL))`.
8. **Insert trigger** (`decisions_check_parent`, `BEFORE INSERT`): when `supersedes_id` is set, the parent must exist with the same `user_id` and `calculator` and `version = NEW.version - 1`; otherwise it raises.
9. **Immutability trigger** (`decisions_immutable`, `BEFORE UPDATE OR DELETE`): every `UPDATE` raises. A `DELETE` raises unless it is the cascade from deleting the owner's `auth.users` row, recognised by two conditions together: `pg_trigger_depth() > 1` (the delete was issued by another trigger, here the foreign key's cascade action) and the owner's `auth.users` row no longer exists in this transaction. A direct `DELETE` runs at depth 1 and raises before anything is removed. This settles spec 001 open question 1: account deletion works, and nothing else can remove a decision.
10. **Policies.** RLS is enabled and forced. `authenticated` holds `SELECT` and `INSERT` only. `SELECT` is the owner policy. `INSERT` checks `user_id = current_user_id()` and, when `supersedes_id` is set, that the superseded row exists with `user_id = current_user_id()`. There is no `UPDATE` or `DELETE` policy.
11. **Current decisions.** The view `current_decisions` (`WITH (security_invoker = true)`, so RLS applies) holds the rows no other row supersedes. `authenticated` may select from it.
12. **Children of a decision.** `goals.decision_id`, `calendar_events.decision_id` and `explanations.decision_id` are composite same-user foreign keys to `decisions(id, user_id)` with `ON DELETE CASCADE`. Decisions are deleted only by account deletion (rule 9), so the cascade only ever runs then.
13. **`goals`** per spec 001 (`goal_kind`: `emergency_fund`, `custom`), with `account_id` as a composite foreign key to `accounts` `ON DELETE SET NULL (account_id)`. **`calendar_events`** per spec 001 with `calendar_kind` extended by `election_check` (a checkpoint that a saved election shows up on a pay stub) and `calendar_status` (`upcoming`, `done`, `dismissed`). Both have the owner policy and the full grant set; `calendar_events` has the index `(user_id, due_at)`.

### Side effects of a saved decision

14. **401(k).** Saving a `k401_match` decision creates no goal and one `calendar_events` row: kind `election_check`, title "Check that your next pay stub shows your new 401(k) contribution", `due_at` the next expected pay date (rule 16), linked to the new decision. The previous version's `upcoming` `election_check` events become `dismissed` in the same transaction, so the calendar shows one check per calculator.
15. Side effects run in the same transaction as the insert; a failure saves nothing.
16. **Next expected pay date** (`calc/pay_dates.py:next_pay_date(frequency, anchor, today)`, pure). `today` is the request's UTC date. `frequency` is the profile's `pay_frequency`, or, when the profile has none, the one matching the decision's `pay_periods_per_year` (52 weekly, 26 biweekly, 24 semimonthly, 12 monthly). `anchor` is the latest confirmed pay stub's `pay_date`, or none. The result is the first date strictly after `today` in the schedule:
    - weekly and biweekly: `anchor + k * 7` or `anchor + k * 14` days for any integer `k`;
    - monthly: the anchor's day of month in every month, clamped to the month's last day;
    - semimonthly: the 15th and the last day of every month when the anchor is the 15th or a month's last day; otherwise the anchor's day `d` and `d + 15` (when `d <= 15`) or `d - 15` and `d` (when `d > 15`), each clamped to the month's last day;
    - no anchor: weekly `today + 7`, biweekly `today + 14`, semimonthly the next 15th or month end, monthly the next month end.

### Reads

17. `GET /decisions` lists only calculators with at least one decision. `current` is the `current_decisions` row; `versions` holds every row of the chain, newest first.
18. `GET /decisions/{id}` sets `is_current` from `current_decisions`.
19. `GET /calendar` returns only `upcoming` events; done and dismissed events stay in the table for the plan export (M9).

## Part B: `GET /spending/summary`

### Inputs

`start` and `end`, inclusive ISO dates. Both or neither: one alone is 422. `start > end` is 422, as is a span over 366 days. Without them the period is the last complete calendar month in UTC (on 2026-10-21 that is 2026-09-01 to 2026-09-30).

### Outputs (`SpendingSummary`)

`start`, `end`, `income_cents`, `essentials_cents`, `flexible_cents`, `savings_cents`, `other_cents`, `transfers_ignored_cents`, `uncategorized_cents`, `left_over_cents`, `essentials_pct`, `flexible_pct`, `savings_rate_pct` (Decimal strings with one decimal place, or null when income is not positive), `transaction_count`, `uncategorized_count`, `paycheck_count`, `categories` (one `CategoryTotal` per category with transactions: `category`, `bucket`, `total_cents`, `count`, in category list order) and `category_buckets` (every category to its bucket).

### Rules

20. **Buckets** live in `sync/categories.py` (`CATEGORY_BUCKETS`), next to the category list, and cover every category: `income` (income); `essentials` (housing, utilities, phone_internet, groceries, transport, insurance, healthcare); `flexible` (dining, subscriptions, shopping, entertainment, travel, personal_care, education, gifts_donations); `savings` (savings_investment); `other` (debt_payment, fees, taxes, other); `transfer` (transfer).
21. **Which transactions.** Posted (`pending = false`) transactions of active accounts with `posted_at` in the period, read under RLS. The per-category sums and counts are one SQL `GROUP BY category`; the bucket roll-up and percentages are `calc/spending.py:summarize`, a pure function.
22. **Signs** follow spec 001 rule 21 (positive is money out). `income_cents` is minus the net amount of `income` transactions. `essentials_cents`, `flexible_cents`, `savings_cents` and `other_cents` are the net amounts of their buckets, so refunds reduce spending. A category's `total_cents` is reported in the same direction as its bucket (income positive when money came in).
23. **Ignored and uncategorized.** `transfer` transactions are left out of every total; `transfers_ignored_cents` is the sum of their absolute amounts. Uncategorized transactions (category null) are left out of the buckets and reported as `uncategorized_count` and `uncategorized_cents` (net, positive out).
24. `left_over_cents = income - essentials - flexible - savings - other`; it can be negative.
25. Percentages are `bucket / income * 100` rounded half up to one decimal place: `essentials_pct`, `flexible_pct`, and `savings_rate_pct` (savings over income). Null when `income_cents <= 0`.
26. `transaction_count` counts every transaction in the period (all buckets, transfers and uncategorized included). `paycheck_count` counts the user's confirmed pay stubs with `pay_date` in the period.

## Hand-worked examples

### Decisions (`api/tests/integration/test_decisions.py`)

| # | Test | Setup | Expected |
|---|---|---|---|
| 1 | `test_v2_supersedes_v1` | A saves example 1 of spec 006, then the same inputs at 4% with `supersedes_id = v1` | 201 twice, versions 1 and 2; `GET /decisions` has `current.version == 2` and two versions |
| 2 | `test_second_v2_rejected` | A saves v2 against v1 twice | Second is 409 `decision_conflict`; still two rows |
| 3 | `test_second_v1_rejected` | A saves v1 twice with `supersedes_id = null` | Second is 409 |
| 4 | `test_direct_update_raises` | `UPDATE decisions` as the table owner (privileged) | Raises from `decisions_immutable` |
| 5 | `test_direct_delete_raises` | `DELETE FROM decisions` as the table owner | Raises from `decisions_immutable` |
| 6 | `test_account_deletion_cascades` | Delete A's `auth.users` row with a v1, v2, an event and an explanation | Succeeds; every one of A's rows is gone |
| 7 | `test_cannot_supersede_other_users_decision` | B posts v2 with `supersedes_id` = A's v1 | 404; the insert policy and composite key also reject the raw insert |
| 8 | `test_result_mismatch_is_422` | `result.missed_cents` off by one cent | 422 `result_mismatch`, `details.fields == ["missed_cents"]`; no row |
| 9 | `test_calendar_event_created` | Biweekly profile, latest stub paid 2026-10-16, today 2026-10-21 | One `election_check` event due 2026-10-30 |
| 10 | `test_superseded_event_dismissed` | Save v1 then v2 | v1's event `dismissed`, v2's `upcoming`; `GET /calendar` lists only v2's |

### Next pay date (`api/tests/unit/calc/test_pay_dates.py`)

| Frequency | Anchor | Today | Next |
|---|---|---|---|
| biweekly | 2026-10-16 | 2026-10-21 | 2026-10-30 |
| biweekly | 2026-10-30 (a future stub) | 2026-10-21 | 2026-10-30 |
| weekly | 2026-10-16 | 2026-10-23 | 2026-10-30 |
| semimonthly | 2026-10-15 | 2026-10-21 | 2026-10-31 |
| semimonthly | 2026-10-31 | 2026-10-31 | 2026-11-15 |
| semimonthly | 2026-10-10 | 2026-10-21 | 2026-10-25 |
| semimonthly | 2026-10-20 | 2026-10-21 | 2026-11-05 |
| monthly | 2026-01-31 | 2026-02-10 | 2026-02-28 |
| monthly | none | 2026-10-21 | 2026-10-31 |
| biweekly | none | 2026-10-21 | 2026-11-04 |

### Spending summary (`api/tests/integration/test_spending_summary.py`)

September 2026, one checking account: paycheck -199,604 and -199,604 (income); rent 150,000 (housing); groceries 32,000 and a refund of -2,000 (groceries); dining 8,500; transfer to savings 40,000 (savings_investment); transfer between own accounts 25,000 (transfer); credit card fee 3,900 (fees); an uncategorized 1,200; a pending 9,999 dining (ignored); an August dining 5,000 (outside the period); two confirmed pay stubs paid in September.

- `income_cents = 399,208`; `essentials_cents = 150,000 + 30,000 = 180,000`; `flexible_cents = 8,500`; `savings_cents = 40,000`; `other_cents = 3,900`; `transfers_ignored_cents = 25,000`; `uncategorized_cents = 1,200`.
- `left_over_cents = 399,208 - 180,000 - 8,500 - 40,000 - 3,900 = 166,808`.
- `essentials_pct = 180,000 / 399,208 * 100 = 45.089...`, "45.1"; `flexible_pct = 2.129...`, "2.1"; `savings_rate_pct = 10.019...`, "10.0".
- `transaction_count = 10` (the pending and August rows excluded); `uncategorized_count = 1`; `paycheck_count = 2`.

## Edge cases

- A `supersedes_id` for a decision of a different calculator is 422 `supersedes_mismatch`; for a superseded (not current) row it is 409.
- A tax year without constants is 422 from input validation, before anything is saved.
- A user with no profile and no pay stub still gets an event, dated from `pay_periods_per_year` with no anchor.
- A month with no income gives null percentages and a negative or zero `left_over_cents`.
- A summary period with no transactions returns zeros, empty `categories`, and the full `category_buckets`.

## Out of scope

- Decisions for the other three calculators (M6, M7), goals created by decisions (M6), and `check_in_id` links (M8).
- Editing or deleting a decision. A new version is the only change; account deletion is the only removal.
- Calendar events for enrollment deadlines and tax season (M8, M9).
- Recurring charges and cash flow in the spending summary (M5).
