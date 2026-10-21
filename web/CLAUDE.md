# web/: First Paycheck frontend

Next.js 16 (App Router, typed routes, Cache Components) with React 19, Tailwind v4, TanStack Query
over a generated OpenAPI client, and Supabase Auth. The visual target is Mockup B
(`docs/mockup/*.dc.html`); `/dev/kit` shows every component next to it.

## Rules

- **No money math in the client.** Every number on screen comes from the API. Money arrives as
  integer cents and is only formatted (`lib/money.ts`, `<Money>`); never add, split, round for
  logic, or compare amounts here. Arithmetic belongs in `api/calc/`.
- **Tokens only.** Colors, radii, shadows, type sizes and durations are the `@theme` tokens in
  `src/app/globals.css`. No raw hex anywhere else in `src/` (only `globals.css` and
  `components/sankey/palette.ts`); `src/lib/design/tokens.test.ts` and ESLint both enforce it.
- **Color means something.** Components take a `Tone`, not a color (`lib/design/tone.ts`): a
  `Hue` (`blue | coral | teal | plum | neutral`) marks a kind of thing, a `Status`
  (`confirmed | warning | off`) marks a state. Green is reachable only as `confirmed`, amber as
  `warning`, red as `off`. ESLint rejects `bg-|text-|border-|fill-|stroke-|ring-` plus
  `green|amber|red` outside `components/ui/**`, `lib/design/**` and `sankey/palette.ts`.
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
`NEXT_PUBLIC_FEATURES=e2e`. `playwright.config.ts` loads `web/.env.local` (variables already in the
environment win), so local runs use your Supabase project; see "End-to-end auth tests" below.
Screenshot baselines live in `e2e/__screenshots__/` per platform: `*-darwin.png` for local macOS
runs, `*-linux.png` for CI.
CI runs Playwright inside `mcr.microsoft.com/playwright:v1.64.1-noble`; regenerate Linux
baselines in that same image (mount `web/` read-only, copy it without `node_modules`, run
`pnpm install --frozen-lockfile && pnpm exec playwright test --update-snapshots`, copy the
`*-linux.png` files back). Update baselines only in their own commit, after looking at the diff.

## Layout

```
src/app/            routes. (auth)/sign-in; (app)/setup/{link,confirm/[documentId],spending,decisions},
                    (app)/why/[decisionId], (app)/plan, (app)/check-in/[checkInId]; dev/kit
src/app/auth/callback/route.ts  exchanges the email-link code for a session
src/proxy.ts        Next 16 proxy (formerly middleware): refreshes the Supabase session and
                    forwards the requested path to the (app) guard
src/components/ui/  design system (below)
src/components/chrome/  app frame (below)
src/components/screens/<screen>/  one 'use client' screen component per page
src/components/icons.tsx  the mockup's SVG glyphs, decorative, drawn in currentColor
src/lib/            api/ (schema.d.ts, base-url.ts, auth-middleware.ts, client.ts, hooks.ts),
                    auth/ (next-path, validation, errors, account), supabase/ (env, client,
                    server, proxy), design/ (tone.ts, tokens.ts), money.ts, dates.ts,
                    features.ts, setup-progress.ts, routes.ts, navigation.ts,
                    query-client.ts, cn.ts
src/test/           setup.ts (jest-dom, MSW lifecycle), render.tsx, msw/handlers.ts
e2e/                Playwright specs (smoke, auth.setup, auth), support/auth.ts, baselines
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
| `StatTile`                                      | `.tile .k .v`, `.stat`                            | `label`, `value`, `sub`, `tone`, `size` md or sm                                                                                                                                                                                    |
| `IconTile`                                      | `.ico`, `.sev`                                    | `tone`, `label` (initials), `muted`                                                                                                                                                                                                 |
| `Bar`                                           | `.bar`, `.track`                                  | progressbar; `value` clamped 0-100; `tone` required; `height` 8 or 6                                                                                                                                                                |
| `KV`, `KVList`                                  | `.kv`                                             | a `<dl>`; `verified` adds the "=" mark; `spacing` compact, comfortable, panel; `rules`                                                                                                                                              |
| `Seg`                                           | `.seg`                                            | generic options; role group of `aria-pressed` buttons; one tab stop; arrows, Home, End                                                                                                                                              |
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
`eyebrow`), `StepFooter` (`back`, `next` with `primary` and `disabled`; a disabled next is a real
disabled button, never a dead link).

## Adding a screen

1. Write the spec's tests first: `src/components/screens/<screen>/<Screen>Screen.test.tsx`, with
   MSW handlers in `src/test/msw/handlers.ts` for every route it reads.
2. Build `<Screen>Screen.tsx` as a `'use client'` component from `ui` and `chrome` parts only.
   Read data with `$api.useQuery(...)` from `lib/api/client.ts`; render numbers with
   `<Money>`/`<Num>` exactly as the API returns them.
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
7. Add the screen to the Playwright visual spec once it has real data fixtures.

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
- **Guard**: `(app)/auth-gate.tsx` verifies the user with `getUser()` (deduped per render by React
  `cache`) and redirects to `/sign-in?next=<path>`; the path comes from the `x-first-paycheck-path`
  header the proxy sets, because layouts cannot read the URL. `/` sends a signed-in person to
  `/setup/link`.
- **Proxy**: `src/proxy.ts` refreshes the session with `getClaims()` on every request except build
  assets, image optimization, the favicon and paths with a file extension.
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

| Variable                                                           | Needed for                                                                       |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | the signed-out tests (redirect with `next`, wrong-password notice)               |
| `E2E_USER_EMAIL`, `E2E_USER_PASSWORD`                              | the signed-in tests (sign in, return to `next`, sign out, saved session)         |
| `NEXT_PUBLIC_E2E_USER_EMAIL`                                       | optional; defaults to `E2E_USER_EMAIL` in e2e runs; shows the "Sample data" chip |

Missing variables skip those tests with a message saying which to set. The e2e user must be a
confirmed user: the hosted project requires email confirmation, so create it in the Supabase
dashboard (Authentication > Users > Add user, "Auto Confirm User") with synthetic data only.
Tests that sign out sign in through the form first, so they never end the saved session the other
tests share.

## Feature flags

`NEXT_PUBLIC_FEATURES` is a comma-separated list, parsed by `lib/features.ts`:

| Flag                    | Effect                                                                                                                                                                                       |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `calculators=<id>+<id>` | Live calculators (`401k_match`, `emergency_fund`, `health_plan`, `w4`); the rest render as muted "After alpha" placeholders. Unset means all live. The alpha ships `calculators=401k_match`. |
| `sankey`                | Show the cash-flow Sankey on the Spending screen.                                                                                                                                            |
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
