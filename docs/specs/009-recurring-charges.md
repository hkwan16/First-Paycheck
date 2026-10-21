# 009: Recurring charges

Status: Implemented, M5. Settles spec 001 open question 3 (recurring charges after unlink).

## Goal

Find the subscriptions and bills in a user's synced transactions, so the Spending screen can list them and the monthly check-in (M8) can say "a new charge appeared", "this one changed price" or "this one stopped". Detection is plain code over the user's own transactions: a merchant whose charges repeat on a weekly, monthly or yearly rhythm at a stable amount is a recurring charge. No LLM is involved. The user can rename a charge or mark it as not recurring.

Code: the pure detector and status rules in `api/sync/recurring.py`, the amount arithmetic in `api/calc/recurring.py`, the `recurring.detect` job in `api/jobs/handlers/recurring.py`, routes in `api/app/routers/recurring.py`, the table in migration `0005_checkins` (spec 001), eval suite `evals/suites/recurring.py`.

## Inputs

| Input | Type | Valid range |
|---|---|---|
| Transactions | rows of `transactions` (spec 001) read under RLS: `merchant_norm`, `merchant_clean`, `merchant_raw`, `posted_at`, `amount_cents` | Posted (`pending = false`) rows of active accounts (`accounts.is_active`) |
| Stored charges | rows of `recurring_charges` | The user's own |
| `today` | ISO date | The job's UTC date |
| `PATCH /recurring/{id}` body | `{user_status?, merchant_clean?}` | `user_status` one of `confirmed`, `ignored`, `cancelled` or null; `merchant_clean` 1-100 characters after trimming |

## Outputs

- `detect(transactions, today) -> list[DetectedCharge]` (pure): one per recurring series, with `merchant_norm`, `merchant_clean` (display name), `cadence`, `typical_amount_cents`, `first_seen`, `last_seen`, `occurrences` and `overdue`.
- `next_status(stored, detected) -> RecurringStatus` and `undetected_status(stored, today) -> RecurringStatus` (pure): the status rules below (12 and 14).
- `recurring_charges` rows (spec 001): `merchant_norm`, `merchant_clean`, `cadence` (`weekly`, `monthly`, `yearly`), `typical_amount_cents` (> 0, money out), `first_seen`, `last_seen`, `status` (`active`, `new`, `changed`, `stopped`), `user_status` (`confirmed`, `ignored`, `cancelled`, or null).
- `recurring.detect` job result: `{"detected": n, "new": n, "changed": n, "stopped": n, "deleted": n}`, where `new`, `changed` and `stopped` count the rows that entered that status in this run.
- `GET /recurring` returns `RecurringChargeOut` items: `id`, `merchant_norm`, `merchant_clean`, `cadence`, `typical_amount_cents`, `first_seen`, `last_seen`, `status`, `user_status`, `updated_at`.
- `PATCH /recurring/{id}` returns the updated `RecurringChargeOut`; another user's id is 404.

## Rules

### Which transactions

1. Detection reads the user's posted transactions of active accounts, under RLS, and keeps those with `amount_cents > 0` (money out, spec 001 rule 21) and a non-empty `merchant_norm`. Refunds, deposits and income never form a recurring charge.
2. Transactions are grouped by `merchant_norm` (spec 003 rule 1), across all of the user's accounts. Within a group they are ordered by `posted_at`, then `amount_cents`.
3. Categories play no part: a monthly transfer to savings at a fixed amount is detected like any bill, and the user can mark it `ignored` (rule 17).

### One merchant's series

4. **Reference amount.** `m` is the median of every amount in the group (rule 7 defines the median).
5. **Series.** The series is the group's transactions whose amount is within 15% of `m`: `100 * |amount - m| <= 15 * m`, in integer cents. The rest (a one-off purchase at the same merchant) are left out.
6. **Cadence bands.** Each gap between consecutive series dates is a whole number of days. A band is weekly 6-8 days, monthly 27-33 days, yearly 350-380 days (inclusive). The series has a cadence when at least three quarters of its gaps fall in one band: `4 * in_band >= 3 * gaps`. The bands do not overlap, so at most one band qualifies. A skipped month or an extra charge leaves the series recurring as long as three quarters of the gaps still fit.
7. **Median.** The middle value of the sorted amounts; for an even count, the mean of the two middle values rounded half up to a whole cent. All amount arithmetic is `calc/recurring.py` (integer cents, no floats).
8. **Minimum length.** A weekly series needs at least 4 charges, a monthly series 3, a yearly series 2. A shorter series is not recurring yet.
9. **Detected values.** `typical_amount_cents` is the median of the newest three charges of the series (all of them when there are fewer), so it follows a price change within two charges while ignoring one odd amount. `first_seen` and `last_seen` are the series' earliest and latest `posted_at`. The display name is the `merchant_clean` of the newest series charge that has one, otherwise that charge's `merchant_raw` with runs of whitespace collapsed.
10. **Overdue.** A series is overdue when `today - last_seen` is more than its band's maximum gap plus the band's width: weekly more than 10 days, monthly more than 39 days, yearly more than 410 days. The extra band width absorbs posting delays.

### Status

11. Status belongs to the detector; `user_status` belongs to the user. Detection never changes `user_status`, and the user never sets `status`.
12. For a detected series, `next_status` returns the first that applies:
    1. overdue: `stopped`;
    2. no stored row, or the stored row is `stopped` (the charge resumed): `new`;
    3. the stored row is `active` and `100 * |typical - stored typical| > 5 * stored typical`: `changed`;
    4. otherwise the stored status, unchanged.
13. Flags are sticky. A `new` or `changed` row stays flagged across runs until the check-in (M8) reports it and sets it `active`; a price change on a `new` row keeps it `new`, with the new typical amount.
14. **Not detected this run.** A stored row whose merchant still has qualifying transactions (rule 1) but no longer forms a series keeps its values; it becomes `stopped` once overdue by its stored `last_seen` and cadence (rule 10), otherwise its status is unchanged. A stored row whose merchant has no qualifying transactions left (its account was unlinked or hidden, or the provider removed them) is deleted.
15. **Writes.** A detected series upserts on `(user_id, merchant_norm, cadence)`: `typical_amount_cents`, `first_seen`, `last_seen` and `status` are refreshed. `merchant_clean` is written only when the row is created, so the user's rename survives every later run. The job reads, decides and writes in one user session, under a per-user transaction advisory lock, so two runs for one user never interleave.

### Job and triggers

16. `recurring.detect` runs as the job's user under RLS (`user_session_for`). It is queued after every sync (spec 002 rule 16) and every CSV import (spec 010), and after `DELETE /sync/items/{id}`, so charges detected only from an unlinked account's transactions are deleted on the next run (rule 14). This settles spec 001 open question 3 without an `account_id` column. Hiding an account (`PATCH /accounts/{id}` with `is_active: false`) takes effect at the next run.

### Routes

17. `PATCH /recurring/{id}` accepts `user_status` (`confirmed`: yes, this recurs; `ignored`: not a recurring charge, kept out of check-ins; `cancelled`: the user cancelled it, so the check-in can confirm it stopped; `null` clears it) and `merchant_clean` (a rename, trimmed, 1-100 characters). Omitted fields are unchanged; an unknown field is 422; an empty body returns the charge unchanged.
18. `GET /recurring` lists every charge of the user (ignored ones included, so they can be restored), ordered by `merchant_clean`, then `cadence`, then `id`.

## Hand-worked examples

### Detection (`api/tests/unit/sync/test_recurring.py`)

`today` is 2026-10-21 unless a row says otherwise. Amounts are cents, all money out.

| # | Test | Charges (date: cents) | Expected |
|---|---|---|---|
| 1 | `test_monthly_subscription_detected` | `NETFLIX.COM`: 07-03: 1549, 08-03: 1549, 09-03: 1549, 10-03: 1549 | monthly, typical 1549, first 07-03, last 10-03, not overdue |
| 2 | `test_weekly_class_detected` | `CORE POWER YOGA`: 09-01, 09-08, 09-15, 09-22: 2000 each; today 2026-09-25 | weekly, typical 2000, 4 charges |
| 3 | `test_three_weekly_charges_are_not_enough` | Example 2 without 09-22 | none |
| 4 | `test_yearly_membership_detected` | `AMAZON PRIME`: 2025-02-14: 13900, 2026-02-14: 13900 | yearly, typical 13900, not overdue |
| 5 | `test_two_monthly_charges_are_not_enough` | `SPOTIFY`: 09-05, 10-05: 1199 | none |
| 6 | `test_one_off_amount_left_out` | `PG&E`: 07-12: 8200, 08-12: 9100, 09-11: 8700, 09-20: 25000, 10-12: 8900 | monthly, typical 8900, first 07-12, last 10-12, 4 charges |
| 7 | `test_skipped_month_still_recurring` | `GYM`: 4999 on 03-01, 04-01, 05-01, 06-01, 08-01, 09-01, 10-01 | monthly, 7 charges |
| 8 | `test_ride_share_is_not_recurring` | `Uber 063015 SF**POOL**` 540 on 08-12, 09-11, 10-11 and `Uber 072515 SF**POOL**` 633 on 07-26, 08-25, 09-24 | none (one group `uber sf pool`) |
| 9 | `test_refunds_and_income_ignored` | Example 1 plus -1549 on 10-05 and a paycheck -199604 on 10-15 | as example 1 |
| 10 | `test_overdue_boundary` | Example 1 with today 2026-11-11, then 2026-11-12 | not overdue (39 days), then overdue (40 days) |
| 11 | `test_price_change_followed` | `NETFLIX.COM` 1549 on 05-03 to 08-03 (4 charges), then 1699 on 09-03 and 10-03 | monthly, typical 1699, first 05-03, 6 charges |

Working:

- Row 1: gaps 31, 31, 30 days, all in the monthly band; 4 charges >= 3. The newest three are 1549, so typical 1549. `today - last_seen` = 18 days <= 39.
- Row 2: gaps 7, 7, 7; 4 >= 4 weekly charges. Today minus 09-22 is 3 days. Row 3 has 3 weekly charges, under the minimum of 4.
- Row 4: one gap, 2026-02-14 minus 2025-02-14 = 365 days, in 350-380; 2 >= 2. Today minus 2026-02-14 = 249 days <= 410. The median of two equal amounts is 13900.
- Row 6: sorted amounts 8200, 8700, 8900, 9100, 25000, so `m = 8900`; `15 * 8900 = 133500`; `100 * |25000 - 8900| = 1610000 > 133500`, so 25000 is left out; `100 * |8200 - 8900| = 70000 <= 133500` stays. Series dates 07-12, 08-12, 09-11, 10-12: gaps 31, 30, 31. Newest three 9100, 8700, 8900 sort to 8700, 8900, 9100: typical 8900.
- Row 7: gaps 31, 30, 31, 61, 31, 30. Five of six fall in 27-33: `4 * 5 = 20 >= 3 * 6 = 18`.
- Row 8: both descriptions normalize to `uber sf pool` (spec 003 rule 1). Sorted amounts 540, 540, 540, 633, 633, 633: `m = (540 + 633) / 2 = 586.5`, rounded half up to 587. `100 * 47 = 4700 <= 15 * 587 = 8805` and `100 * 46 = 4600 <= 8805`, so all six are in the series. Dates 07-26, 08-12, 08-25, 09-11, 09-24, 10-11: gaps 17, 13, 17, 13, 17, none in any band.
- Row 10: 2026-11-11 minus 2026-10-03 = 39 days, not more than 39; 2026-11-12 is 40.
- Row 11: amounts 1549 x4, 1699 x2; sorted, the middle two are 1549 and 1549, so `m = 1549`; `100 * |1699 - 1549| = 15000 <= 15 * 1549 = 23235`, so all six are in. Gaps 31, 30, 31, 31, 30. The newest three are 1549, 1699, 1699: typical 1699.

### Status (`api/tests/unit/sync/test_recurring.py::test_next_status`)

| Stored | Detected | `today` | Status |
|---|---|---|---|
| none | example 1 | 2026-10-21 | `new` |
| none | example 1 | 2026-11-12 | `stopped` |
| `active`, typical 1549 | typical 1699 | 2026-10-21 | `changed` (`100 * 150 = 15000 > 5 * 1549 = 7745`) |
| `active`, typical 1549 | typical 1599 | 2026-10-21 | `active` (`100 * 50 = 5000 <= 7745`) |
| `new`, typical 1549 | typical 1699 | 2026-10-21 | `new` (rule 13) |
| `changed`, typical 1699 | typical 1699 | 2026-10-21 | `changed` |
| `stopped`, typical 1549 | example 1 | 2026-10-21 | `new` (resumed) |
| `active`, monthly, last 2026-09-03 | not detected, merchant still has charges | 2026-10-21 | `stopped` (48 days > 39) |
| `active`, monthly, last 2026-10-03 | not detected, merchant still has charges | 2026-10-21 | `active` |
| any | not detected, no charges left | any | deleted |

### Job and routes (`api/tests/integration/sync/test_recurring_job.py`, `api/tests/integration/test_recurring_routes.py`)

| # | Test | Setup | Expected |
|---|---|---|---|
| 1 | `test_detect_job_writes_new_charges` | A has example 1 and example 8's Uber charges | One row `netflix.com`, monthly, 1549, `new`; result `detected = 1, new = 1` |
| 2 | `test_rerun_keeps_the_flag_and_the_rename` | Run, rename to "Netflix", run again | Still one row, `new`, named "Netflix" |
| 3 | `test_charge_stops_and_resumes` | Run on 2026-10-21; run on 2026-11-12; add a 2026-11-13 charge and run on 2026-11-14 | `new`, then `stopped`, then `new` |
| 4 | `test_unlinking_deletes_its_charges` | Run, `DELETE /sync/items/{id}`, run the queued job | Row deleted; result `deleted = 1` |
| 5 | `test_only_the_users_transactions_count` | B has the same Netflix charges; run A's job | A's rows only; B has none |
| 6 | `test_patch_marks_ignored_and_renames` | `PATCH {"user_status": "ignored", "merchant_clean": " Netflix "}` | 200; `user_status = ignored`, name "Netflix", status unchanged |
| 7 | `test_patch_validation` | Empty name; a `status` field; `user_status: "paused"` | 422 each |

## Edge cases

- A user with no transactions, or only income, gets no rows and the job succeeds with zeros.
- Two charges on the same day give a gap of 0, which fits no band; it counts against the three-quarters rule like any other off-band gap.
- A price change above 15% splits the series: the new amounts fall outside the series until they reach half of the merchant's history (rule 4), so the charge reads as `stopped` and later `new`. Rule 13's sticky flags make both visible to the check-in.
- A merchant whose charges come from two accounts is one series (rule 2).
- A bill that swings more than 15% around its median (a utility bill between $62 and $98) loses the far months from its series, and the gaps they leave can push it under the three-quarters rule. The recurring eval's custom user has such a bill, and its baseline recall records the miss.
- A charge in `stopped` with `user_status = cancelled` is the expected outcome of a cancellation; the check-in (M8) decides how to word it.
- `merchant_clean` set to whitespace only is 422, not an empty name.

## Out of scope

- Recurring income (paychecks are pay stubs, spec 005) and transfers recognized by category.
- A monthly-equivalent total of recurring charges, next expected dates, and splitting one merchant into several series by amount.
- Acknowledging flags (`new`/`changed` back to `active`): the check-in engine does that in M8.
- Re-running detection when `PATCH /accounts/{id}` hides an account (it waits for the next sync).
