# web/: First Paycheck frontend

Next.js 16 (App Router, typed routes, Cache Components) with React 19, Tailwind v4, TanStack Query
over a generated OpenAPI client, and Supabase Auth. The visual target is Mockup B
(`docs/mockup/*.dc.html`); `/dev/kit` shows every component next to it.

## Rules

- **No money math in the client.** Every number on screen comes from the API. Money arrives as
  integer cents and is only formatted (`lib/money.ts`, `<Money>`); never add, split, round for
  logic, or compare amounts here. Arithmetic belongs in `api/calc/`. The one exception is the
  Confirm screen's consistency check (`mathGate`, below): a display-side gate over the person's
  own entries, with the server's 422 as the authority.
- **Tokens only.** Colors, radii, shadows, type sizes and durations are the `@theme` tokens in
  `src/app/globals.css`. No raw hex anywhere else in `src/`; `src/lib/design/tokens.test.ts` and
  ESLint both enforce it.
- **Color means something.** Components take a `Tone`, not a color (`lib/design/tone.ts`): a
  `Hue` (`blue | coral | teal | plum | neutral`) marks a kind of thing, a `Status`
  (`confirmed | warning | off`) marks a state. Green is reachable only as `confirmed`, amber as
  `warning`, red as `off`. ESLint rejects `bg-|text-|border-|fill-|stroke-|ring-` plus
  `green|amber|red` outside `components/ui/**` and `lib/design/**`. The cash-flow diagram and
  legend swatches take a `FlowColor` (token names, mapped to classes by `flowBg`, `flowFill`,
  `flowRing`), never a status.
- **Tests first.** Every component, hook, reducer and lib function gets a failing `*.test.ts(x)`
  before the implementation. Config files are exempt.
- **No em dash** in any text, code, comment or commit. ESLint flags it in strings and JSX.
- Accessibility is part of done: labeled controls, keyboard paths, 44px targets, reduced motion
  (durations go to zero, press scale is dropped), reduced transparency (the header turns solid).

## Commands

pnpm comes from Corepack (`"packageManager"` in `package.json`). If `pnpm` is not on your PATH,
run `corepack enable` once, or prefix commands with `corepack pnpm`. Node 22.13+ is required.

| Command                                 | What it does                                                                         |
| --------------------------------------- | ------------------------------------------------------------------------------------ |
| `pnpm dev`                              | Next dev server on :3000                                                             |
| `pnpm build`                            | Production build (also typechecks)                                                   |
| `pnpm lint`                             | ESLint, zero warnings allowed                                                        |
| `pnpm format` / `pnpm format:check`     | Prettier with Tailwind class sorting                                                 |
| `pnpm typecheck`                        | `next typegen` (route types) then `tsc --noEmit`                                     |
| `pnpm test` / `pnpm test:watch`         | Vitest (jsdom, Testing Library, MSW) over `src/**/*.test.ts(x)`                      |
| `pnpm e2e`                              | Playwright: smoke (axe, screenshots, a Tab walk at 1280x820 and 390x844), auth flows |
| `pnpm exec playwright install chromium` | One-time browser install for `pnpm e2e`                                              |
| `pnpm gen:api`                          | Regenerate `src/lib/api/schema.d.ts` from `../api/openapi.json`                      |
| `pnpm check:api`                        | Regenerate and fail if the committed schema drifted (CI)                             |

`pnpm e2e` starts `next dev` on :3100 (`/dev/kit` is a 404 in production builds) with
`NEXT_PUBLIC_FEATURES=e2e,sankey`. `playwright.config.ts` loads `web/.env.local` (variables
already in the environment win), so local runs use your Supabase project; see "End-to-end auth
tests" below.
Screenshot baselines live in `e2e/__screenshots__/` per platform: `*-darwin.png` for local macOS
runs, `*-linux.png` for CI.
CI runs Playwright inside `mcr.microsoft.com/playwright:v1.64.1-noble`; regenerate Linux
baselines in that same image (mount `web/` read-only, copy it without `node_modules`, run
`pnpm install --frozen-lockfile && pnpm exec playwright test --update-snapshots`, copy the
`*-linux.png` files back). Update baselines only in their own commit, after looking at the diff.

## Layout

```
src/app/            routes. (auth)/sign-in; (app)/setup/{link,confirm,confirm/[documentId],spending,decisions},
                    (app)/why (index of saved decisions), (app)/why/[decisionId], (app)/plan,
                    (app)/check-in (list of check-ins), (app)/check-in/[checkInId]; (app)/error.tsx
                    (the segment's error boundary); dev/kit
src/app/auth/callback/route.ts  exchanges the email-link code for a session
src/proxy.ts        Next 16 proxy (formerly middleware): refreshes the Supabase session, sends
                    signed-out requests for (app) screens to /sign-in, forwards the requested path
src/components/ui/  design system (below)
src/components/chrome/  app frame (below)
src/components/screens/<screen>/  one 'use client' screen component per page
src/components/sankey/  the cash-flow diagram: layout.ts, popover.ts, keyboard.ts, useFlowPopover,
                    useContainerWidth, CashFlowSankey, FlowStack (see "Cash flow diagram")
src/components/icons.tsx  the mockup's SVG glyphs, decorative, drawn in currentColor
src/lib/            api/ (schema.d.ts, types.ts, base-url.ts, auth-middleware.ts, client.ts,
                    upload.ts, download.ts, keys.ts, errors.ts, hooks/), auth/ (next-path, protected,
                    validation, errors, account), supabase/ (env, client, server, proxy),
                    design/ (tone.ts, tokens.ts), money.ts, dates.ts, accounts.ts, categories.ts,
                    documents.ts, decisions.ts, deep-equal.ts, features.ts, findings.ts, periods.ts,
                    setup-progress.ts, routes.ts, navigation.ts, query-client.ts, cn.ts,
                    page-hydration.ts, log-error.ts
src/app/dev/screens/{link,account,spending,confirm,confirm/manual,confirm/benefits,confirm/extracting,
                    confirm/failed,confirm/confirmed,decisions,why,why/fallback,why-index,check-in,
                    check-in/complete,check-in-index,plan,plan/empty}  a screen on the sample data, no
                    API (development only); `account` is Link with the header's account menu
src/test/           setup.ts (jest-dom, MSW lifecycle, db reset), render.tsx, fake-xhr.ts,
                    fake-download.ts (object URLs and anchor clicks recorded, no navigation),
                    fixtures/sample.ts (the Acme / J. Rivera dataset), fixtures/documents.ts (the
                    Acme pay stub as the API proposes it), fixtures/decisions.ts (profile, 401(k)
                    decision, explanations, calendar event), fixtures/k401-results.json (calculator
                    results made by api/calc, with make-k401-results.py), fixtures/planning.ts (the
                    emergency fund, health plans, goal, benefits plans and benefits proposal; results
                    from emergency-fund-results.json and health-plans-results.json, made by
                    make-emergency-fund-results.py and make-health-plans-results.py),
                    fixtures/w4.ts (the W-4 sample and decision; results from w4-results.json,
                    made by make-w4-results.py),
                    fixtures/cashflow.ts (the sample period's cash flow, spending summary and
                    recurring charges), msw/db.ts (in-memory API state), msw/handlers.ts (every
                    route, stateful), msw/spending-handlers.ts (cash flow, summary, recurring;
                    `spendingDb`), msw/planning-handlers.ts (M6 and M7 calculators, goals,
                    benefits plans, benefits confirm; `planningDb`),
                    fixtures/checkins.ts (spec 015's November user: check-ins, findings, plan
                    lines, calendar, net worth, holdings), msw/checkin-handlers.ts (`checkinDb`),
                    fixtures/plan.ts (`GET /plan` built from the decision, goal, calendar and pay
                    stub fixtures; export jobs), msw/plan-handlers.ts (`planDb`)
e2e/                Playwright specs (smoke, auth.setup, auth, link, confirm, spending, decisions,
                    plan, import, check-in, alpha), support/auth.ts, support/api.ts, fixtures/ (synthetic
                    acme-paystub.pdf and the script that makes it, bank-export.csv), baselines
../docs/user-test/  the 5-to-8-person user test kit (script, quiz, consent, observation sheet)
```

## Component map

Each `components/ui` component is derived from a mockup class; the class is named in its doc
comment.

| Component                                       | Mockup                                            | Notes                                                                                                                                                                                                                               |
| ----------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Button`                                        | `.btn`, `-primary`, `-confirmed`, `-sm`, `-block` | `variant` default, primary, confirmed (requires `pressed`); `size` md 44px, sm 36px; `href` renders a Next `Link`; `loading` keeps the label and width, sets `aria-busy`, ignores clicks; press scale 0.97 off under reduced motion |
| `Badge`                                         | `.badge`, `badge-*`                               | `tone`, `solid`, `icon`, `href`                                                                                                                                                                                                     |
| `Chip`                                          | `.chip`                                           | header context                                                                                                                                                                                                                      |
| `Card`                                          | `.card`, `.fallback`                              | `as`, `padding` 20 or 24, `gap`, `tint` confirmed or warning, `inset`                                                                                                                                                               |
| `Tile`                                          | `.result`, `.tile`                                | recessed panel, `tone` washes it in a hue                                                                                                                                                                                           |
| `StatTile`                                      | `.tile .k .v`, `.stat`                            | `label`, `value`, `sub`, `tone`, `size` md or sm; `loading` shows skeletons and sets `aria-busy`                                                                                                                                    |
| `IconTile`                                      | `.ico`, `.sev`                                    | `tone`, `label` (initials), `muted`                                                                                                                                                                                                 |
| `Bar`                                           | `.bar`, `.track`                                  | progressbar; `value` clamped 0-100; `tone` required; `height` 8 or 6; `indeterminate` slides a segment and drops `aria-valuenow`                                                                                                    |
| `JobProgress`                                   | `.bar` with a label row                           | a background job from `useJob`: label, status words in a polite live region, percent, blue bar (indeterminate until the job reports progress); dead or unreadable becomes a warning with Try again                                  |
| `Skeleton`                                      | none                                              | decorative placeholder for a value on its way; pulses, still under reduced motion; the region around it carries `aria-busy`                                                                                                         |
| `RelativeTime`                                  | none                                              | "4 minutes ago" in a `<time>`, kept current; server and hydration render the plain date, so the HTML never depends on the clock                                                                                                     |
| `KV`, `KVList`                                  | `.kv`                                             | a `<dl>`; `verified` adds the "=" mark; `spacing` compact, comfortable, panel; `rules`                                                                                                                                              |
| `Seg`                                           | `.seg`                                            | generic options; role group of `aria-pressed` buttons; one tab stop; arrows, Home, End; `value` may be `null` (nothing chosen yet)                                                                                                  |
| `Input`, `Select`, `Label`, `Range`, `Checkbox` | `.input`, `.label`, `.range`, `.check`            | `Range` shows the two-sided label row and speaks `valueLabel`                                                                                                                                                                       |
| `FieldError`                                    | none (follows the input's invalid border)         | inline message under an invalid field; `id` for `aria-describedby`; renders nothing when empty                                                                                                                                      |
| `Notice`                                        | `.notice` and inline result rows                  | `tone` blue, confirmed, warning; `compact`; forwards `ref` (focus a notice that replaced the control pressed)                                                                                                                       |
| `CardErrorBoundary`                             | `.card` (fallback only)                           | class component; `title`, `className` (the card's layout classes, kept by the fallback); see "Error boundaries"                                                                                                                     |
| `Swatch`                                        | `.sw`                                             | token `color` or `dashed` (a $0 node)                                                                                                                                                                                               |
| `ListRows`                                      | `.list`                                           | hairline-separated rows                                                                                                                                                                                                             |
| `DropZone`                                      | `.drop`                                           | a real file input, keyboard operable; filters by `accept` (drops too)                                                                                                                                                               |
| `Money`, `Num`                                  | `.num`                                            | format only: cents in, tabular numerals, `decimals` 0 or 2, `signed`, `tone`                                                                                                                                                        |

Chrome (`components/chrome`): `Wordmark`, `Header` (`chips`, `account` slot, `minimal`),
`HeaderAccount` (server: "Sample data" chip and `UserMenu` from the Supabase user), `UserMenu` (the
user chip as a disclosure button with "Sign out" and "Delete account"; see "Deleting the account"),
`DeleteAccountConfirm`, `NavStep`, `SideNav`
(`current`, `done` from `lib/setup-progress.ts`, `hrefs` for id-bound screens; wraps into a chip
row under 780px), `AppSideNav` (current item from the URL), `Shell` (header, nav column
`1 1 200px` up to 240px, main `999 1 560px`, skip link), `PageTitle` (`title`, `lead`, `aside`,
`eyebrow`), `StepFooter` (`back`, `next` with `primary`, `disabled` and `loading`; a disabled
next is a real disabled button, never a dead link).

## Data layer

- **Hooks** live in `src/lib/api/hooks/` (one file per area, re-exported from `hooks/index.ts`);
  screens import them from `@/lib/api/hooks`. Reads use `$api.useQuery` (its `error` is the API's
  `{ error: { code, message } }` body); paginated reads and mutations use TanStack directly over
  `fetchClient`, through `unwrap()`, which throws an `ApiError` (`lib/api/errors.ts`): `status`,
  `code`, `error` (the body's error, so it reads like a bare body) and `retryAfterSeconds` from
  Retry-After. A mutation that throws its own class (`ResultMismatch`, `PayStubUnbalanced`) extends
  `ApiError`, and so do `UploadError` and `DownloadError`. Turn errors into sentences with
  `apiErrorMessage(error, fallback)`, never by printing the object.
- **Limits** (M10): every write route can answer 429 `rate_limited` (with Retry-After, which the
  API exposes through CORS) and 413 `body_too_large`. `apiErrorMessage` turns any 429 into the one
  sentence `rateLimitMessage` makes, "You have reached the limit for now. Try again in about 20
  minutes." (`formatWait`, from `parseRetryAfter`; "later" without the header), and a 413 into the
  API's message, so a surface only adds its own lead ("Could not sync Chase."). Never special-case
  429 on a screen. `components/screens/limits.test.tsx` refuses every mutation surface with both and
  checks what it says; add a row for a new one.
- **Keys** (`lib/api/keys.ts`): `$api` caches under `[method, path, init?]`, so `['get', path]` is a
  prefix of every read of a route. Invalidate through the helpers there (`invalidateAccounts`,
  `invalidateSpending`, `invalidateLinkedData`, `invalidateRecurring`, `invalidateForJob`), not
  with keys spelled at call sites. `useTransactions` is an infinite query under
  `queryKeys.transactionPages(filters)`; the trailing `'pages'` keeps its `InfiniteData` apart
  from plain reads under the same prefix. After an unlink, `invalidateAfterUnlink` reads again
  everything an institution fed (spec 017 rules 12-14): accounts, transactions, summary, cash flow,
  recurring charges, check-ins, net worth, holdings, goals and the plan. `DELETE /sync/items/{id}`
  returns no id for the `recurring.detect` job it queues, so recurring charges and check-ins are
  read once now and again whenever their screens next fetch.
  Documents: `invalidateDocuments` after an upload or extraction, `invalidateAfterConfirm`
  (documents, pay stubs, benefits plans, the profile and the plan) after a confirm. Decisions: `invalidateDecisions` (the list and every
  `GET /decisions/{id}`) and `invalidateAfterDecision` (also calendar, plan and goals) after a save.
  `GET /plan` repeats decisions, goals, the calendar, explanation statuses and the newest pay stub,
  so whatever changes one of those invalidates `queryKeys.plan()` too (a goal change, a new
  explanation, a confirm, a sync's balances).
- **Calculators**: `useCalc(path, inputs)` (`hooks/calc.ts`) runs a `POST /calc/*` route as a
  query keyed by its body (`queryKeys.calc(path, body)`), so the same inputs never ask twice. It
  waits `CALC_DEBOUNCE_MS` (150 ms) after the inputs stop changing, keeps the previous result on
  screen while the next one loads (`placeholderData: keepPreviousData`), and returns `isBusy`
  for the result panel's `aria-busy` and `isCurrent` (the result is for the inputs on screen; only
  then can it be saved). Pass `null` inputs while the form is incomplete. Its `staleTime` is
  `'static'` when the client default is (the sample QueryClient), so it never reads the clock
  while rendering; otherwise `Infinity`, which still lets a 422 refetch it.
- **Decisions**: `useDecisions`, `useDecision(id)`, `useCalendar`, and
  `useSaveDecision(calculator)`, which posts `{ calculator, inputs, result, supersedes_id }` with
  `supersedes_id` set to the current version's id. A 409 `decision_conflict` (someone saved first)
  reloads the decisions; a 422 `result_mismatch` throws `ResultMismatch` (`fields` from the
  details) and invalidates that calculator's results so the card recalculates and asks to save
  again. `decisionSaveState(current, inputs)` (`lib/decisions.ts`) drives the save button and
  badge: unsaved, `saved` ("Saved as v2"), or `dirty` ("Save as v3"), comparing inputs
  structurally (`lib/deep-equal.ts`, so key order and object identity do not matter). The API
  names calculators `k401_match` and `health_plans`; the feature flags say `401k_match` and
  `health_plan`: convert with `calculatorIdOf`.
- **Goals and plans**: `useGoals()` reads `GET /goals` (a saved emergency fund decision makes or
  updates one); `useUpdateGoal()` PATCHes `{ goalId, patch }` (status `active`, `paused`,
  `reached`, or a new `monthly_contribution_cents`), writes the returned goal into the cache, then
  reads the list and the plan again. `useBenefitsPlans()` reads the confirmed plans (`GET /benefits-plans`,
  newest summary first) that the health plan card compares.
- **Explanations**: `useExplanation(decisionId)` reads `GET /decisions/{id}/explanation` (a 404
  means none yet); `useExplain()` posts `{ decisionId, force }` to `POST /explain` and writes the
  row it returns into that cache. `POST /explain` answers only once the explanation is final
  (verified or fallback), so there is nothing to poll; `force` makes a new attempt after a
  fallback. A 503 `llm_unavailable` means the API has no model configured.
- **Optimistic writes** cancel the affected reads, patch every cached copy (`setQueriesData` over
  the prefix, paged or not), keep a snapshot for rollback in `onError`, and invalidate in
  `onSettled`. Mirror what the server will write: `useFixCategory` also relabels the merchant's
  other rows as `rule` and sets `confidence: null`, as the API does. Destructive writes (unlink,
  delete the account) are not optimistic: the rows leave when the server says they are gone. A
  write whose control leaves with the rows (an institution's Unlink) is owned by the component that
  stays (`AccountsCard`), which reads the outcome from the mutation's state: a `mutate` callback is
  dropped once its component unmounts.
- **Job polling**: a route that queues work returns a `job_id`; pass it to `useJob(jobId)`, which
  polls `GET /jobs/{id}` every 1.5 s (`JOB_POLL_MS`), stops at `succeeded`, `dead` or a read error,
  and on finishing invalidates what its kind changes (`JOB_INVALIDATES` in keys.ts; add a row when
  a job kind starts mattering to a screen). Show it with
  `<JobProgress job={job.data} failed={job.isFailed} onRetry={...} />`. Sync jobs report no
  percent, so the bar stays indeterminate until they end.
- **A route the API does not have yet**: a screen that needs one gets a hook with the signature
  it will keep, returning `undefined`, next to a shape with a `TODO(<route>)` (the pattern
  `lib/api/pending.ts` held until every route landed). Screens render `undefined` as a skeleton
  (totals) or an empty state (lists), never a client-side substitute. To wire one: `make types`,
  delete its shape, return `$api.useQuery(...).data` under the key reserved in `keys.ts`, and add
  the MSW handler.
- **Spending reads** (`hooks/spending.ts`, `hooks/recurring.ts`): `useCashflow(period)` is
  `GET /cashflow`, the withholding lines beside the period's spending summary; the Spending screen
  reads its tiles and its diagram from that one response, and keeps the last period on screen
  while another loads (`keepPreviousData`). `useSpendingSummary(period?)` is the summary alone
  (setup progress reads it). A `Period` is `{ start, end }`; `null` sends no dates and the API
  reads the last complete UTC month. `lib/periods.ts` builds the picker's options from
  `useToday()` (null on the server, so nothing reads the clock while rendering).
  `useRecurring()` lists recurring charges; `useUpdateRecurring()` PATCHes `user_status` or
  `name` optimistically, with rollback.
- **Check-ins and net worth** (`hooks/checkins.ts`, `hooks/net-worth.ts`): `useCheckIns()`,
  `useCheckIn(id)` (a 404 is not retried), `useUpdateFinding(checkInId, { onError })`,
  `useNetWorth(months)` and `useHoldings()`. `useUpdateFinding` takes `{ findingId, type }` with
  `type` `done`, `dismiss` or `undo` (sent as `user_action` `done`, `dismissed`, `null`). It is
  optimistic through the pure `findingsReducer` (`lib/findings.ts`), which mirrors the server
  (spec 015 rules 13 and 18: the action and its time, `handled_count`, `status` and
  `completed_at`); a refusal runs its `restore` action on that one finding only, so another
  finding changed meanwhile keeps its change, and the hook-level `onError` fires for every refused
  change (a `mutate` callback would miss an earlier one). The check-in and the list are read
  again (`invalidateCheckIn`) once no other finding write is in flight. `useCalendar({ from, to })`
  bounds `due_at`; with no bounds it is the plain read under `queryKeys.calendar()`. A finished
  `checkin.monthly` job refreshes the list and every check-in; a sync refreshes net worth and
  holdings.
- **The plan** (`hooks/plan.ts`, spec 016): `usePlan()` is `GET /plan`. `useExportPlan()` posts
  `POST /plan/export` (`start()`; the API returns the queued job again while one waits), follows
  the `plan.export` job with `useJob`, and gives `pdfUrl` once it succeeded; a dead job is
  `job.isFailed` and `start()` queues a new one. `useDownloadPlanPdf()` (by job id) and
  `useDownloadCalendar()` wrap the downloads below and resolve with the saved file's name.
- **Downloads** (`lib/api/download.ts`): a link cannot carry the bearer token, so
  `downloadPlanPdf(jobId)` and `downloadCalendar()` fetch through `fetchClient` with
  `parseAs: 'blob'` (the token, one refresh and one resend on a 401, like every request), name
  the file from Content-Disposition (`filenameFrom`, `filename*=` first, no directory part) and
  hand it over with `saveFile` (an object URL on a hidden anchor in the document, clicked, revoked
  after `REVOKE_AFTER_MS`). The API exposes Content-Disposition through CORS; without it (an older
  API) the names fall back to `first-paycheck-calendar.ics` and `first-paycheck-plan.pdf`. Failures
  are `DownloadError`, an `ApiError` (`status` 0 for no answer).
- **Uploads** (`lib/api/upload.ts`): `POST /docs` and `POST /accounts/import` (`importCsv`,
  wrapped by `useImportCsv`) go over XMLHttpRequest, because fetch cannot report upload progress.
  They share `sessionTokens` with the fetch middleware (one refresh and one resend on a 401; a
  401 `account_deleted` signs out at once), and fail with `UploadError`, an `ApiError`. `useUploadDocument` wraps the document upload; the Link documents card then calls
  `useExtractDocument` and follows the job with `useJob`. A CSV import refused with 422
  `csv_invalid` carries its row errors: `csvProblems(error)` reads `{ errors, total }` (the first
  50 and how many in all); the Link screen's `CsvImport` lists them, offers Try again on 409
  `import_conflict`, and follows the two job ids the import returns. `lib/documents.ts` maps a
  document's status to its badge and reason text; `isReviewable`/`newestReviewable` pick what
  Confirm opens: a pay stub first, else a benefits summary that was read.
- **Money** is formatted only. Transactions keep Plaid's sign (positive is money out):
  `formatTransactionAmount` and `transactionFlow` in `lib/money.ts` turn that into "-$84.12" and
  "+$1,996.04". Counting rows (the source badges) is fine; summing amounts is not.

## Screen tests

- MSW handlers in `src/test/msw/handlers.ts` read and write `db` (`src/test/msw/db.ts`), seeded
  from `src/test/fixtures/sample.ts` and reset after every test, so a refetch after a PATCH reads
  the new value. `emptyDb()` gives a new user; assign `db.transactions` for pagination cases;
  `server.use(...)` overrides one route for an error or a delay.
- Spending routes (`GET /cashflow`, `GET /spending/summary`, `GET /recurring`,
  `PATCH /recurring/{id}`) live in `src/test/msw/spending-handlers.ts` over `spendingDb`, seeded
  from `fixtures/cashflow.ts` and reset after every test.
- Check-in routes (`GET /check-ins`, `GET /check-ins/{id}`, `PATCH .../findings/{fid}`,
  `GET /net-worth`, `GET /holdings`) live in `src/test/msw/checkin-handlers.ts` over `checkinDb`,
  seeded from `fixtures/checkins.ts` (November open with nine findings, October completed) and
  reset after every test. `GET /calendar` filters `from`/`to` over `db.calendar`.
- Plan routes (`GET /plan`, `GET /plan/calendar.ics`, `POST /plan/export`,
  `GET /plan/export/{job_id}`) live in `src/test/msw/plan-handlers.ts` over `planDb` (`plan`,
  the export job ids handed out), reset after every test. `samplePlan()` (every decision saved;
  the 401(k) explanation verified, the health plan's a fallback, the W-4's not written),
  `partialPlan()` (the 401(k) only) and `emptyPlan()`; each figure is copied from its decision
  by the key the API names, never written by hand. The n-th export is `exportJobId(n)`; one
  nothing scripted has already succeeded, so `scriptJob(exportJobStates(exportJobId(1)))` before
  the click shows queued, running and succeeded. The PDF streams only for a succeeded export.
  Downloads in jsdom: `watchDownloads()` (`src/test/fake-download.ts`) records each saved file;
  call `restore()` and `vi.restoreAllMocks()` in `afterEach`.
- `scriptJob(states, onSucceeded)` scripts what `GET /jobs/{id}` returns poll by poll;
  `syncJobStates(id)` is queued, running at 40%, succeeded. Drive polling with
  `vi.useFakeTimers({ shouldAdvanceTime: true, now: new Date(SAMPLE_NOW) })` and
  `await act(() => vi.advanceTimersByTimeAsync(JOB_POLL_MS))`, and render with
  `renderWithProviders(ui, { advanceTimers: vi.advanceTimersByTime })` so userEvent keeps up.
- Uploads use XMLHttpRequest, which MSW does not see in jsdom: `installFakeXhr()`
  (`src/test/fake-xhr.ts`) records each request so a test can report progress and respond;
  restore with `vi.unstubAllGlobals()`. `extractJobStates(jobId, documentId)` scripts an extraction
  that writes `db.nextProposal` when it succeeds; `emptyDocuments()` clears the documents.
- Assert requests with `server.events.on('request:start', ...)` and remove the listeners in
  `afterEach`. For hooks, `renderHookWithClient(hook)` returns the `queryClient` for cache checks.
- `DELETE /me` empties `db` (`emptyDb()`) and answers 204. A test of the sign-out paths mocks
  `@/lib/supabase/client` and `@/lib/navigation` (see `UserMenu.test.tsx`, `account.test.tsx`).
- `components/screens/card-boundaries.test.tsx` mocks one card per screen to throw and checks the
  rest of the screen still works; `limits.test.tsx` is the 429 and 413 table (see "Limits").
- Third-party widgets are mocked at the module (`vi.mock('react-plaid-link', ...)`, see
  `LinkScreen.test.tsx`), and the test calls the callbacks the widget would.
- Screen tests cannot name status colors (ESLint): test a tone through a pure helper
  (`sourceBadge`, `saveBadgeTone`) or in the `components/ui` tests.
- Decisions: `decisionsReady()` seeds a confirmed pay stub and a profile with match tiers;
  `savedDecision()` adds v1 at 4%. `POST /calc/401k-match` answers from
  `fixtures/k401-results.json`, results the API's own calculator produced; a case not in it is a
  500 `test_fixture_missing`, never a result worked out in the test. To add cases, edit
  `make-k401-results.py`, run it from the repo root with
  `uv run --project api python web/src/test/fixtures/make-k401-results.py`, then `pnpm format`.
  `db.llmConfigured = false` makes `POST /explain` a 503; `db.explainOutcomes` scripts whether
  each attempt comes back verified or fallback.
- M6 routes live in `src/test/msw/planning-handlers.ts` over `planningDb` (goals, benefits plans),
  reset after every test: `POST /calc/emergency-fund` and `POST /calc/health-plans` answer from
  `emergency-fund-results.json` and `health-plans-results.json` (made by
  `make-emergency-fund-results.py` and `make-health-plans-results.py`, run like the 401(k) one; a
  missing case is a 500), saving either decision applies its effects (the goal and its
  contribution and review events; the enrollment deadline event), and a benefits confirm writes
  plans and the profile's match. Helpers: `savedEmergencyFund()`, `savedHealthPlan()`,
  `benefitsConfirmed()` (the two sample plans), `benefitsWaiting()` (the sample summary proposed).
  `POST /calc/w4` answers from `w4-results.json` (`make-w4-results.py`, which also writes the
  case each suggestion leads to once applied); a saved W-4 adds the `w4_submit` reminder, and
  `savedW4()` seeds v1 (the sample reading the saved 401(k) and Gold PPO decisions).
- Debounces: measure them on the fake clock instead of asserting "nothing yet at 149 ms", which
  races `shouldAdvanceTime`. Record `Date.now()` when the input stops and when the request starts
  (`request:start`), and assert the difference is at least the debounce. Set inputs with
  `fireEvent.change` so typing does not spread over the window being measured.

## Error boundaries

- **Per card**: `CardErrorBoundary` (`components/ui`, a class component because React has no hook
  for one) wraps every calculator card, the Sankey, the spending summary, recurring and
  transactions cards, the check-in's findings, plan lines and dates, net worth (on both check-in
  screens), every plan card and the Link cards. Wrap at the screen, around the card, with the
  card's title and its layout classes (`className`, so a flex basis survives the fallback). A
  render error shows the card's frame, its title and a calm blue `role="status"` notice ("This card
  could not be shown. The rest of the page still works, and nothing you saved has changed.") with
  Try again, which remounts the card (a new key). A new card on a screen gets a boundary.
- **Per segment**: `app/(app)/error.tsx` (Next's convention, which lets `redirect()` and
  `notFound()` through) catches what no card boundary did, inside the header and side nav: "This
  page could not be shown", Try again (Next's `retry`) and a plain "Reload the page" link to the
  same address.
- Both log once with `console.error` through `logErrorOnce` (`lib/log-error.ts`, which remembers
  error objects, so Strict Mode's second effect run does not log again). React logs a caught error
  too; there is no web Sentry.

## Deleting the account

The header's account menu (`UserMenu`) has Delete account under Sign out. It swaps the panel for
`DeleteAccountConfirm`: what goes, a field labeled "Type delete to confirm" (focused; capitals and
spaces around the word do not matter; Enter submits only once it says delete), Delete my account
and Keep my account (which returns focus to Delete account). Closing the menu (Escape, a click
elsewhere) drops the confirmation. `useDeleteAccount` calls `DELETE /me`, then
`sessionTokens.accountDeleted()`: the local session is cleared through the Supabase client and the
browser goes to `/sign-in?deleted=1`. Success means the page is unloading, so the button stays busy.
A failure says "Your account was not deleted." with the reason and keeps the person signed in.

## Accessibility audit (M10)

Every sample screen runs in the smoke spec at 1280 and 390: axe, the visual baseline, and a Tab
walk (`tabWalk`): every control a person can Tab to (tabindex 0; a roving group's one stop) is
reached, each shows a focus ring (an outline on it, or on the ancestor that draws one for a
visually hidden input, as `DropZone` does), none lands under the sticky header, and Tab leaves the
page (a date field takes one Tab per part and is not a trap). M10 added the sample screens that
were missing: sign-in after a deletion (`/sign-in?deleted=1`), Confirm while reading, failed and
confirmed, and `account` (the account menu); the unlink and account deletion confirmations are
checked in place.

What the audit found and fixed:

- axe at serious or critical: nothing on any screen. At every impact, one minor
  `aria-allowed-role`: the account deletion confirmation put `role="group"` on its `<form>`; the
  group is now a `<div>` around the form. With that, no screen has a violation at any impact, so
  the smoke spec's gate is now every impact, not only serious and critical.
- Keyboard: every control on every screen was reachable with a visible ring and no trap; the walk
  stays in the smoke spec so it stays true. Focus after an action that removes its control now
  moves somewhere useful: an unlink focuses its done notice, Keep my account returns to Delete
  account.
- Motion: every `animate-` and `transition` was checked (`Bar`, `Button`, `Seg`, `Skeleton`,
  `DropZone`, `FieldRow`, `UserMenu`, the Sankey's popover and bands; Recharts runs with no
  animation). Durations are tokens that reduced motion sets to zero; the indeterminate bar and the
  button spinner pulse in place; the popover fades instead of growing. One bug: `Seg` transitioned
  `transform` while Tailwind v4's `scale-*` sets `scale`, so its press feedback never animated; it
  now transitions `scale`, like `Button`. The smoke spec's reduced-motion test emulates the setting
  and fails on any running movement animation or a movement transition with a duration.

## Confirm screen

`/setup/confirm` opens the newest pay stub waiting for review (else a benefits summary); `/setup/confirm/[documentId]`
reviews one (`ConfirmScreen`, which also covers the extracting, failed, confirmed, benefits and
offer letter states).

- **State** is `confirmReducer` (`screens/confirm/confirmReducer.ts`), ported from the mockup's
  script: `select`, `toggle`, `edit`/`draft`/`save`/`cancel`, `confirmAll`. Every value is a
  proposal until confirmed, and `payStubValues` sends only confirmed values. `parseDraft` reads
  money with `parseMoney` (cents), dates as ISO, choices (pay frequency) from `FIELD_CHOICES`.
- **Math gate**: `mathGate` checks gross minus deductions equals net over the confirmed or drafted
  values (`ok`, `off` with the difference, `unknown` when a value is missing or invalid). Which
  fields take part comes from each field's `role` (`gross`, `deduction`, `net`) in the API
  response, never a list of keys. Continue needs every field confirmed and the gate `ok`. The
  server checks again: a 422 `pay_stub_unbalanced` becomes `PayStubUnbalanced` from
  `useConfirmDocument`, and the screen renders its diff (`MathNotice`).
- **Manual entry**: a proposal with `manual_entry_required` starts every field empty and in edit;
  the source pane shows the redacted lines to type from, Confirm all is off, and each row saves on
  its own.
- **Source pane**: the redacted lines the AI saw, with redactions drawn as labeled bars
  (`role="img"`, "Redacted") and the selected field's line marked `aria-current`.
- **Benefits summary** (`BenefitsReview`, spec 013): `initBenefitsState` (`benefits-fields.ts`)
  lays the proposal's plans, match tiers and vesting out as reducer fields keyed
  `plans.1.deductible_cents`, `match_tiers.0.employer_pct`, `vesting_years`, each with a `group`
  ("Plan 2", which accessible names include), `required` (an HSA amount, a deadline and vesting
  may be empty) and choices (plan type, vesting years). There is no math gate. `benefitsValues`
  sends `{ plans, retirement }`, with `retirement: null` when the summary shows no match so the
  profile keeps its own. The screen then shows what was stored (`profile_updated` says the match
  and vesting changed) and links to Decisions. A benefits summary nothing could be read from is
  not typed in here: Confirm and Link point to the decision cards. Its lines are not linked to
  fields, so the source pane highlights nothing (`linked={false}`).

## Decisions screen

`/setup/decisions` (`DecisionsScreen`) shows one card per calculator in the mockup's order
(emergency fund, 401(k), health plan, W-4) with an "n of 4 saved" badge that counts every saved
calculator. Every calculator has a card; one off in `features.calculators` is a muted "After
alpha" placeholder. Cards share `DecisionCard`, `SaveButton`, `AmountField` and `saveErrorText`
(`decision-format.ts`).

- **`Match401kCard`** always renders the same `DecisionCard` frame (a region named by its title)
  and swaps its body: skeleton, error, a link to Confirm when there is no confirmed pay stub,
  `PlanDetailsForm` when the profile has no salary, match tiers or birth year (saved with
  `PUT /profile`, so each is asked for once; the mockup has no such form), or the calculator.
  Inputs come from the confirmed pay stub and profile; the contribution starts from the saved
  decision. The calculator still takes `age`, which is `ageAtYearEnd(tax_year, birth_year)`
  (`lib/decisions.ts`), a difference of years.
- Every figure in the result (`K401ResultRows`, `K401Notices`, `matchHeadline`) is a field of the
  calculator's result. Percent inputs are sent as the API stores them, two-place strings
  (`percentInput`), so a saved decision compares equal to the inputs on screen.
- Save is enabled only when `useCalc` says the result is current. A 422 `result_mismatch`
  refetches the result and asks to save again; a 409 reloads the decisions and says another save
  came first.
- **`EmergencyFundCard`** (spec 011): essentials start from the spending summary's essentials,
  savings from the one account with the `emergency_fund` role (no route sums balances), else
  typed; target months on a 3 to 12 range; a typed monthly transfer. The result (target,
  shortfall, funded bar, months to target or "not within 10 years", per paycheck) is the
  calculator's. After a save, `EmergencyGoal` shows the goal with Pause or Resume, Mark reached
  and Change contribution (`useUpdateGoal`). There is no "Why" link: spec 011 has no explanation.
- **`HealthPlanCard`** (spec 012): compares the newest confirmed summary's plans (up to
  `MAX_PLANS`, the API's limit), the saved decision's, or plans typed in `PlanOptionsForm`. Usage
  low, medium or high; the comparison table marks the cheapest at that usage and the chosen plan,
  with break-even notes, the HSA tax effect and the HDHP notice from the result. Saving needs a
  chosen plan (a 422 `plan_not_selected` says so); an enrollment deadline adds a calendar event,
  shown under the card.
- **`W4Card`** (spec 014): salary and pay schedule from the profile and the confirmed pay stub,
  the age from the birth year (null without one: no catch-up), and, read-only under "From your
  decisions", the saved 401(k) decision's `contribution_pct` and the saved health plan's chosen
  plan's premium per paycheck (`fromDecisions` in `w4-format.ts`). Either one not saved is sent
  as zero, the card says so, and links to that card. The person sets the filing status (from
  the profile until changed), Step 2(c), the other jobs' wages and withholding, Steps 3 and
  4(a)-(c) and the deductions they expect to claim (empty means the Step 4(b) entry). The result
  is the calculator's: a balance due takes the `off` tone, a refund stays neutral (never
  `confirmed`). "Apply suggestion" copies `suggested_extra_withholding_cents` and
  `suggested_deductions_cents` into Steps 4(c) and 4(b) (`appliedEntries`); when Step 4(b) grows
  and no expected deductions are set, the old Step 4(b) entry becomes them (spec 014 rule 13).
  Always send every input, `k401_contribution_pct` as `"0.00"` when there is no 401(k)
  decision: the API stores its unset default as `"0"`, which would never compare equal. A save
  adds the `w4_submit` reminder, shown under the card; "Why this decision" opens `/why/[id]`.

## Why screen

`/why/[decisionId]` (`WhyScreen`) reads the decision and its explanation; `/why`
(`WhyIndexScreen`) lists current decisions with their versions.

- **Verified**: status checks (numbers checked, citations, retries), the concept, "Your numbers"
  with the verifier's "=" marks, what would change the answer, sources (IRS citations as outbound
  links in a new tab, with the quoted passage) and next steps from the calendar.
- **Fallback**: the plain calculator result (`CalculatorResultCard`) with a notice and "Try
  again", which calls `useExplain` with `force: true`.
- **None yet** (404): offers "Write the explanation". A 503 `llm_unavailable` is a calm blue
  notice, with the calculator result still shown. An unknown decision is "Decision not found"
  with a link back to `/why`.

## Check-in screen

`/check-in/[checkInId]` (`CheckInScreen`, from `CheckIn.dc.html`); `/check-in`
(`CheckInIndexScreen`) lists every check-in with its counts. The side nav's "Monthly check-in"
opens the newest open check-in, else the list (`checkInNavHref`; `/check-in` until the list loads).

- **What changed** (`FindingsCard`, `FindingRow`): findings in the API's order. Each has a
  severity tile (`severityTone`: alert `off`, warning `warning`, info `blue`; neutral once
  handled), its kind, and its text from one small component per payload kind (`FindingText.tsx`),
  which prints payload fields only, formatted, signs included. "Affects" links to the calculators
  or the Spending map. Done and Dismiss become Undo; focus moves to the button that replaces the
  one pressed (and back on a rollback), and a polite status line says what changed. The badge
  reads `handled_count` and `finding_count`; a completed check-in shows a confirmed notice.
- **Cash flow against the plan** (`PlanLinesCard`): `cash_flow.plan` lines as a table with each
  planned line's `Bar` in the line's hue (`planLineTone`). The bar width is geometry
  (`planBarValue`: actual over plan), never shown or compared; the API sends no on-plan status, so
  none is drawn. In a card under 28rem (a container query) the difference moves under the plan.
- **Net worth** (`NetWorthCard`) sits beside it, where the mockup puts it, and on the list of
  check-ins, so it does not wait for the first check-in: the figure, assets and liabilities, the
  change since the first month, `NetWorthChart`, a "Monthly figures" table, each account, and
  `HoldingsTable` (a basis the API sends as null reads "Not reported", for totals too).
- **The chart** is Recharts (the one chart library; pinned): three 2 px lines on one money axis
  with an HTML legend, a crosshair tooltip that lists every series, no animation, and the width
  from `useContainerWidth`. Marks draw in `currentColor` under `toneMark[hue]` (`lib/design/tone.ts`,
  hues only); gridlines take `stroke-line`, dots a `stroke-surface` ring. `netWorthChartData`
  maps the API series to rows without deriving anything. Colors (blue net worth, teal assets,
  coral liabilities) pass the dataviz palette validator; teal is under 3:1 on white, which the
  legend and the table cover.
- **Coming up** (`DeadlinesCard`): `GET /calendar` from the first of the month to the end of the
  next (`checkInWindow`).
- The API cannot create a check-in (no `POST /check-ins`): the worker's monthly tick makes one per
  user, so `e2e/check-in.spec.ts` reads what is there and checks the empty state when there is
  nothing.

## Plan screen

`/plan` (`PlanScreen`, from `Plan.dc.html`) is one read of `GET /plan` (spec 016). The side
nav's "Plan and calendar" gets its done mark when the plan's `completeness.missing` is empty
(`setupProgress`, `planMissingCount`).

- **Completeness**: an "n of 4 decisions saved" badge (`completenessText`, counting the API's
  two lists; `confirmed` when nothing is missing) and "Still to decide" linking each missing
  calculator to its card on Decisions (`DECISION_ANCHORS`, the card headings' ids).
- **Decisions** (`DecisionSummary`): one `DecisionCard` per saved decision in the API's order,
  with "v{n} · Saved {date}", the API's `figures` by their labels (`figureText` formats by
  `kind`: money, a percentage as stored, a count, text; a null `months_to_target` reads "Not
  within 10 years"; a value of the wrong type throws rather than guessing), and the explanation:
  a `confirmed` "Verified explanation" badge linking to Why, a warning notice for a fallback, or
  "Explanation not written yet. Write it". An emergency fund is never explained (spec 011), so
  it shows none (`explanationView`).
- **Your paycheck** (`PaycheckCard`): the newest confirmed stub's gross and take-home tiles and
  its deductions, or a link to Confirm. **Goals** (`GoalsCard`): status badge, contribution,
  target and date, progress bar. **Next 90 days** (`PlanCalendarCard`): `calendar` through
  `calendar_through`, each event in its decision's hue (`eventHue`) with a badge to its card.
- **Export** (`ExportCard`): Download PDF starts `useExportPlan`, shows `JobProgress` while the
  job runs, downloads once it succeeds (once per job), then says "Downloaded {name}." with
  Download again. A dead job offers Try again (a new export); a failed download offers Try
  again (a 404, an export past 7 days, makes a new export). Add to calendar (.ics) downloads at
  once. One polite status line, always rendered, says what was saved.
- Nothing saved yet: a card linking to Decisions, and no export.

## Cash flow diagram

`components/sankey` draws `GET /cashflow` as the mockup does: absolutely positioned HTML buttons
for the amounts over one SVG of cubic bands. Not d3-sankey and not a chart library.

- **Layout** (`layoutCashFlow(flow, containerWidth)`) is pure geometry: four columns (gross pay;
  withholding lines and take-home; buckets; categories), node heights from a scale fixed by a
  400 px target for gross pay (income when there is no confirmed stub), so the "1 px is about $N"
  badge is computed, not hand-tuned. Amounts are placed, never added: a node is as tall as its own
  value or the bands leaving it, whichever is more. Colors are `FlowColor` token names.
  `hostW = max(880, containerWidth)`; narrower containers scroll sideways. Under 640 px the
  Spending card draws `FlowStack` (stacked bars and lists) instead.
- **Popover** state is `flowPopoverReducer` (`popover.ts`) through `useFlowPopover`: hover opens
  after leaving another node only past an 80 ms grace, focus opens, pointer-down pins, outside
  click and Escape close and return focus to the node. The popover is `role="group"`, named by
  its title, and the open node points at it with `aria-controls`.
- **Keyboard** (`nextFocus` in `keyboard.ts`): one tab stop (roving tabindex); Up and Down move
  within a column, Home and End to its ends, Right and Left follow a band (or the nearest node in
  the next column).
- `useContainerWidth` measures with a ResizeObserver and renders at 928 px on the server.
- The popover enters with `animate-pop-in` (a fade under reduced motion). Playwright waits for
  that animation before axe runs: mid-fade text is translucent and fails contrast.

## Adding a screen

1. Write the spec's tests first: `src/components/screens/<screen>/<Screen>Screen.test.tsx`, with
   MSW handlers in `src/test/msw/handlers.ts` for every route it reads (see "Screen tests").
2. Build `<Screen>Screen.tsx` as a `'use client'` component from `ui` and `chrome` parts only.
   Read data with the hooks in `@/lib/api/hooks` (or `$api.useQuery(...)` for a one-off read);
   render numbers with `<Money>`/`<Num>` exactly as the API returns them.
3. Keep `page.tsx` a thin server component that renders the screen and exports `metadata`.
4. Link id-bound screens with the builders in `lib/routes.ts` (`confirmRoute(id)`, `whyRoute(id)`,
   `checkInRoute(id)`): Next's typed `Route` accepts dynamic segments only as literals.
5. Cache Components is on: anything reading cookies, headers, the URL (`usePathname`) or other
   request data must sit inside `<Suspense>`, or the build fails with a blocking-route error.
   Never put an interactive form in a Suspense fallback: it is replaced when the real content
   streams in and drops what the person typed (why `/sign-in` renders in one piece).
6. Render `<HydrationMarker />` as the page's last child (a unit test checks every `page.tsx`).
   The App Router hydrates each segment in its own commit, so a marker in a layout fires while
   the page is still inert, and Playwright then races hydration.
7. Add the screen to the Playwright visual spec: render it on the sample data under
   `/dev/screens/<screen>` (`SampleScreen` seeds a QueryClient that never fetches) and add it to
   `SCREENS` in `e2e/smoke.spec.ts` with `sample: true` (frozen clock, Plaid's script stubbed). It
   then gets axe, a baseline at both widths and the Tab walk. Add a sample for each state that
   renders differently. An end-to-end spec against the real API goes in an `authenticated-*`
   project (below).
8. Wrap each card in a `CardErrorBoundary` with its title.

## Auth

Supabase Auth with `@supabase/ssr` cookies. Without `NEXT_PUBLIC_SUPABASE_URL` and
`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (the `sb_publishable_...` key, never the secret key) auth is
off: the guard lets every screen render and the API client sends no token (unit tests, CI e2e,
previews without secrets).

- **Sign-in** (`/sign-in`, `AuthForm`): password (`signInWithPassword`), account creation
  (`?mode=sign-up`, `signUp`), magic link (`signInWithOtp`). Email links return through
  `/auth/callback?next=`, which exchanges the PKCE code (so the link must be opened in the browser
  that asked for it) and falls back to `/sign-in?error=link`. Success is `hardNavigate(next ?? '/')`,
  a full navigation, so server components re-render with the new cookies and no client cache
  survives from another session. Supabase errors become sentences in `lib/auth/errors.ts`.
- **`next` paths** are untrusted: always pass them through `safeNextPath` (relative, same site, not
  an auth page) and build sign-in links with `signInRoute({ mode, next, error })`.
- **Guard**: the proxy redirects a signed-out request for a signed-in screen (`requiresSignIn` in
  `lib/auth/protected.ts`, every page in `(app)`; a test fails when a new one is not covered) to
  `/sign-in?next=<path>` before anything renders. `(app)/auth-gate.tsx` is the backstop: it
  verifies the user with `getUser()` (deduped per render by React `cache`) and redirects; the path
  comes from the `x-first-paycheck-path` header the proxy sets, because layouts cannot read the
  URL. Redirect in the proxy, not while rendering: `next dev` validates each route's instant UI
  and logs an error when a redirect stops the segment from rendering. `/` sends a signed-in person
  to `/setup/link`.
- **Proxy**: `src/proxy.ts` refreshes the session with `getClaims()` on every request except build
  assets, image optimization, the favicon and paths with a file extension.
- **Server client**: `getSupabaseServerClient()` awaits `connection()` first. supabase-js checks
  the session's expiry with `Date.now()`, which Cache Components rejects during a prerender, and
  dev's instant validation prerenders with the request's cookies, so `cookies()` alone is not
  enough.
- **API calls**: `lib/api/client.ts` attaches `Authorization: Bearer <access_token>`; a 401 triggers
  one shared `refreshSession()` and a retry, and a second 401 signs out locally and goes to
  `/sign-in?next=<current path>`.
- **Sign-out**: the header's user menu calls `signOut({ scope: 'local' })` (other devices stay signed
  in) and fully navigates to `/sign-in`.
- **A deleted account** (spec 017 rule 9): its access token stays valid until it expires, and a
  write under it is a 401 `account_deleted`. The fetch middleware and the uploads skip the refresh
  for it (there is no session left to refresh), clear the local session and go to
  `/sign-in?deleted=1` (`sessionTokens.accountDeleted()`, `signInRoute({ deleted: true })`, which
  drops `next`: nothing is left to return to). The sign-in screen then shows a calm notice,
  "Your account and its data were deleted." (`parseSignInParams().deleted`).
- **Supabase project settings**: add `http://localhost:3000/auth/callback` and each deployed
  `https://<host>/auth/callback` to Auth > URL Configuration > Redirect URLs, or email links fall
  back to the Site URL.

### End-to-end auth tests

`e2e/auth.setup.ts` signs in through the form and saves the session to `e2e/.auth/user.json`
(git-ignored) for the `authenticated` project, which runs `e2e/auth.spec.ts`. Set these in
`web/.env.local` or the environment:

| Variable                                                           | Needed for                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | the signed-out tests (redirect with `next`, wrong-password notice)                                                                                                                                                                                                 |
| `E2E_USER_EMAIL`, `E2E_USER_PASSWORD`                              | the signed-in tests (sign in, return to `next`, sign out, saved session)                                                                                                                                                                                           |
| `NEXT_PUBLIC_E2E_USER_EMAIL`                                       | optional; defaults to `E2E_USER_EMAIL` in e2e runs; shows the "Sample data" chip                                                                                                                                                                                   |
| `E2E_API_URL`                                                      | `link.spec.ts`, `confirm.spec.ts`, `spending.spec.ts`, `decisions.spec.ts`, `plan.spec.ts`, `import.spec.ts` and `check-in.spec.ts`: a running non-production API with Plaid sandbox credentials and a worker; the web server's `NEXT_PUBLIC_API_URL` points at it |

Missing variables skip those tests with a message saying which to set. The e2e user must be a
confirmed user: the hosted project requires email confirmation, so create it in the Supabase
dashboard (Authentication > Users > Add user, "Auto Confirm User") with synthetic data only.
Tests that sign out sign in through the form first, so they never end the saved session the other
tests share.

`link.spec.ts` (project `authenticated-link`) unlinks everything, links Plaid's sandbox bank with
the e2e-only button, follows the sync and sets roles; `spending.spec.ts` (project
`authenticated-spending`, which depends on it) reads those transactions, checks that the
diagram's buckets match the summary tiles, drives a node from the keyboard, changes the period
and saves a category fix; `import.spec.ts` (project `authenticated-import`, after Spending)
imports `e2e/fixtures/bank-export.csv` (five synthetic rows) into a new CSV account, imports it
again without making a second account, and checks a broken file's row errors.
Both change the e2e user's data, so they are ordered projects with serial files rather than
parallel tests. `confirm.spec.ts` (project `authenticated-confirm`) uploads
`e2e/fixtures/acme-paystub.pdf`, a synthetic stub with an example SSN the API must redact and a
masked account number (regenerate it with `node e2e/fixtures/make-acme-paystub.mjs`), waits for
the read, confirms every field and continues to Spending. `decisions.spec.ts` (project
`authenticated-decisions`, after confirm) fills in the plan details if the profile has none,
saves a 401(k) decision, changes it and saves the next version, then opens its explanation and
accepts verified, fallback, or "not available" when the API has no model; it then saves an
emergency fund version and pauses and resumes its goal, and saves a health plan choice (typing two
synthetic plans when no benefits summary is confirmed) with an enrollment deadline, and saves a W-4
version that reads those two decisions, with its reminder. Decisions cannot be
deleted, so it reads the current version instead of assuming v1. `plan.spec.ts` (project
`authenticated-plan`, after decisions) reads the four decisions back on `/plan` (and the nav's
done mark), downloads the `.ics` and checks its first line is `BEGIN:VCALENDAR`, and exports the
PDF through the worker, checking the `GET /plan/export/{id}` response is `application/pdf` and
the saved file starts with `%PDF-`. `check-in.spec.ts` (project
`authenticated-check-in`) lists the check-ins (or the empty state), opens the newest, marks a
finding done and undoes it (checking both survive a reload), and opens a check-in that is not
the user's. Never use a real document as a
fixture.

### Local real-API stack

`make e2e-full` (`scripts/e2e_stack.py`) runs `pnpm e2e` against a stack it starts and stops: a
disposable `first_paycheck_e2e` database (migrated, seeded, two synthetic users), a stand-in for
Supabase Auth that signs ES256 tokens and serves its JWKS (the web signs in through its real form;
the API verifies the same tokens), and the API and worker with `LLM_FAKE=true`. It sets every
variable above itself, plus `E2E_ALPHA_USER_EMAIL`/`E2E_ALPHA_USER_PASSWORD` and
`E2E_PLAID_SANDBOX`; the web runs on `E2E_PORT` 3247. Plaid comes from `PLAID_CLIENT_ID` and
`PLAID_SECRET` in the environment or `.env`; without them `E2E_PLAID_SANDBOX=0` skips
`link.spec.ts` and the alpha's link steps and leaves the spending project out.
`uv run python -m scripts.e2e_stack run -- <command>` runs any command against it (CI's `e2e`
workflow picks the real-API projects), and `up` keeps it running. Logs go to `.e2e-stack/`.

`alpha.spec.ts` (project `alpha`) is the whole alpha as a new user (`E2E_ALPHA_USER_*`, which the
stack makes per run; against a hosted API, a fresh confirmed user): it signs in through the form,
links the sandbox bank and fixes a category, uploads and confirms the Acme stub, reads the
Spending tiles, saves the 401(k) at 4% as v1 and a change as v2, and expects "Verified against
calculator" with an irs.gov source (what the fake model produces).

## Feature flags

`NEXT_PUBLIC_FEATURES` is a comma-separated list, parsed by `lib/features.ts`:

| Flag                    | Effect                                                                                                                                                                                       |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `calculators=<id>+<id>` | Live calculators (`401k_match`, `emergency_fund`, `health_plan`, `w4`); the rest render as muted "After alpha" placeholders. Unset means all live. The alpha ships `calculators=401k_match`. |
| `sankey`                | Show the cash-flow diagram on the Spending screen (`/dev/screens/spending` shows it regardless).                                                                                             |
| `e2e`                   | Test affordances: the sandbox-link button, and no React Query devtools.                                                                                                                      |

## Gotchas

- `openapi-fetch` is created with `fetch: (r) => globalThis.fetch(r)` so MSW (installed after
  import) intercepts it. Keep that if you touch `lib/api/client.ts`.
- Tailwind v4 `scale-*` sets the standalone `scale` property: transition `scale`, not
  `transform`.
- Never let the OS theme paint something a baseline sees. The native select arrow moved 2px on
  macOS between two runs an hour apart (the host had switched to dark appearance), failing every
  darwin baseline with a select; `Select` now draws its chevron in CSS (`select-chevron` in
  `globals.css`, the text color) and hands it back to the platform only in forced colors.
- `cn()` uses a tailwind-merge config that knows the token names; without it `text-small` and
  `text-ink-3` would collide.
- jsdom is pinned to 29 because jsdom 30 needs Node 22.22+; bump it with the Node floor.
- `next dev` writes `AGENTS.md` here; it is gitignored and this file is the agent guide.
- `pnpm e2e` should leave the `next dev` log empty. Dev prerenders each route to validate its
  instant UI, so nothing may read the clock while rendering (no `Date.now()`, no `new Date()`
  outside an effect; the sample QueryClient uses `staleTime: 'static'` and stamps its data) and
  nothing may `redirect()` from inside a layout's Suspense (redirect in the proxy instead). Do
  not use `page.route` in the smoke spec: it turns off Chromium's cache, every request then says
  `Cache-Control: no-cache`, and dev skips that validation (and logs that it did).
- A layout component that reads the API waits for `usePageHydrated()` (`lib/page-hydration.ts`,
  set by `HydrationMarker`), as `AppSideNav` does. The layout hydrates before the page; reads it
  starts earlier can fill the cache before the page hydrates, and the page then hydrates with data
  its server HTML did not have (a hydration mismatch).
- Plaid Link's script loads through `lib/plaid-script.ts`, once per page, and `usePlaidLink` is
  mounted only after it has run. Letting react-plaid-link add it runs it twice under Strict Mode.
