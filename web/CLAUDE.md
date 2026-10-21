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

| Command                                 | What it does                                                                |
| --------------------------------------- | --------------------------------------------------------------------------- |
| `pnpm dev`                              | Next dev server on :3000                                                    |
| `pnpm build`                            | Production build (also typechecks)                                          |
| `pnpm lint`                             | ESLint, zero warnings allowed                                               |
| `pnpm format` / `pnpm format:check`     | Prettier with Tailwind class sorting                                        |
| `pnpm typecheck`                        | `next typegen` (route types) then `tsc --noEmit`                            |
| `pnpm test` / `pnpm test:watch`         | Vitest (jsdom, Testing Library, MSW) over `src/**/*.test.ts(x)`             |
| `pnpm e2e`                              | Playwright: smoke (axe, screenshots at 1280x820 and 390x844) and auth flows |
| `pnpm exec playwright install chromium` | One-time browser install for `pnpm e2e`                                     |
| `pnpm gen:api`                          | Regenerate `src/lib/api/schema.d.ts` from `../api/openapi.json`             |
| `pnpm check:api`                        | Regenerate and fail if the committed schema drifted (CI)                    |

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
                    (app)/check-in/[checkInId]; dev/kit
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
                    upload.ts, keys.ts, errors.ts, hooks/), auth/ (next-path, protected,
                    validation, errors, account), supabase/ (env, client, server, proxy),
                    design/ (tone.ts, tokens.ts), money.ts, dates.ts, accounts.ts, categories.ts,
                    documents.ts, decisions.ts, deep-equal.ts, features.ts, periods.ts,
                    setup-progress.ts, routes.ts, navigation.ts, query-client.ts, cn.ts
src/app/dev/screens/{link,spending,confirm,confirm/manual,decisions,why,why/fallback}  a screen on
                    the sample data, no API (development only)
src/test/           setup.ts (jest-dom, MSW lifecycle, db reset), render.tsx, fake-xhr.ts,
                    fixtures/sample.ts (the Acme / J. Rivera dataset), fixtures/documents.ts (the
                    Acme pay stub as the API proposes it), fixtures/decisions.ts (profile, 401(k)
                    decision, explanations, calendar event), fixtures/k401-results.json (calculator
                    results made by api/calc, with make-k401-results.py), fixtures/cashflow.ts (the
                    sample period's cash flow, spending summary and recurring charges), msw/db.ts
                    (in-memory API state), msw/handlers.ts (every route, stateful),
                    msw/spending-handlers.ts (cash flow, summary, recurring; `spendingDb`)
e2e/                Playwright specs (smoke, auth.setup, auth, link, confirm, spending, decisions,
                    import), support/auth.ts, support/api.ts, fixtures/ (synthetic
                    acme-paystub.pdf and the script that makes it, bank-export.csv), baselines
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
| `Notice`                                        | `.notice` and inline result rows                  | `tone` blue, confirmed, warning; `compact`                                                                                                                                                                                          |
| `Swatch`                                        | `.sw`                                             | token `color` or `dashed` (a $0 node)                                                                                                                                                                                               |
| `ListRows`                                      | `.list`                                           | hairline-separated rows                                                                                                                                                                                                             |
| `DropZone`                                      | `.drop`                                           | a real file input, keyboard operable; filters by `accept` (drops too)                                                                                                                                                               |
| `Money`, `Num`                                  | `.num`                                            | format only: cents in, tabular numerals, `decimals` 0 or 2, `signed`, `tone`                                                                                                                                                        |

Chrome (`components/chrome`): `Wordmark`, `Header` (`chips`, `account` slot, `minimal`),
`HeaderAccount` (server: "Sample data" chip and `UserMenu` from the Supabase user), `UserMenu` (the
user chip as a disclosure button with "Sign out"), `NavStep`, `SideNav`
(`current`, `done` from `lib/setup-progress.ts`, `hrefs` for id-bound screens; wraps into a chip
row under 780px), `AppSideNav` (current item from the URL), `Shell` (header, nav column
`1 1 200px` up to 240px, main `999 1 560px`, skip link), `PageTitle` (`title`, `lead`, `aside`,
`eyebrow`), `StepFooter` (`back`, `next` with `primary`, `disabled` and `loading`; a disabled
next is a real disabled button, never a dead link).

## Data layer

- **Hooks** live in `src/lib/api/hooks/` (one file per area, re-exported from `hooks/index.ts`);
  screens import them from `@/lib/api/hooks`. Reads use `$api.useQuery`; paginated reads and
  mutations use TanStack directly over `fetchClient`, through `unwrap()`, so every hook's `error`
  is the API's `{ error: { code, message } }` body. Turn errors into sentences with
  `apiErrorMessage(error, fallback)` (`lib/api/errors.ts`), never by printing the object.
- **Keys** (`lib/api/keys.ts`): `$api` caches under `[method, path, init?]`, so `['get', path]` is a
  prefix of every read of a route. Invalidate through the helpers there (`invalidateAccounts`,
  `invalidateSpending`, `invalidateLinkedData`, `invalidateRecurring`, `invalidateForJob`), not
  with keys spelled at call sites. `useTransactions` is an infinite query under
  `queryKeys.transactionPages(filters)`; the trailing `'pages'` keeps its `InfiniteData` apart
  from plain reads under the same prefix.
  Documents: `invalidateDocuments` after an upload or extraction, `invalidateAfterConfirm`
  (documents and pay stubs) after a confirm. Decisions: `invalidateDecisions` (the list and every
  `GET /decisions/{id}`) and `invalidateAfterDecision` (also calendar, plan and goals) after a save.
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
- **Explanations**: `useExplanation(decisionId)` reads `GET /decisions/{id}/explanation` (a 404
  means none yet); `useExplain()` posts `{ decisionId, force }` to `POST /explain` and writes the
  row it returns into that cache. `POST /explain` answers only once the explanation is final
  (verified or fallback), so there is nothing to poll; `force` makes a new attempt after a
  fallback. A 503 `llm_unavailable` means the API has no model configured.
- **Optimistic writes** cancel the affected reads, patch every cached copy (`setQueriesData` over
  the prefix, paged or not), keep a snapshot for rollback in `onError`, and invalidate in
  `onSettled`. Mirror what the server will write: `useFixCategory` also relabels the merchant's
  other rows as `rule` and sets `confidence: null`, as the API does. Destructive writes (unlink)
  are not optimistic: the rows leave when the server says they are gone.
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
- **Uploads** (`lib/api/upload.ts`): `POST /docs` and `POST /accounts/import` (`importCsv`,
  wrapped by `useImportCsv`) go over XMLHttpRequest, because fetch cannot report upload progress.
  They share `sessionTokens` with the fetch middleware (one refresh and one resend on a 401), and
  fail with `UploadError` (`status`, `code`, `retryAfterSeconds`; `error` reads like any API
  error). `useUploadDocument` wraps the document upload; the Link documents card then calls
  `useExtractDocument` and follows the job with `useJob`. A CSV import refused with 422
  `csv_invalid` carries its row errors: `csvProblems(error)` reads `{ errors, total }` (the first
  50 and how many in all); the Link screen's `CsvImport` lists them, offers Try again on 409
  `import_conflict`, and follows the two job ids the import returns. `lib/documents.ts` maps a
  document's status to its badge and reason text; `isReviewable`/`newestReviewable` pick what
  Confirm opens.
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
- Debounces: measure them on the fake clock instead of asserting "nothing yet at 149 ms", which
  races `shouldAdvanceTime`. Record `Date.now()` when the input stops and when the request starts
  (`request:start`), and assert the difference is at least the debounce. Set inputs with
  `fireEvent.change` so typing does not spread over the window being measured.

## Confirm screen

`/setup/confirm` opens the newest pay stub waiting for review; `/setup/confirm/[documentId]`
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

## Decisions screen

`/setup/decisions` (`DecisionsScreen`) shows one card per calculator in the mockup's order
(emergency fund, 401(k), health plan, W-4) with an "n of 4 saved" badge. Only the 401(k) card is
built; a calculator off in `features.calculators` is a muted "After alpha" placeholder, and one
that is on but not built says "Coming in a later milestone."

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
   `SCREENS` in `e2e/smoke.spec.ts` with `sample: true` (frozen clock, Plaid's script stubbed). An
   end-to-end spec against the real API goes in an `authenticated-*` project (below).

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
- **Supabase project settings**: add `http://localhost:3000/auth/callback` and each deployed
  `https://<host>/auth/callback` to Auth > URL Configuration > Redirect URLs, or email links fall
  back to the Site URL.

### End-to-end auth tests

`e2e/auth.setup.ts` signs in through the form and saves the session to `e2e/.auth/user.json`
(git-ignored) for the `authenticated` project, which runs `e2e/auth.spec.ts`. Set these in
`web/.env.local` or the environment:

| Variable                                                           | Needed for                                                                                                                                                                                                   |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | the signed-out tests (redirect with `next`, wrong-password notice)                                                                                                                                           |
| `E2E_USER_EMAIL`, `E2E_USER_PASSWORD`                              | the signed-in tests (sign in, return to `next`, sign out, saved session)                                                                                                                                     |
| `NEXT_PUBLIC_E2E_USER_EMAIL`                                       | optional; defaults to `E2E_USER_EMAIL` in e2e runs; shows the "Sample data" chip                                                                                                                             |
| `E2E_API_URL`                                                      | `link.spec.ts`, `confirm.spec.ts`, `spending.spec.ts` and `decisions.spec.ts`: a running non-production API with Plaid sandbox credentials and a worker; the web server's `NEXT_PUBLIC_API_URL` points at it |
| Variable                                                           | Needed for                                                                                                                                                                                                   |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------    |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | the signed-out tests (redirect with `next`, wrong-password notice)                                                                                                                                           |
| `E2E_USER_EMAIL`, `E2E_USER_PASSWORD`                              | the signed-in tests (sign in, return to `next`, sign out, saved session)                                                                                                                                     |
| `NEXT_PUBLIC_E2E_USER_EMAIL`                                       | optional; defaults to `E2E_USER_EMAIL` in e2e runs; shows the "Sample data" chip                                                                                                                             |
| `E2E_API_URL`                                                      | `link.spec.ts`, `confirm.spec.ts`, `spending.spec.ts` and `import.spec.ts`: a running non-production API with Plaid sandbox credentials and a worker; the web server's `NEXT_PUBLIC_API_URL` points at it    |

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
accepts verified, fallback, or "not available" when the API has no model. Decisions cannot be
deleted, so it reads the current version instead of assuming v1. Never use a real document as a
fixture.

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
- Plaid Link's script loads through `lib/plaid-script.ts`, once per page, and `usePlaidLink` is
  mounted only after it has run. Letting react-plaid-link add it runs it twice under Strict Mode.
