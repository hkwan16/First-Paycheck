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
| `pnpm e2e`                              | Playwright smoke: axe and screenshots on desktop 1280x820 and phone 390x844 |
| `pnpm exec playwright install chromium` | One-time browser install for `pnpm e2e`                                     |
| `pnpm gen:api`                          | Regenerate `src/lib/api/schema.d.ts` from `../api/openapi.json`             |
| `pnpm check:api`                        | Regenerate and fail if the committed schema drifted (CI)                    |

`pnpm e2e` starts `next dev` on :3100 (`/dev/kit` is a 404 in production builds) with Supabase
env vars blanked and `NEXT_PUBLIC_FEATURES=e2e`. Screenshot baselines live in
`e2e/__screenshots__/` per platform: `*-darwin.png` for local macOS runs, `*-linux.png` for CI.
CI runs Playwright inside `mcr.microsoft.com/playwright:v1.64.1-noble`; regenerate Linux
baselines in that same image (mount `web/` read-only, copy it without `node_modules`, run
`pnpm install --frozen-lockfile && pnpm exec playwright test --update-snapshots`, copy the
`*-linux.png` files back). Update baselines only in their own commit, after looking at the diff.

## Layout

```
src/app/            routes. (auth)/sign-in; (app)/setup/{link,confirm/[documentId],spending,decisions},
                    (app)/why/[decisionId], (app)/plan, (app)/check-in/[checkInId]; dev/kit
src/proxy.ts        Next 16 proxy (formerly middleware): refreshes the Supabase session
src/components/ui/  design system (below)
src/components/chrome/  app frame (below)
src/components/screens/<screen>/  one 'use client' screen component per page
src/components/icons.tsx  the mockup's SVG glyphs, decorative, drawn in currentColor
src/lib/            api/ (schema.d.ts, client.ts), supabase/ (env, client, server, proxy),
                    design/ (tone.ts, tokens.ts), money.ts, dates.ts, features.ts,
                    setup-progress.ts, routes.ts, query-client.ts, cn.ts
src/test/           setup.ts (jest-dom, MSW lifecycle), render.tsx, msw/handlers.ts
e2e/                Playwright specs and screenshot baselines
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
| `Notice`                                        | `.notice` and inline result rows                  | `tone` blue, confirmed, warning; `compact`                                                                                                                                                                                          |
| `Swatch`                                        | `.sw`                                             | token `color` or `dashed` (a $0 node)                                                                                                                                                                                               |
| `ListRows`                                      | `.list`                                           | hairline-separated rows                                                                                                                                                                                                             |
| `DropZone`                                      | `.drop`                                           | a real file input, keyboard operable; filters by `accept` (drops too)                                                                                                                                                               |
| `Money`, `Num`                                  | `.num`                                            | format only: cents in, tabular numerals, `decimals` 0 or 2, `signed`, `tone`                                                                                                                                                        |

Chrome (`components/chrome`): `Wordmark`, `Header` (`chips`, `minimal`), `NavStep`, `SideNav`
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
6. Add the screen to the Playwright visual spec once it has real data fixtures.

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
