# 019: The person's day

Status: Implemented, Hardening (issue 232). Migration `0026_the_persons_day`.

## Goal

"Today" is the person's calendar day, never the server's UTC day. At 22:27 Pacific on November 9 the app counted November 10 (issue 232): Spending said "November 1 to 10", the plan said "As of Nov 10, 2026" and "Through Feb 8, 2027", the PDF was named and dated November 10, and a check-in run that evening counted "in 5 days" to a date it had called "in 6 days" that afternoon, while the same screens showed "Saved Nov 9" from the browser's clock. After this spec every date the app derives from the clock (today, the current month, day counts, overdue marks, the plan's `as_of`, the PDF's date, the month a check-in is for) comes from one server-side function over the request or job clock and the person's IANA time zone, which the browser reports and the profile stores. Stored timestamps stay UTC and due dates stay plain dates; only the step from an instant to a date changes. Code: `api/db/person_day.py` (the function), `app/deps.py` (`Day`), `app/routers/profile.py` (`PUT /profile/time-zone`), every caller listed in rule 9, `web/src/components/chrome/TimeZoneSync.tsx` and `web/src/lib/api/hooks/profile.ts` (`useToday`, `useSaveTimeZone`).

## Inputs

| Input | Type | Valid range |
|---|---|---|
| `profiles.time_zone` | text or null | An IANA zone name Python's `zoneinfo` knows (`zoneinfo.available_timezones()`, from the `tzdata` package the API depends on), 1 to 64 characters. Null until the browser first reports one |
| The clock | UTC instant | The request clock (`Now`, `app/deps.py:get_now`) or the job clock (`Services.clock`) |
| `PUT /profile/time-zone` body | `{"time_zone": str}` | `extra="forbid"`; the name as above |

The browser's zone is `Intl.DateTimeFormat().resolvedOptions().timeZone`. Nothing else is an input: no route takes a client's "today" (rule 6).

## Outputs

| Output | Type | Meaning |
|---|---|---|
| `db/person_day.py:PersonDay` | `zone` (`ZoneInfo`), `today` (date) | The person's zone in effect and their date at the clock's instant; `month` is the first day of `today`'s month, `day_of(moment)` the date of a stored instant in that zone, `start_of(day)` the instant that day begins there |
| `ProfileOut.time_zone` | string or null | The saved zone (null before the first report) |
| `ProfileOut.today` | date | The person's today, from rule 2. Computed on read |
| `PUT /profile/time-zone` | `ProfileOut` (200) | Saves the zone, creating the profile row with its defaults when there is none; 422 `validation_error` for a name rule 4 refuses |
| `check_ins.as_of` | date, `NOT NULL` | The date the check-in's last run judged it as of (rule 11), stored by that run; `CheckInSummary.as_of` reads it |
| A `plan.export` job's result | `{"size_bytes": n, "prepared_on": "YYYY-MM-DD"}` | `prepared_on` is the plan's `as_of`, the date the PDF prints and its file name carries (rule 12) |

## Rules

### The zone and today

1. **The zone in effect** (`db/person_day.py:zone_for`). The saved `profiles.time_zone` when there is one; otherwise `DEFAULT_TIME_ZONE`, `America/New_York`. First Paycheck serves US employees (spec 014 is federal withholding), so a US zone is closer than UTC for anyone not yet reported: from New York the error is at most the three evening hours a Pacific person spends in the next Eastern day, where UTC put every US person in tomorrow from the afternoon on. A saved name `zoneinfo` no longer knows (a zone the tz database retired) reads as the default and logs a warning with the user id and no name; it is never an error.
2. **Today** (`db/person_day.py:person_day_at(now, zone)`): `now` converted to `zone`, its date. It is the one place an instant becomes the person's date. `person_day(session, user_id, now)` reads `profiles.time_zone` in the caller's RLS session and returns `person_day_at(now, zone_for(name))`; it is how every route and job handler learns today. Routes take the `Day` dependency (`app/deps.py:get_day`: `UserSession`, `CurrentUser` and `Now`, so a test that freezes `Now` freezes the person's day too). Job handlers call `person_day` in their user session with `ctx.services.clock()`. The scheduler, which reads every user on its privileged connection (spec 015 rule 14), reads each user's `time_zone` there and calls `person_day_at` itself.
3. **The date of a stored instant** (`PersonDay.day_of`). Where a stored timestamp is compared with dates (when a decision was saved, when a goal started, the day of a balance snapshot), it is dated in the zone in effect at the time of the read. A window that starts on a date starts at `start_of(day)`, that day's first instant in the zone (on a day that begins in a DST gap, the first instant that exists).
4. **Validation** (`db/person_day.py:is_time_zone`). A name is accepted when it is at most 64 characters and in `zoneinfo.available_timezones()`, which includes the backward-compatible links browsers still report (`Asia/Calcutta`, `US/Pacific`). Anything else (`Mars/Olympus`, an empty string, `America/New_York ` with a space, a POSIX string such as `EST5EDT,M3.2.0,M11.1.0`, a path) is 422 `validation_error`: "Choose a time zone from the IANA list, such as America/Los_Angeles." The database checks `char_length(time_zone) BETWEEN 1 AND 64` (`ck_profiles_time_zone_length`); a CHECK cannot read the zone list.

### The web reports the zone, and asks for today

5. **Reporting.** `TimeZoneSync` (`web/src/components/chrome/TimeZoneSync.tsx`, in the `(app)` layout) waits for the page to hydrate (`usePageHydrated`, as `AppSideNav` does), reads `GET /profile`, and when its `time_zone` differs from the browser's zone sends `PUT /profile/time-zone` with the browser's (`useSaveTimeZone`). So the first page a person opens saves it (creating the profile row when there is none), and opening the app in another zone saves the new one: the browser's zone wins, there is no manual setting. It sends at most once per browser zone per page load; a refusal (an unknown name, an error) is logged and not retried until the next load. On success the saved profile replaces the cached one and every cached read is read again, since the person's today, and with it every date the API answers, may have moved. `PUT /profile` neither takes nor changes `time_zone`: it replaces the whole profile (spec 005), so a form save racing the report could otherwise put back the old zone, and an API client that leaves the field out would erase it.
6. **The web never derives a date from its clock.** `useToday()` (`web/src/lib/api/hooks/profile.ts`) is `GET /profile`'s `today`, null until it arrives (and on the server), so the Spending period picker's "this month so far" (its end date) and whether a check-in offers Check in now (`offersCheckInNow`: the check-in's period is `today`'s month) follow the API's day. No route takes a client-supplied today: the client's clock and zone can be wrong or another device's, and dates the API computes (overdue marks, the default period, the plan's window) must match the dates it shows next to them. Formatting a stored timestamp ("Saved Nov 9", "4 minutes ago") stays in the browser's zone (`lib/dates.ts`), which rule 5 makes the person's on the device in use. Calendar dates are still formatted in UTC, so they never shift.

### What follows the person's day

7. **Due dates stay plain dates** (`calendar_events.due_at`, pay dates, enrollment deadlines, goal target dates). A count of days and an overdue mark compare a due date with the person's today through `db/calendar.py:days_until` and `is_overdue`, unchanged.
8. **Stored timestamps stay UTC** (spec 001 rule 2): `created_at`, `last_run_at`, `completed_at`, `user_action_at`, snapshots' `as_of`, job times. Only the step from an instant to a date uses the zone.
9. **Every date derived from the clock**, and where it now comes from:

| Where | Date | From |
|---|---|---|
| `GET /plan` (`app/plan.py:build_plan`) | `as_of`, `calendar_through` (`as_of` + 90 days), each event's `overdue`, each decision's `saved_on` (the Plan page's "Saved" date, spec 016 rule 11a) | `Day`; `saved_on` is `day_of(created_at)` |
| `plan.export` job | the plan's `as_of`; the PDF's "Prepared" date and `prepared_on`; each decision's "Saved" date | `person_day` at the job clock; the printed dates are the plan's `as_of` (rule 12) and each decision's `saved_on`, as the Plan page prints them |
| `GET /plan/export/{job_id}` | the file name's date | the job result's `prepared_on` (rule 12) |
| `GET /calendar` | `overdue` | `Day` |
| `POST /decisions` side effects (spec 007 rule 16, spec 011, spec 012 rule 15, spec 014) | the next pay date after today; an enrollment deadline "not before today" | `Day` |
| `PATCH /goals/{id}` (spec 011 rule 17a) | the first contribution date of a re-projection | `Day` |
| `GET /spending/summary`, `GET /cashflow` (spec 007 part B, spec 010) | the default period, the last complete month before today's | `Day` |
| `GET /net-worth` (spec 015 rule 20) | the months of the series, the current month's cutoff, each snapshot's date | `Day` and `day_of`; the window starts at `start_of` the first month's first day |
| `GET /check-ins`, `GET /check-ins/{id}` | `past` (today is after the month), the month-to-date cash flow's end | `Day` |
| `POST /check-ins` (spec 015 rule 23) | the month checked in | `Day.month` |
| `checkin.monthly` job (spec 015 rule 16) | the run's `today` | rule 11 |
| `checkin/facts.py` | `decided_on`, `started_on`, each balance's `as_of` | `day_of` in the run's zone |
| `schedule.tick` (spec 015 rule 14) | which month to queue for each user | rule 10 |
| `recurring.detect` job (spec 009) | `today` (a charge's `overdue`), the month whose open check-in it refreshes (spec 015 rule 15) | `person_day` at the job clock |
| `sync` jobs and `POST /accounts/import` (spec 002) | a holding's `as_of` when the provider sends none | `person_day` at the sync's clock |
| `PUT /profile` (spec 005, spec 006 open question 2) | the birth year's upper bound: the person's year less 14 (`latest_birth_year`, a `field_error` on `birth_year`) | `Day` |
| The web | today, this month (rule 6), and the plan details' latest birth year (`PlanDetailsForm`, `latestBirthYear`) | `GET /profile`'s `today` |

10. **What stays UTC, and why.** The LLM budget's day (spec 003 rule 21) and the rate limits' clock hours (spec 004 rule 5, `app/ratelimit.py`) are cost guards, not dates anyone reads: a day per zone would let a person who changes zone start a spent budget again, and an hour is the same span in every whole-hour zone. `DTSTAMP` in the `.ics` is UTC by RFC 5545. Retention ages (7 days for uploads and PDFs) are durations. Rate-limit and budget windows therefore keep their UTC wording in specs 003, 004 and 008. The entry limits (spec 007 rules 2a and 2b) and the `cash` category (spec 003 rule 9d) read no clock; a stored decision's inputs are read with `context=STORED` whatever the day.

### The month a check-in is for

11. **The run's today.** A `checkin.monthly` job for `period` judges `max(period, min(T, last day of period))`, where `T` is the person's today at the job clock: a job that runs after its month judges the month's last day (spec 015 rule 16, unchanged), and one that runs before its month began for the person (the month's job was queued in another zone, and the zone then moved west) judges the month's first day rather than a day outside it. The run stores that date as `check_ins.as_of` beside `last_run_at`.
12. **Records keep their dates.** A check-in's `as_of` is stored by the run (rule 11), not recomputed from `last_run_at` on read, so a later change of zone never moves the date a past record says its findings were judged on. Migration `0026` fills `as_of` for every existing check-in with what `GET /check-ins` showed for it: `min(UTC date of last_run_at, last day of period)`. Stored findings are not rewritten; an open check-in's next run judges it in the person's day. A PDF's preparation date is the plan's `as_of`, printed in it and stored in its job's result as `prepared_on`; the download's file name is `first-paycheck-plan-<prepared_on>.pdf`. An export made before this spec has no `prepared_on` and keeps the name it had, the UTC date of its `created_at`, which is also the date it prints.
13. **The scheduler queues each person's month** (`jobs/scheduler.py:_queue_check_ins`). Each tick reads, on its privileged connection, every `auth.users` row with its profile's `time_zone`, takes each user's month from `person_day_at(tick clock, zone_for(time_zone))`, and queues the `checkin.monthly` job with key `checkin.monthly:{YYYY-MM}` and payload `{"period": "YYYY-MM-01", "trigger": "schedule"}` of that month for each user without one (one `INSERT ... SELECT` per distinct month, `ON CONFLICT DO NOTHING`, as before). So a person's November job waits until November has begun where they are: a Pacific person's November starts at 07:00 UTC on November 1 (00:00 PDT), three hours after an Eastern person's (04:00 UTC, 00:00 EDT). A person whose zone moves after the month's job was queued keeps that job (its key is the month); the next month is queued by the new zone.
14. **Check in now** (`POST /check-ins`) checks in `Day.month`, the person's month, with the same key and payload as rule 13, so a press at 21:00 Pacific on November 30 refreshes November's check-in, not December's.

## Hand-worked examples

The Pacific person has `time_zone` `America/Los_Angeles` (PDT, UTC-7, until 2026-11-01 09:00 UTC; PST, UTC-8, after); the Eastern person `America/New_York` (EDT, UTC-4, until 2026-11-01 06:00 UTC; EST, UTC-5, after). A person with no zone reads as Eastern (rule 1).

| # | Test | Setup | Expected |
|---|---|---|---|
| 1 | `test_today_is_the_persons_date` (`tests/unit/test_person_day.py`) | `person_day_at(2026-11-10 06:27 UTC, ...)` | Pacific 2026-11-09 (22:27 PST); Eastern 2026-11-10 (01:27 EST); `UTC` 2026-11-10 |
| 2 | `test_today_across_the_dst_change` | 2026-11-01 05:30 UTC | Eastern 2026-11-01 (01:30 EDT); Pacific 2026-10-31 (22:30 PDT); at 07:30 UTC Pacific is 2026-11-01 (00:30 PDT) |
| 3 | `test_zone_for_unset_or_unknown_is_the_default` | `zone_for(None)`, `zone_for("Mars/Olympus")` | `America/New_York` both; the second logs a warning |
| 4 | `test_is_time_zone` | `America/Los_Angeles`, `Asia/Calcutta`, `UTC`; `""`, `Mars/Olympus`, `America/New_York `, `EST5EDT,M3.2.0,M11.1.0`, `../etc/passwd`, 65 characters | true for the first three, false for the rest |
| 5 | `test_start_of_day` | `start_of(2026-11-01)` in Pacific | 2026-11-01 07:00 UTC |
| 6 | `test_put_time_zone_saves_the_browsers_zone` (`tests/integration/test_person_day_routes.py`) | No profile; `PUT /profile/time-zone {"time_zone": "America/Los_Angeles"}` at 2026-11-10 06:27 UTC | 200, `time_zone` `America/Los_Angeles`, `today` 2026-11-09, every other field at its default; `GET /profile` the same; a `PUT /profile` with a salary afterwards keeps the zone |
| 7 | `test_put_time_zone_refuses_an_unknown_name` | `Mars/Olympus`, `""`, a 65-character name, an extra field | 422 `validation_error`, nothing saved |
| 8 | `test_profile_today_defaults_to_eastern` | No profile, 2026-11-10 03:27 UTC | `GET /profile`: `time_zone` null, `today` 2026-11-09 (22:27 EST) |
| 9 | `test_plan_is_as_of_the_persons_day` | Pacific person, an `enrollment_deadline` event due 2026-11-09, `GET /plan` at 2026-11-10 06:27 UTC | `as_of` 2026-11-09, `calendar_through` 2027-02-07, the event listed with `overdue` false. The Eastern person at the same instant: `as_of` 2026-11-10, `calendar_through` 2027-02-08, `overdue` true |
| 10 | `test_calendar_overdue_on_the_persons_day` | The event of row 9, `GET /calendar` | Pacific `overdue` false; Eastern true |
| 11 | `test_deadline_on_the_persons_today_makes_its_event` | Pacific person saves a health plan decision with `enrollment_deadline` 2026-11-09 at 2026-11-10 06:27 UTC | `calendar_event_id` set; the event is due 2026-11-09 |
| 12 | `test_next_pay_date_after_the_persons_today` | Pacific person, semimonthly, newest stub paid 2026-10-31; saves the 401(k) at 2026-11-15 07:00 UTC (23:00 PST on the 14th) | The election check is due 2026-11-15 (the first pay date after November 14), not 2026-11-30 |
| 13 | `test_spending_default_is_the_persons_last_month` | Pacific person, `GET /spending/summary` and `GET /cashflow` with no dates at 2026-12-01 05:00 UTC (21:00 PST on November 30) | `start` 2026-10-01, `end` 2026-10-31 (November is not over for them) |
| 14 | `test_check_in_now_checks_in_the_persons_month` | Pacific person, `POST /check-ins` at 2026-12-01 05:00 UTC | The job's key is `checkin.monthly:2026-11`, payload period 2026-11-01 |
| 15 | `test_past_is_the_persons_day` | Pacific person's November check-in read at 2026-12-01 05:00 UTC | `past` false; at 2026-12-01 08:00 UTC (00:00 PST) `past` true |
| 16 | `test_check_in_run_counts_from_the_persons_day` | Pacific person, an open `w4_submit` event due 2026-11-15; the November job runs at 2026-11-09 20:00 UTC, then again at 2026-11-10 06:27 UTC | Both runs: one `upcoming_deadline` with `days_until` 6, `as_of` 2026-11-09 (stored). Before this spec the second run said 5 and `as_of` 2026-11-10 |
| 17 | `test_check_in_run_before_its_month_judges_its_first_day` | Pacific person, the November job (queued under Eastern) runs at 2026-11-01 05:00 UTC (22:00 PDT on October 31) | `as_of` 2026-11-01 |
| 18 | `test_tick_queues_each_persons_month` (`tests/integration/checkin/test_tick.py`) | Pacific user A and Eastern user B, each with October's job; user C with no profile; ticks at 2026-11-01 04:30 UTC and 07:30 UTC | First tick: November jobs for B and C (00:30 EDT), none for A (21:30 PDT); second tick: November for A, nothing more for B or C |
| 19 | `test_export_is_prepared_on_the_persons_day` (`tests/integration/export/`) | Pacific plan user, export job at 2026-11-10 06:27 UTC | Result `prepared_on` 2026-11-09; the HTML says "Prepared Nov 9, 2026"; the download is named `first-paycheck-plan-2026-11-09.pdf` |
| 20 | `test_an_export_before_prepared_on_keeps_its_name` | A succeeded export whose result is `{"size_bytes": n}`, created 2026-11-10 06:27 UTC, Pacific person | `first-paycheck-plan-2026-11-10.pdf` |
| 21 | `test_net_worth_dates_snapshots_on_the_persons_day` | A checking account with snapshots of 100,000 at 2026-10-31 20:00 UTC and 120,000 at 2026-11-01 05:00 UTC; `GET /net-worth?months=2` at 2026-11-10 06:27 UTC | Pacific: October 120,000 (the second is 22:00 PDT on October 31), November 120,000. Eastern: October 100,000, November 120,000 (the second is 01:00 EDT on November 1) |
| 21a | `test_newest_snapshot_of_a_day_is_the_last_taken` (`tests/unit/calc/test_net_worth.py`) | Two snapshots dated the same day, 120,000 then 80,000, passed in the order taken | The day's balance is 80,000. Before this spec the larger balance won a tie (spec 015 rule 20 says the newest) |
| 22 | `test_decided_on_is_the_persons_day` (`tests/unit/checkin/` facts) | A 401(k) decision saved 2026-11-15 05:00 UTC; Pacific person | `decided_on` 2026-11-14 |
| 23 | `test_recurring_detect_uses_the_persons_day` | Pacific person, the job at 2026-12-01 05:00 UTC with November's check-in open | It queues November's `sync` refresh (December's check-in does not exist yet for them) |
| 24 | `test_birth_year_bound_is_the_persons_year` | Pacific person, `PUT /profile` with `birth_year` 2013 at 2027-01-01 05:00 UTC (21:00 PST on December 31, 2026); an Eastern person (already 2027) the same | Pacific: 422 `validation_error` "Enter a birth year from 1900 to 2012." with `details.errors` `[{path: ["birth_year"], ...}]`, and 2012 is saved; Eastern: 2013 is saved. The web's plan details form says "Enter a year from 1900 to 2012." for the Pacific person from `today` 2026-12-31, whatever the browser's clock |
| 24a | `test_a_refused_time_zone_names_its_field` | `PUT /profile/time-zone` with `Mars/Olympus` | 422 with `details.errors` `[{path: ["time_zone"], message: rule 4's sentence}]` |
| 24b | `test_a_decision_is_saved_on_the_persons_day` | A 401(k) decision saved 2026-10-22 05:30 UTC (22:30 PDT on October 21), for a Pacific and an Eastern person | `GET /plan`'s `saved_on` 2026-10-21 for the Pacific person, 2026-10-22 for the Eastern one; the PDF prints "Saved Oct 21, 2026" and "Saved Oct 22, 2026" (`test_the_pdf_names_calculators_as_the_plan_page_does`), and the Plan page prints the same `saved_on` |
| 25 | `test_0026_keeps_each_check_ins_date` (`tests/integration/test_migrations.py`) | At 0025: an October check-in last run 2026-10-28 12:00 UTC and a November one last run 2026-11-10 06:27 UTC; upgrade to 0026 | `as_of` 2026-10-28 and 2026-11-10 (what they showed); `profiles.time_zone` null; downgrade drops both columns |
| 26 | `persons-day.spec.ts` (web, project `persons-day`) | A new person (`E2E_DAY_USER_*`) signs in with the browser in a zone whose date differs from UTC's when the test runs ("The e2e test's zone", below); saves a health plan with the enrollment deadline on their today, imports a row dated today, checks in now, exports the PDF | `GET /profile` saves the browser's zone; the plan says "As of" their today and "Through" today + 90 days and lists the deadline without "Overdue"; Spending's "<Month> so far" ends on their today; the check-in list names their month; the PDF is `first-paycheck-plan-<their today>.pdf` |

Row 9's window: 2026-11-09 + 90 days: 21 more days to November 30, 31 in December (52), 31 in January (83), 7 in February (90), so 2027-02-07; from 2026-11-10 it is 2027-02-08, the issue's "Through Feb 8, 2027".

Row 12: semimonthly pay falls on the 15th and the last day of the month (spec 007 rule 16); the first such date strictly after 2026-11-14 is 2026-11-15, and after 2026-11-15 (the UTC date) it was 2026-11-30.

Row 16: 2026-11-15 minus 2026-11-09 is 6 days; at 2026-11-10 06:27 UTC the Pacific date is still 2026-11-09.

Row 21: 2026-10-31 20:00 UTC is 13:00 PDT and 16:00 EDT on October 31. 2026-11-01 05:00 UTC is 22:00 PDT on October 31 (PDT ends at 09:00 UTC) but 01:00 EDT on November 1 (EDT ends at 06:00 UTC). October's cutoff is October 31, so the Pacific person's October takes the later snapshot and the Eastern person's the earlier.

**The e2e test's zone.** The local stack's API, worker, Postgres and Auth stand-in share the real clock (the queue compares `run_after` with Postgres's `now()`, tokens carry real `iat` and `exp`, Plaid's sandbox dates its rows from the real today), so the test moves the person instead of the clock: it picks the browser's `timezoneId` from the real UTC hour so that the person's date differs from UTC's for at least the next hour: `America/Los_Angeles` before 06:00 UTC (evening the day before), `Pacific/Pago_Pago` (UTC-11) from 06:00 to 10:00 UTC (evening the day before), `Pacific/Kiritimati` (UTC+14) from 10:00 UTC (the next morning). It fails if the dates do not differ when it starts, so it always reproduces the bug before the fix; in the minutes before UTC midnight no zone can keep the difference past midnight, and the test still checks that every screen shows the browser's date.

## Edge cases

- A person with no profile row: `GET /profile` answers the defaults with `time_zone` null and `today` in the default zone; the first page they open creates the row through `PUT /profile/time-zone`.
- Two devices in different zones: the last one opened wins (rule 5); dates on the other follow it until it is opened again.
- Half-hour and 45-minute zones (`Asia/Kolkata`, `Asia/Kathmandu`) work like any other: only the date of an instant is taken.
- A date that begins in a DST gap or repeats an hour has one date per instant; `start_of` gives the first instant of the day that exists.
- A page left open across the person's midnight keeps the today it read until `GET /profile` is read again (a window focus or a new page); the API's own answers are already as of each request.
- `POST /check-ins` and a scheduled job near midnight: the month is the person's at the request or tick; the job then judges rule 11's date, so a job that runs after the month ended still judges the month.
- The browser reports a zone the API does not know (older `tzdata` than the browser's ICU): 422, logged; the profile keeps its zone or the default.

## Out of scope

- Choosing a zone by hand, or showing it. The browser's report is the setting.
- A client-supplied today on any request (rule 6).
- Moving stored timestamps, the LLM budget day or the rate-limit hours off UTC (rule 10).
- Rewriting stored findings, check-ins' `as_of` or exported PDFs when the zone changes (rule 12).
- Formatting stored timestamps in the saved zone rather than the browser's; rule 5 makes them the same on the device in use.
