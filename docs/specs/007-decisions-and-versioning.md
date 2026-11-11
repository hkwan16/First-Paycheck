# 007: Decisions, versioning, the calendar and the spending summary

Status: Implemented, M3. Part B (`GET /spending/summary`) is pulled forward from M5 because the Spending tiles need it. Rule 22a (income counts money in only) added in M10 after the October 22 production walkthrough showed negative income on a Plaid sandbox history. Rule 21a (cash accounts only) and the share limit of rule 25 added after the same walkthrough with Plaid's `user_transactions_dynamic` sandbox user, whose loan ledgers drove the summary (`uncategorized_cents` -5,498,010) and whose 12 cents of income gave an `essentials_pct` of 304000.0. Rules 19a-19e (a saved decision whose context changed needs review) added for issue 222.

## Goal

Save the calculator result a user picks as an immutable, versioned `decisions` row that the server has recomputed itself, show the current decision per calculator with its history, and turn a decision into the dated checkpoint it implies (`calendar_events`). Code: migration `api/alembic/versions/0004_decisions.py`, `api/app/routers/decisions.py`, `api/app/routers/calendar.py`, `api/calc/registry.py`, `api/calc/pay_dates.py`; the save and its side effects live in the decisions router. Part B adds `GET /spending/summary` (`api/app/routers/spending.py`, `api/calc/spending.py`), a read-only total of the user's transactions by spending bucket.

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
- `DecisionOut`: `id`, `calculator`, `version`, `supersedes_id`, `check_in_id`, `inputs`, `result`, `created_at`, `is_current`, `review` (what changed since it was saved, rules 19a-19e).
- `GET /decisions` returns `DecisionList`: `items`, one `CalculatorDecisions` per calculator the user has saved, in `calculator_kind` order: `calculator`, `current` (a `DecisionOut`) and `versions` (every version, newest first, as `DecisionVersion`: `id`, `version`, `supersedes_id`, `created_at`).
- `GET /decisions/{id}` returns `DecisionOut` for any version the user owns; another user's id is 404.
- `GET /calendar` returns `CalendarEventOut` items (`id`, `kind`, `title`, `due_at`, `decision_id`, `status`) with status `upcoming`, ordered by `due_at`, then `created_at`; spec 015 rule 22 leaves out the dates a check-in finding settled and adds `overdue`.
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
16. **Next expected pay date** (`calc/pay_dates.py:next_pay_date(frequency, anchor, today)`, pure). `today` is the person's today (spec 019 rule 2). `frequency` is the user's pay schedule (spec 005 rule 25a: the newest current stub's `pay_frequency`, else the profile's; issue 198), or, when there is none, the one matching the decision's `pay_periods_per_year` (52 weekly, 26 biweekly, 24 semimonthly, 12 monthly). `anchor` is the latest current confirmed pay stub's `pay_date` (a superseded copy never counts, spec 005 rule 22d), or none. The result is the first date strictly after `today` in the schedule:
    - weekly and biweekly: `anchor + k * 7` or `anchor + k * 14` days for any integer `k`;
    - monthly: the anchor's day of month in every month, clamped to the month's last day;
    - semimonthly: the 15th and the last day of every month when the anchor is the 15th or a month's last day; otherwise the anchor's day `d` and `d + 15` (when `d <= 15`) or `d - 15` and `d` (when `d > 15`), each clamped to the month's last day;
    - no anchor: weekly `today + 7`, biweekly `today + 14`, semimonthly the next 15th or month end, monthly the next month end.

### Reads

17. `GET /decisions` lists only calculators with at least one decision. `current` is the `current_decisions` row; `versions` holds every row of the chain, newest first.
18. `GET /decisions/{id}` sets `is_current` from `current_decisions`.
19. `GET /calendar` returns only `upcoming` events; done and dismissed events stay in the table for the plan export (M9). Spec 015 rule 24 narrows this to open events: an `upcoming` one whose date the person settled from a check-in finding is left out too.

### A decision that needs review (issue 222)

Some of a decision's inputs are not what the person chose but what its step read when it was saved: the pay schedule, the salary, the tax year. When one of those changes (issue 222: a newer stub moved the account from 26 to 24 paychecks a year), the saved result is figured for a paycheck that no longer exists, yet before this rule the steps opened as "Changes not saved" with nothing touched, the side nav ticked them done, and the plan and its PDF printed the old per-paycheck figures as current. The API decides it, once, so the steps, the side nav, the Plan page and the PDF agree.

19a. **Context inputs.** For each calculator, the inputs a step reads rather than asks, and where the step reads each now:

    | Calculator | Input | Now |
    |---|---|---|
    | every calculator | `pay_periods_per_year` | the pay schedule's `periods_per_year` (spec 005 rule 25a) |
    | `k401_match`, `health_plans`, `w4` | `salary_cents` | the profile's `salary_cents` |
    | `k401_match`, `health_plans`, `w4` | `tax_year` | the newest current stub's `tax_year` |
    | `k401_match`, `health_plans` | `filing_status` | the profile's `filing_status` |
    | `k401_match`, `w4` | `age` | `tax_year - birth_year` from the profile; for the W-4, null without a birth year or with one after the tax year |
    | `k401_match` | `match_tiers` | the profile's `match_tiers` |
    | `w4` | `k401_contribution_pct` | the current `k401_match` decision's `contribution_pct`, else 0 |
    | `w4` | `health_premium_per_paycheck_cents` | the current `health_plans` decision's selected plan's `premium_per_period_cents`, else 0 |

    Everything else is the person's choice and never makes a decision need review: the contribution, the plans compared, the plan chosen, the HSA amount, the usage and the enrollment deadline, the W-4's filing status and entries, and the emergency fund's essentials, months, savings and transfer. So is the W-4's `current_withholding_per_paycheck_cents`, which describes payroll today (spec 014 rule 17a).
19b. **Review reasons.** `DecisionOut.review` (`GET /decisions`, `GET /decisions/{id}`) and `PlanDecision.review` (spec 016) are a list of `ReviewReason`: `kind` (`changed` or `salary_unconfirmed`), `input` (the input it is about) and `text`. It is empty when nothing needs review, and always empty for a version that is not current. For a current decision, `app/decision_review.py:review` validates the stored inputs with the calculator's registered input model (so a field an older row lacks reads as its default) and compares each context input of rule 19a with its value now, read once per request (`load_context`: the profile, its pay schedule, the newest current stub, its salary check and the current 401(k) and health plan decisions). Values compare by value: cents and counts as integers, percentages as `Decimal` (`"5"` equals `"5.00"`), tiers by their two percentages. Each input that differs is one `changed` reason, in rule 19a's order. An input whose value now is unknown (no salary, no pay schedule, no confirmed stub, no birth year for the 401(k)) is not compared: the step cannot calculate then either, and says what it needs instead.
19c. **An open salary question.** While spec 005 rule 24c's `salary_review` is set, a current `k401_match`, `health_plans` or `w4` decision also has one reason of kind `salary_unconfirmed` (input `salary_cents`) after its changed ones, whatever its inputs: its numbers rest on a salary and a pay schedule that may come from different stubs, which the person has not settled.
19d. **Words.** Each reason's `text` is one plain sentence (spec 008 rule 22a), written once by the API so every surface says the same, with money in `verify.format.dollars` and percentages in `verify.format.percent`:

    | Reason | Text |
    |---|---|
    | `pay_periods_per_year` | Your pay schedule changed from 26 to 24 paychecks a year. |
    | `salary_cents` | Your yearly salary changed from $95,000.10 to $64,999.92. |
    | `tax_year` | The tax year changed from 2026 to 2027. |
    | `filing_status` | Your filing status changed from single to married filing jointly. |
    | `age` | Your age at the end of the tax year changed from 24 to 25. (For the W-4 without a birth year then or now: "Your birth year was added." or "Your birth year was removed.") |
    | `match_tiers` | Your employer match changed from 100% of the first 3%, then 50% up to 5% to 100% of the first 4%. |
    | `k401_contribution_pct` | Your 401(k) decision changed from 5% to 6%. |
    | `health_premium_per_paycheck_cents` | Your health plan's premium changed from $4.00 to $62.50 a paycheck. |
    | `salary_unconfirmed` | Your newest pay stub comes to $64,999.92 a year, not the $95,000.10 in your plan details. Choose which salary to use. |

19e. **Nothing is stored.** The reasons are computed on every read; the decision stays immutable (rule 9). A decision stops needing review when a new version is saved from the inputs of now, or when what changed changes back.

## Part B: `GET /spending/summary`

### Inputs

`start` and `end`, inclusive ISO dates. Both or neither: one alone is 422. `start > end` is 422, as is a span over 366 days. Without them the period is the last complete calendar month before the person's today (spec 019; on 2026-10-21 that is 2026-09-01 to 2026-09-30).

### Outputs (`SpendingSummary`)

`start`, `end`, `income_cents`, `essentials_cents`, `flexible_cents`, `savings_cents`, `other_cents`, `transfers_ignored_cents`, `income_outflows_ignored_cents`, `uncategorized_cents`, `left_over_cents`, `essentials_pct`, `flexible_pct`, `savings_rate_pct` (Decimal strings with one decimal place, or null when there is no income or too little to compare with, rule 25), `transaction_count`, `uncategorized_count`, `paycheck_count`, `ledger_rows_skipped` (`count` and `net_cents` of the rows on loan, investment and retirement accounts, rule 21a), `categories` (one `CategoryTotal` per category with transactions counted in its bucket: `category`, `bucket`, `total_cents`, `count`, in category list order), `category_buckets` (every category to its bucket) and `account_kinds_counted` (the account kinds whose rows the totals read, in `account_kind` order: `checking`, `savings`, `credit`).

### Rules

20. **Buckets** live in `sync/categories.py` (`CATEGORY_BUCKETS`), next to the category list, and cover every category: `income` (income); `essentials` (housing, utilities, phone_internet, groceries, transport, insurance, healthcare); `flexible` (dining, subscriptions, shopping, entertainment, travel, personal_care, education, gifts_donations); `savings` (savings_investment); `other` (debt_payment, fees, taxes, other); `transfer` (transfer).
21. **Which transactions.** Posted (`pending = false`) transactions of active `checking`, `savings` and `credit` accounts (rule 21a) with `posted_at` in the period, read under RLS. The per-category sums and counts are one SQL `GROUP BY category`; the bucket roll-up and percentages are `calc/spending.py:summarize`, a pure function.
21a. **Cash accounts only.** The summary reads rows on the accounts money is spent from and saved in: `checking`, `savings` and `credit` (`SPENDING_ACCOUNT_KINDS` in `api/db/accounts.py`, returned as `account_kinds_counted`; recurring detection reads the same accounts, spec 009 rule 1a). Rows on `loan`, `investment` and `retirement` accounts (`LEDGER_ACCOUNT_KINDS`) are that account's own bookkeeping, not cash the user spent or received: a loan books the payment it received as money in, though that payment is the transfer that already left checking, and books accrued interest as money out, though no cash left an account; an investment or retirement account books contributions, dividends and trades inside the account. Counting them would add every loan payment twice (once as the checking outflow, once as the loan's inflow) and could make it income. They are left out of every bucket, of `uncategorized_*` and of `transaction_count`, whatever their category, and reported as `ledger_rows_skipped`: `count`, the number of such posted rows in the period on active accounts, and `net_cents`, their sum (net, positive is money out, like `uncategorized_cents`). Every `account_kind` belongs to exactly one of the two sets; a new kind must be placed in one (a unit test checks it). `GET /transactions` lists every account's rows by default; with `cash_accounts_only=true` (spec 003 rule 17) it lists only rows on active accounts of these kinds, which is how the Spending screen lists the period it totals (issue 200: its list showed the loans' "Monthly payment" and "Interest charged" rows, unmarked, under totals that left them out).
22. **Signs** follow spec 001 rule 21 (positive is money out). `income_cents` is the money that came in under `income`: the sum of the magnitudes of the negative amounts of `income` transactions (rule 22a), so it is never negative. `essentials_cents`, `flexible_cents`, `savings_cents` and `other_cents` are the net amounts of their buckets, so refunds reduce spending. A category's `total_cents` is reported in the same direction as its bucket (income positive when money came in), and its `count` is the number of transactions behind that total.
22a. **Income counts money in only.** An `income` transaction that is money out (amount above 0) is not income. Banks usually book payroll as money in, but the Plaid sandbox books its GUSTO PAY payroll as money out (585,000) while the seed rules label it `income`, and a mislabel or a payroll reversal can do the same; netting such a row would make income negative and every figure derived from it wrong. The row is left out of every total, like a transfer, and reported as `income_outflows_ignored_cents`, the sum of those amounts. `left_over_cents` (rule 24) and the percentages (rule 25) follow from the money-in `income_cents`. An `income` row of exactly 0 is counted as income (it adds nothing). The `income` category's `total_cents` equals `income_cents`, its `count` leaves the money-out rows out, and it is listed in `categories` only when that count is above 0. The other buckets keep netting (refunds reduce spending, a withdrawal reduces savings).
23. **Ignored and uncategorized.** `transfer` transactions are left out of every total; `transfers_ignored_cents` is the sum of their absolute amounts. Money-out `income` transactions are left out too (rule 22a) and reported apart from transfers in `income_outflows_ignored_cents`, so `transfers_ignored_cents` stays the money moved between the user's own accounts. Uncategorized transactions (category null) are left out of the buckets and reported as `uncategorized_count` and `uncategorized_cents` (net, positive out).
24. `left_over_cents = income - essentials - flexible - savings - other`; it can be negative.
25. **Shares of income.** Percentages are `bucket / income * 100` rounded half up to one decimal place: `essentials_pct`, `flexible_pct`, and `savings_rate_pct` (savings over income). A share is null when `income_cents` is 0, or when its size would exceed 1,000.0 (`|bucket| > 10 * income`, compared exactly in cents before rounding: income under a tenth of the bucket's size), because a share of a few cents of income says nothing about the month. A share of exactly 1,000.0 is shown. The limit is on the size, so a negative bucket (a refund-heavy month, or a payroll the categorizer filed under a spending category) gives a negative share that is shown within the limit and null beyond it. Each share is judged on its own: one can be null while another is shown. The client prints a null share as "Too little income to compare"; it never works one out. Every share the cash-flow and check-in routes return is this summary's.
26. `transaction_count` counts every transaction the summary reads in the period (all buckets, transfers, ignored income outflows and uncategorized included; rows on ledger accounts are counted in `ledger_rows_skipped` instead, rule 21a). `paycheck_count` counts the user's current confirmed pay stubs with `pay_date` in the period: a stub another confirm superseded (spec 005 rules 22a-22d, issue 190) is not counted, so a stub confirmed twice counts once.
26a. **Words say what each number counts.** `paycheck_count` counts pay stubs, not paychecks: a paycheck can be deposited in a period with no stub confirmed for it, and a confirmed stub of another period is not in it. `income_cents` is deposits (money in labeled `income`, rule 22a), whether or not a stub exists for them. So a screen names the count as pay stubs in the period ("2 pay stubs", "1 pay stub", "no pay stub"), never as paychecks, and names income "Income deposited" ("Pay and other income into your accounts"), a statement apart from the count, never as "N paychecks, after taxes and deductions". Issue #164: a September with $4,050.12 deposited read "Income $4,050.12, 0 paychecks, after taxes and deductions" for a user whose one confirmed stub was paid in April. The Spending summary's heading reads "September 1 to 30 · no pay stub" and its first tile "Income deposited" (`web/src/components/screens/spending/spending-format.ts:payStubsText`); spec 010 rule 5a has the diagram's words and the check-in's. Issue #200: the tile read "Income $4,050.12" beside a diagram that starts from "Gross pay, 1 stub $2,708.33", with nothing saying the first is deposits in the bank and the second the pay stub's pay before deductions, so a person read two incomes. Both are right: the deposits can include pay with no confirmed stub, and gross pay is before taxes. The tile says it is deposits, and the diagram says which half comes from which (spec 010 rule 5a).

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

### Needs review (`api/tests/integration/test_decision_review.py`, rules 19a-19e; the texts in `api/tests/unit/test_decision_review.py`)

Issue 222's account: stub-01 confirmed (biweekly, paid 2026-04-10), plan details saved at $95,000.10 against it (single, 100% of the first 3% then 50% up to 5%, born 2002), and three decisions saved through `POST /decisions` on 26 paychecks: the 401(k) at 5%, the health plan with Value HMO at $4.00 a paycheck chosen, and the W-4 of spec 014 example 11 (5%, $4.00). Then the Acme stub is confirmed (semimonthly, paid 2026-10-15).

| # | Test | Then | `review` of each current decision |
|---|---|---|---|
| 1 | `test_every_decision_is_current_before_the_new_stub` | nothing more | 401(k), health plan and W-4: `[]` |
| 2 | `test_issue_222_a_newer_stub_on_another_schedule` | the Acme stub confirmed | each: `changed` `pay_periods_per_year` "Your pay schedule changed from 26 to 24 paychecks a year.", then `salary_unconfirmed` (spec 005 rule 24c: 6,499,992 against 9,500,010) |
| 3 | `test_keeping_the_salary_leaves_the_schedule` | row 2, then "Keep $95,000.10" | each: the schedule only |
| 4 | `test_using_the_stubs_salary_changes_it_too` | row 2, then "Use $64,999.92" | each: the schedule, then `salary_cents` "Your yearly salary changed from $95,000.10 to $64,999.92." |
| 5 | `test_saving_again_clears_it` | row 4, then each saved again with the inputs of now | each `[]`; the earlier versions `[]` too, as versions that are not current |
| 6 | `test_the_w4_follows_the_other_decisions` | row 1, then the 401(k) saved at 6% | the W-4: `k401_contribution_pct` "Your 401(k) decision changed from 5% to 6%."; the 401(k) `[]` |
| 7 | `test_a_new_tax_year` | row 1, then a stub-01 copy paid 2027-01-08 | 401(k) and W-4: `tax_year` 2026 to 2027 and `age` 24 to 25; health plan: `tax_year` |
| 8 | `test_plan_details_changes` | row 1, then the profile at married filing jointly with 100% of the first 4% | 401(k): `filing_status` and `match_tiers`; health plan: `filing_status`; the W-4 (whose filing status is its own entry): `[]` |
| 9 | `test_the_emergency_fund_reads_the_schedule_only` | an emergency fund saved on 26 paychecks, then the Acme stub, salary kept | `pay_periods_per_year` only, never `salary_unconfirmed` |
| 10 | `test_nothing_known_nothing_compared` | a 401(k) decision with no stub and no profile | `[]` |

`GET /decisions/{id}` reports the same `review` as `GET /decisions` for the current version (row 2) and `[]` for a superseded one (row 5).

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

- `income_cents = 399,208`; `essentials_cents = 150,000 + 30,000 = 180,000`; `flexible_cents = 8,500`; `savings_cents = 40,000`; `other_cents = 3,900`; `transfers_ignored_cents = 25,000`; `income_outflows_ignored_cents = 0`; `uncategorized_cents = 1,200`.
- `left_over_cents = 399,208 - 180,000 - 8,500 - 40,000 - 3,900 = 166,808`.
- `essentials_pct = 180,000 / 399,208 * 100 = 45.089...`, "45.1"; `flexible_pct = 2.129...`, "2.1"; `savings_rate_pct = 10.019...`, "10.0".
- `transaction_count = 10` (the pending and August rows excluded); `uncategorized_count = 1`; `paycheck_count = 2`; `ledger_rows_skipped` is `count = 0`, `net_cents = 0`.

### Income-labeled money out (rule 22a; `api/tests/unit/calc/test_spending.py`)

One month: a paycheck -200,000 and interest -422 (income); the payroll a bank booked as money out, 585,000 (income); rent 50,000 (housing); dining 1,633.

- `income_cents = 200,000 + 422 = 200,422`; the 585,000 row is not income: `income_outflows_ignored_cents = 585,000`, `transfers_ignored_cents = 0`. (Netting it, as before rule 22a, gave `200,422 - 585,000 = -384,578`.)
- `essentials_cents = 50,000`; `flexible_cents = 1,633`; `savings_cents = other_cents = 0`.
- `left_over_cents = 200,422 - 50,000 - 1,633 = 148,789`.
- `essentials_pct = 50,000 / 200,422 * 100 = 24.947...`, "24.9"; `flexible_pct = 0.814...`, "0.8"; `savings_rate_pct = 0`, "0.0".
- `transaction_count = 5`; the `income` category is `total_cents = 200,422`, `count = 2`.
- The money-out row alone: `income_cents = 0`, `income_outflows_ignored_cents = 585,000`, null percentages, `left_over_cents = 0`, and no `income` entry in `categories`.

### The Plaid sandbox's October (rule 22a; `api/tests/integration/test_spending_summary.py`)

The recorded sandbox item (`api/tests/fixtures/plaid/recorded`) synced through `run_sync` and labeled by the seed rules alone, October 2026: INTRST PYMNT -422 and ACH Electronic CreditGUSTO PAY 585,000 (income); Uber 540 (transport); Starbucks 433, McDonald's 1,200 and KFC 50,000 (dining); SparkFun 8,940 and Madison Bicycle Shop 50,000 (shopping); Touchstone Climbing 7,850 (entertainment); United Airlines -50,000 (travel, a refund); CD DEPOSIT .INITIAL. 100,000 (savings_investment); CREDIT CARD 3333 PAYMENT 2,500 and AUTOMATIC PAYMENT - THANK 207,850 (transfer); Tectra Inc 50,000 (no rule, uncategorized).

- `income_cents = 422` (was -584,578); `income_outflows_ignored_cents = 585,000`; `transfers_ignored_cents = 2,500 + 207,850 = 210,350`.
- `essentials_cents = 540`; `flexible_cents = 433 + 1,200 + 50,000 + 8,940 + 50,000 + 7,850 - 50,000 = 68,423`; `savings_cents = 100,000`; `other_cents = 0`; `uncategorized_cents = 50,000`.
- `left_over_cents = 422 - 540 - 68,423 - 100,000 = -168,541` (was -753,541): this month really did spend beyond the 4.22 that came in.
- `essentials_pct = 540 / 422 * 100 = 127.96...`, "128.0" (540 is within 10 * 422 = 4,220); `flexible_pct` null (68,423 > 4,220: 16,213.98... would exceed 1,000.0); `savings_rate_pct` null (100,000 > 4,220: 23,696.68...). Rule 25 drops the two shares that compare spending with almost nothing deposited.
- `transaction_count = 14`; `uncategorized_count = 1`; `paycheck_count = 0`; the `income` category is `total_cents = 422`, `count = 1`.
- Every row is on a checking, savings or credit account (the CD and money market accounts are `savings`), so `ledger_rows_skipped` is `count = 0`, `net_cents = 0`.

### A loan ledger (rule 21a; `api/tests/integration/test_spending_summary.py`, `tests/support/spending_month.py:loan_ledger_month`)

September 2026. Checking: a paycheck -250,000 (income), rent 120,000 (housing), the auto loan payment 40,000 (debt_payment), the credit card payment 20,000 (transfer). Credit card: groceries 20,000 (groceries), the payment received -20,000 (transfer). Auto loan (`loan`): "Monthly payment" -40,000, the same payment as the loan books it, labeled `income` (money in, as a model might read it), and "Interest charged" 3,500 (fees). Brokerage (`investment`): a dividend -1,500 (income).

- Rows read: the six on checking and the credit card. `income_cents = 250,000`; `essentials_cents = 120,000 + 20,000 = 140,000`; `flexible_cents = 0`; `savings_cents = 0`; `other_cents = 40,000`; `transfers_ignored_cents = 20,000 + 20,000 = 40,000`; `uncategorized_cents = 0`.
- `left_over_cents = 250,000 - 140,000 - 40,000 = 70,000`.
- `essentials_pct = 140,000 / 250,000 * 100 = 56.0`, "56.0"; `flexible_pct` "0.0"; `savings_rate_pct` "0.0".
- `transaction_count = 6`; `ledger_rows_skipped`: `count = 3`, `net_cents = -40,000 + 3,500 - 1,500 = -38,000`.
- Counting the ledgers, as before rule 21a, gave `income_cents = 250,000 + 40,000 + 1,500 = 291,500` (the loan payment counted once as money out of checking and again as income), `other_cents = 43,500` and `left_over_cents = 108,000`.
- `GET /transactions` for the month lists all nine rows; with `cash_accounts_only=true` (the Spending screen's list) it lists the six on checking and the credit card (`test_loan_and_investment_ledgers_are_skipped`). Hiding the credit card (`is_active` false) leaves the four on checking.

### Shares of income (rule 25; `api/tests/unit/calc/test_spending.py`)

| # | Month | Shares |
|---|---|---|
| 1 | No income: essentials 50,000, flexible 1,000 | all null (`income_cents = 0`) |
| 2 | Tiny income (the `user_transactions_dynamic` October as it read before spec 003 rule 4 let the payroll's pay words win): income 12, essentials 36,480, flexible -101,979 (three payroll deposits filed under dining), savings 0 | `essentials_pct` null (36,480 > 120; 304,000.0 before rule 25); `flexible_pct` null (101,979 > 120; -849,825.0); `savings_rate_pct` "0.0" |
| 3 | At the limit: income 1,000, essentials 10,000, flexible 10,001, savings -10,000 | `essentials_pct` "1000.0" (10,000 = 10 * 1,000); `flexible_pct` null (10,001 > 10,000); `savings_rate_pct` "-1000.0" |
| 4 | A normal month: the spec month above, plus a refund-heavy case: income 200,000, essentials -30,000 (refunds beat spending), flexible 2,500 | spec month "45.1", "2.1", "10.0"; refund case `essentials_pct` "-15.0" (shown: a negative share within the limit), `flexible_pct` "1.3" |

### Plaid's `user_transactions_dynamic` October (rules 21a and 25; `api/tests/integration/test_spending_summary.py`)

The recorded sandbox user (`api/tests/fixtures/plaid/recorded/dynamic`, recorded 2026-10-22, so October runs to the 22nd) synced through `run_sync` and labeled by the seed rules alone: a checking account (weekly "Sweetgreen inc payroll ppd id" deposits of -81,000, `income` by spec 003's `contains` rule for money in, and "Interest payment" -12), a credit card, and five loans (mortgage, student, auto, consumer, line of credit) whose ledgers book "Monthly payment" as money in and "Interest charged" as money out.

- Before rule 21a: `uncategorized_cents = -5,498,010` and `uncategorized_count = 200`, of which the loans' 165 posted rows were -5,619,612; `transaction_count = 245`. With the paychecks still filed under dining, `essentials_pct` read "304000.0" and `flexible_pct` "-849825.0" (shares example 2).
- After: `income_cents = 243,012` (three paychecks and the interest); `essentials_cents = 36,480`; `flexible_cents = 141,021`; `savings_cents = 0`; `other_cents = 0`; `transfers_ignored_cents = 351,589` (the card payments and a cash deposit); `uncategorized_cents = 171,202`, `uncategorized_count = 34`; `left_over_cents = 243,012 - 36,480 - 141,021 = 65,511`; `transaction_count = 80`; `ledger_rows_skipped`: `count = 165`, `net_cents = -5,619,612`; `essentials_pct` "15.0", `flexible_pct` "58.0", `savings_rate_pct` "0.0".

## Edge cases

- A `supersedes_id` for a decision of a different calculator is 422 `supersedes_mismatch`; for a superseded (not current) row it is 409.
- A tax year without constants is 422 from input validation, before anything is saved.
- A user with no profile and no pay stub still gets an event, dated from `pay_periods_per_year` with no anchor.
- A month with no income gives null percentages and a negative or zero `left_over_cents`.
- A month whose only `income` rows are money out has `income_cents = 0` (never negative), the rows in `income_outflows_ignored_cents`, and null percentages.
- A month whose rows are all on loan, investment or retirement accounts reads as an empty period (zeros, `transaction_count = 0`) with those rows in `ledger_rows_skipped`.
- A month with a few cents of income shows the shares within the limit and nulls the rest (rule 25); the amounts themselves are always shown.
- An inactive ledger account's rows are in neither the totals nor `ledger_rows_skipped`, like an inactive cash account's.
- A summary period with no transactions returns zeros, empty `categories`, and the full `category_buckets`.

## Out of scope

- Decisions for the other three calculators (M6, M7), goals created by decisions (M6), and `check_in_id` links (M8).
- Editing or deleting a decision. A new version is the only change; account deletion is the only removal.
- Calendar events for enrollment deadlines and tax season (M8, M9).
- Recurring charges and cash flow in the spending summary (M5).
