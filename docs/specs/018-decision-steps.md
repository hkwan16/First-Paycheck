# 018: Decisions as four steps

Status: Implemented, M10 (web only). Rule 6a, a footer link landing at the top (issue 172): Implemented, Hardening (web only). Rules 11-17, the side nav on a phone (issue 155): implemented in Hardening, removed November 1, 2026, when First Paycheck became desktop only. Rules 5a and 5b (saving in words, one primary action, issue 206) and rule 5's lead (issue 209) changed November 1, 2026. Rules 5c and 5d (a decision that needs review, and the salary question, issues 221 and 222) added and rule 8 changed November 9, 2026; they read new API fields (spec 005 rule 24c, spec 007 rules 19a-19e).

## Goal

The Decisions screen put four calculators on one page, two by two, with every control of every card in view at once; people found it cluttered. This spec splits it into four steps, one page per calculator, in the mockup's order (emergency fund, 401(k), health plan, W-4), and gives the side nav four sub-items under "Decisions", so a person works through one decision at a time and can still see, from anywhere, which ones are saved. Nothing about a calculator changes: each card moves to its own page as it is. No API route or schema changes; every number still comes from the API. Code: `web/src/lib/decision-steps.ts` (order, slugs, neighbors), the route builders in `web/src/lib/routes.ts`, `web/src/components/screens/decisions/DecisionStepScreen.tsx`, `web/src/app/(app)/setup/decisions/<slug>/page.tsx`, `web/src/components/chrome/SideNav.tsx` (with `AppSideNav.tsx`), `web/src/lib/setup-progress.ts` and the redirect in `web/src/proxy.ts`.

## Inputs

| Input | Type | Meaning |
|---|---|---|
| The step | one of the four calculators (`CalculatorId`: `emergency_fund`, `401k_match`, `health_plan`, `w4`) | Which page, from its route. |
| Live calculators | list of `CalculatorId` (`features.calculators`, from `NEXT_PUBLIC_FEATURES`) | Calculators on in this build; the rest are "After alpha". |
| `GET /decisions` | `DecisionList` (spec 007) | Which calculators have a saved decision; read already by the badge and by `useSetupProgress`. No new read. |

## Outputs

| Route | Page title (tab) | Heading (h1) | Card |
|---|---|---|---|
| `/setup/decisions/emergency-fund` | Emergency fund | How much to keep for emergencies | `EmergencyFundCard` |
| `/setup/decisions/401k` | 401(k) match | How much to put in your 401(k) | `Match401kCard` |
| `/setup/decisions/health-plan` | Health plan | Which health plan to choose | `HealthPlanCard` |
| `/setup/decisions/w4` | W-4 | What to put on your W-4 | `W4Card` |

`/setup/decisions` has no page of its own: the proxy answers it with a 307 to the entry step (rule 3).

The side nav's "Decisions" item gets a nested list of four sub-items, labeled "Emergency fund", "401(k) match", "Health plan" and "W-4", each linking to its step.

## Rules

### Routes

1. **One route per calculator**, with the short, stable slugs in the table above. A slug is part of the URL people bookmark and other screens link to: renaming one is a breaking change. The order is fixed: emergency fund, 401(k), health plan, W-4 (the mockup's order). The W-4 reads the saved 401(k) and health plan decisions (spec 014), so it comes last.
2. **Each step page renders exactly one card**, the calculator's, inside its `CardErrorBoundary`, or the muted "After alpha" `PlaceholderCard` when the calculator is not live. The title row, the card and the footer share one column at most `48rem` (`max-w-3xl`) wide, so a single card never stretches across a wide screen.
3. **`/setup/decisions` redirects in the proxy** (307, temporary because the target depends on the build's flags) to the entry step: the first live calculator in step order, or the first step when none is live. It redirects after the sign-in check, so a signed-out request still goes to `/sign-in?next=/setup/decisions` and comes back through the redirect. The redirect is in the proxy, not in a page, because `next dev` reports a redirect thrown while rendering (web/CLAUDE.md, Auth).
4. **Every link into Decisions goes to a step route**, built in `lib/routes.ts`, never with a fragment:
   - **One calculator's step** (`decisionStepRoute(calculatorId)`, `decisionKindRoute(calculatorKind)`), whether or not it is live: the Plan's "Still to decide", the Plan calendar's event badges, a check-in finding's "Affects", the W-4 card's "Save your 401(k) decision" and "Choose your health plan", Why's "Re-run the calculator" (the decision's own calculator), and the Spending diagram's "See what a 401(k) match is worth".
   - **The health plan step when it is live, else the entry step** (`decisionRouteFor('health_plan')`): a benefits summary's way on, because its plans are compared there. That is Confirm's "Continue to decisions" for a confirmed summary, its "Go to decisions" for one nothing could be read from, and the Link documents' "Go to decisions" for that one. In the alpha the health plan is a placeholder, so these go to the 401(k), whose plan details take the match.
   - **The entry step** (`firstDecisionRoute()`, rule 3's target): Spending's "Use these numbers in decisions", the Why index's and the Plan's "Go to decisions" when nothing is saved, and the side nav's "Decisions".
   - **The last live step** (`lastDecisionRoute()`): the Plan's "Back to decisions", the step whose next leads to the Plan.

### Each step page

5. **Title**: an eyebrow row with "Decision n of 4" (the step's place in the order, counting every calculator, live or not) and, once `GET /decisions` has answered, the "n of 4 saved" badge (the number of calculators in `GET /decisions`, `items.length`, of the 4); the h1 from the table; and, for a live calculator only, the lead "Try a few choices and watch the numbers change. Save the one you want, and it goes into your plan." (issue 209: the lead before it described the system, "Every number comes from the calculator, not the AI. Saving keeps a versioned record") A placeholder has no controls, so its card says what it will decide instead. The tab title is the table's page title.
5a. **Saving, in words** (issue 206). Each card's save button and badge say what will happen and what is saved, never a version number (versions belong to the Why pages and the Plan): with nothing saved, the button is "Save" and the badge "Not saved"; once what is on screen differs from what is saved, "Save changes" and "Changes not saved"; once it matches, a pressed "Saved" and "Saved {date}". The words come from one place, `lib/decisions.ts:decisionSaveState`. A what-if that only changes how the result is shown never counts as a change (the health plan's usage, spec 012 rule 18), and the badge never changes because a form opened in place of the result (spec 012 rule 18a).
5c. **Needs review** (issue 222). A current decision whose `review` (spec 007 rule 19b) is not empty is not "Changes not saved": nothing on screen was changed by the person. Its card's badge reads "Needs review" (the warning tone) whatever is on screen, its save button "Save again", and a notice at the top of the card, "What changed", says "Since you saved this on Oct 21, 2026:" and lists each reason's `text` of kind `changed`, then "The numbers here use what you have now. Check them and save again to update your plan." The words come from `decisionSaveState` (status `review`) and the API's texts; the client compares nothing to decide it. Once a version is saved from the inputs of now, the API reports no reasons and the card reads "Saved".
5d. **The salary question** (issue 221). While the profile's `salary_review` is set (spec 005 rule 24c), the 401(k), health plan and W-4 cards show one question in place of their calculator (`SalaryQuestion`, a group named "Which yearly salary should we use?"): "Your Oct 15, 2026 pay stub pays $2,708.33 twice a month, which comes to $64,999.92 a year. The salary in your plan details is $95,000.10.", that the 401(k), health plan and W-4 all use it and wait for the answer, and two buttons: "Use $64,999.92" (primary) and "Keep $95,000.10". Each saves the profile (`PUT /profile`) as rule 24c says, and the card then calculates. No card works out a number from the saved salary on the new schedule before the person answers. The emergency fund reads no salary and never asks.
5b. **One primary action** (issue 206). On a step, the card's save button is the one primary button while there is something to save; once saved it turns into the confirmed "Saved". The footer's next link is the default (secondary) button on every step, so Next never looks like the step's action and nothing suggests it saves. A form that opens in place of the result (plan details, the plan table) brings its own primary button, the only one while it is open.
6. **Footer**: Back goes to the previous live step, or to `/setup/spending` before the first live one; next goes to the next live step, or to `/plan` after the last live one. Steps that are not live are skipped, so the alpha (`calculators=401k_match`) walks Spending, 401(k), Plan as before. Labels: "Back to {name}" and "Next: {name}", where the names are "emergency fund", "401(k) match", "health plan" and "W-4"; Back to Spending is "Back"; next to the Plan is "See your plan" (today's label). A step that is not live has the same neighbors as if it were: the live steps around its place in the order.
6a. **A footer link lands at the top of the next page** (issue 172), at every width, for every `StepFooter` link (the setup screens' too). Next's App Router scrolls only when the changed segment's top edge is out of view. Following a footer link at the bottom of a long step, the browser first clamps the scroll offset to the new page, which is still short while its cards load; the new page's top edge is then in view, so Next leaves it part way down the page, with the top of the page under the sticky header. A step change is a new page and starts at the top: the link turns Next's scroll off and asks (`onNavigate`, `lib/land-at-top.ts`), and the new page's `HydrationMarker`, which every page renders, scrolls to the top as its content commits, before it is painted. Back and forward, reloads and every other link keep the browser's and Next's scrolling. A `scroll-padding-top` the size of the header was weighed and set aside: Next would then scroll this case, but a clamp that leaves the page's top edge below the header would still land part way down. `e2e/decisions.spec.ts` follows a Next and a Back link from the bottom of a step in a 1280x650 window and checks the page is at 0. On desktop the clamp leaves the top edge in view only in a window about 625 to 675px tall, so the test also checks its own precondition: as the landing scrolls (`window.scrollTo`, wrapped by an init script), the new page was in the DOM, scrolled down, with its root's top edge in view, the state Next leaves alone. A window that stops showing it fails the test and says to rescan the height; the sample screens cannot show it, since their footers lead out of the sample layout and the whole page remounts.

### Side nav

7. **Sub-items**: "Decisions" holds a nested list of the four steps in step order, indented under it. Each is a link at least 44px tall with a small marker (a dot, or a check once done) and its label. The current step's link has `aria-current="page"`; nothing else on a step page does (the "Decisions" link is the section, not the page).
8. **Done marks**: a sub-item is done when its calculator is live and its saved decision needs no review (`setupProgress`, from `settledDecisionCalculators`, the calculators of `GET /decisions` whose current decision's `review` is empty, and `liveCalculators`; no new API call). A decision that needs review (rule 5c) is saved but not done: before issue 222 the nav ticked a step whose saved numbers were figured on a pay schedule the person no longer has. "Decisions" itself is done when every live calculator is saved (unchanged). A done item says ", done" to screen readers, like the steps.
9. **Not live**: a calculator off in `features.calculators` is still a sub-item, still a link to its step (whose page shows the placeholder), drawn muted with a visible "After alpha" after its label; its accessible name ends ", After alpha". It is never marked done.
10. **"Decisions" links to the entry step** (rule 3's target), not to `/setup/decisions`, so following it costs no redirect.

### The side nav on a phone (issue 155): removed

11-17. *Removed November 1, 2026.* First Paycheck targets the desktop website only, so the side nav is the same list at every width and there is no phone control. Under 780px the nav column still stacks above the page (`Shell`), with the whole list. The numbers are kept, not reused, so older references to them still resolve.

## Hand-worked examples

### Steps (`web/src/lib/decision-steps.test.ts`, `web/src/lib/routes.test.ts`)

| Test | Live calculators | Step | Back | Next |
|---|---|---|---|---|
| `every live: the first step goes back to Spending` | all four | emergency fund | `/setup/spending` "Back" | `/setup/decisions/401k` "Next: 401(k) match" |
| `every live: a middle step` | all four | health plan | `/setup/decisions/401k` "Back to 401(k) match" | `/setup/decisions/w4` "Next: W-4" |
| `every live: the last step goes on to the plan` | all four | W-4 | `/setup/decisions/health-plan` "Back to health plan" | `/plan` "See your plan" |
| `the alpha: the 401(k) is the only step` | `401k_match` | 401(k) | `/setup/spending` "Back" | `/plan` "See your plan" |
| `the alpha: a placeholder step has the live steps around it` | `401k_match` | health plan | `/setup/decisions/401k` "Back to 401(k) match" | `/plan` "See your plan" |
| `skips a step in the middle that is not live` | `emergency_fund`, `w4` | emergency fund | `/setup/spending` "Back" | `/setup/decisions/w4` "Next: W-4" |

| Test | Live calculators | Entry (`firstDecisionRoute`) | Last (`lastDecisionRoute`) |
|---|---|---|---|
| `every live` | all four | `/setup/decisions/emergency-fund` | `/setup/decisions/w4` |
| `the alpha` | `401k_match` | `/setup/decisions/401k` | `/setup/decisions/401k` |
| `none live` | none | `/setup/decisions/emergency-fund` | `/setup/decisions/w4` |

### Saving (`web/src/lib/decisions.test.ts`, rules 5a and 5b)

| Test | Saved | On screen | Button | Badge |
|---|---|---|---|---|
| `nothing saved yet` | none | any inputs | Save (primary) | Not saved |
| `the saved inputs` | v2, saved Oct 21 | v2's inputs, in another key order | Saved (pressed, confirmed) | Saved Oct 21 |
| `other inputs` | v2 | v2's inputs at another contribution | Save changes (primary) | Changes not saved |
| `ignores what describes, not decides` | a health plan v1 at medium use | v1's inputs at high use, `expected_usage` ignored | Saved | Saved Oct 21 |
| `a decision that needs review` | v2 with a `review` reason | any inputs, v2's own included | Save again (primary) | Needs review |

No row shows a version: v2 saved on screen reads "Saved", never "Saved as v2", and the next save "Save changes", never "Save as v3". Every step's footer next link is the default variant (`step-footer.test.ts`), and `DecisionStepScreen.test.tsx` checks that a step with something to save has one primary button.

### Done marks (`web/src/lib/setup-progress.test.ts`)

| Test | Live | Saved | Sub-items done | Decisions done |
|---|---|---|---|---|
| `marks each saved live calculator's step` | all four | `401k_match`, `w4` | 401(k), W-4 | no |
| `never marks a step that is not live` | `401k_match` | `w4` | none | no |
| `all live saved` | `401k_match` | `401k_match` | 401(k) | yes |
| `a decision that needs review is not done` | all four | all four, the health plan and W-4 needing review | emergency fund, 401(k) | no |

### Redirect (`web/src/proxy.test.ts`)

| Test | Request | Response |
|---|---|---|
| `sends /setup/decisions to the first live step` | signed in, `/setup/decisions` | 307 to `/setup/decisions/<first live slug>` |
| `signs in first` | signed out, `/setup/decisions` | 307 to `/sign-in?next=/setup/decisions` |
| `leaves a step alone` | signed in, `/setup/decisions/w4` | passes through |

`web/e2e/schedule-change.spec.ts` runs rules 5c, 5d and 8 end to end (issues 221 and 222): stub-01 confirmed, three decisions saved on it, then the Acme stub confirmed through Confirm; the health plan step reads "Needs review" with the schedule change, the nav ticks none of the three, the 401(k) and W-4 ask which salary to use, and after "Use $64,999.92" and "Save again" on each, all three are done and the Plan reads "3 of 4 decisions saved".

## Edge cases

- An unknown slug (`/setup/decisions/roth`) is Next's 404; it is still behind the sign-in guard (`/setup` prefix).
- An old link with a fragment (`/setup/decisions#k401-title`): the fragment never reaches the server, so it redirects to the entry step and the browser keeps the fragment, which matches no element there. The app no longer makes such links (rule 4).
- No calculator live: the entry is the first step and every step is a placeholder; Back goes to Spending and next to the Plan on every step.
- A saved decision for a calculator that is not live: its sub-item is muted and not done, and its page shows the placeholder; the "n of 4 saved" badge still counts it, as `GET /decisions` lists it (unchanged from the one-page screen).
- A card that throws while rendering: its boundary shows the card's frame and notice, and the page's title, badge and footer still work, so the person can move on to the next step.
- `GET /decisions` fails or is loading: no badge and no done marks, as before.

## Out of scope

- An overview page at `/setup/decisions` listing the four with their saved state. The side nav already shows all four with their done marks on every screen, each step shows "n of 4 saved", and the Plan lists every saved decision with its figures; an overview would be one more page between the person and the first decision, with nothing to decide on it.
- Sending a person to their first unsaved step. The proxy has no session data to know it, and reading it in the page would mean a client redirect after render. The nav's done marks show which ones are left.
- Changing any calculator card, the API, or the mockup, beyond rules 5a and 5b.
- Phone widths: the product targets the desktop website only (since November 1, 2026).
