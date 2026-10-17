# KOBE-306: Team Inventory agent table cramped; inventory browser spec counts Next's route announcer

- **Status:** done on branch, awaiting review (group 2, not pushed)
- **Branch / worktree:** `group-2-quality` in `../Kobe-g2` (includes G7's console primitives)
- **Follows:** KOBE-291 (inventory page), KOBE-294 (console primitives)

## What changed

- **Agent inventory** (`components/admin/team/agent-inventory.tsx`): 10 columns instead of 11 and
  nothing on a row wider than its data.
  - Dates compact: `DateTime compact` (`components/admin/parts.tsx`, `compactDateTime`) shows
    "Oct 17, 05:26" (24-hour, year only when not this year) on one line (`whitespace-nowrap`);
    the tooltip (`title`) has the full date, time with seconds and zone. Used for Last run and
    the Orbit score date.
  - Tokens compact (`formatTokens`, as the usage pages: "12.3M"), the exact count in the tooltip.
  - Scope folded under the owner ("Owner and scope": name, then a muted "Team"/"Personal";
    gallery agents just "Gallery"). "Versions" header is "Version" (it shows the current one).
  - Actions in a row ⋯ menu: `RowMenu` named "Actions for <agent>", items Export to Orbit
    (published and exportable only) and Suspend (danger colour) / Reactivate. The suspend confirm
    returns focus to the ⋯ button. The ⋯ button spins while that row's export runs; export
    refusals show in the table's `MutationStatus`.
  - `downloadOrbitExport()` split out of `OrbitExportButton` (agent builder keeps the button).
- **New primitive `RowMenu`** (`components/ui/console/row-menu.tsx`, in the barrel): Radix
  DropdownMenu on the console palette, ghost `sm` ⋯ button with `aria-label`, portalled into the
  console root (`consolePortalContainer()`, controlled like ActionMenu so the root is found), runs
  the chosen item after the menu closes with the re-focused button as the confirm trigger.
  Renders nothing without items. Why not KOBE-292's `ActionMenu`: it is bound to the chat command
  registry (`CommandId`, `menuItems`), chat tokens and the chat portal (the S8 portal guard
  forbids `chatPortalContainer()` in console code).
- **Table primitive** (`components/ui/console/table.tsx`), for every console table:
  - The scroll box is `relative`. Before, the `sr-only` "Actions" header text (absolutely
    positioned) escaped the unpositioned scroll box whenever a table overflowed, so the **page**
    scrolled sideways: inventory at 390 px had a 1045 px wide document; now 390.
  - While a table is wider than its box, a fade marks each edge with more columns past it
    (`data-edge="start|end"`, `aria-hidden`, updates on scroll and resize, RTL-aware), so a cut
    column reads as "scroll for more", not clipped. Nothing changes for tables that fit. No
    option needed: horizontal scrolling (and the named, focusable region) was already built in.
- **Browser specs** (`e2e/browser`): `tests/support/alerts.ts` `pageAlerts(scope)` = alerts with
  text, excluding `#__next-route-announcer__` (empty after a full load, the page title after a
  client navigation). `console-sections.spec.ts` uses it. The other `getByRole("alert")` uses
  (`compact-now`, `files-tree`) are scoped to a dialog or region and assert text, so the announcer
  can't match; `row-menus` uses `alertdialog`. New inventory spec: at 1280 px the agent table and
  page don't scroll, the ⋯ button is fully in view, no inline Export/Suspend buttons, each date has
  a tooltip with a year and fits one line; at 390 px the page doesn't scroll and an overflowing
  table is the named region.

## Measurements (static render of the built CSS in Chromium 1.55, compute2)

- Inventory with long names (4 agents, 8-digit tokens): table min width 1073 px before → 904 px
  after, in the 960 px content box at 1280 px (nav 15rem, main `max-w-5xl`). Light, dark, 1024
  and 390 px shot: nothing cut off; at 1024/390 it scrolls in its box with the end fade.
- **Other console tables** (every table state the web tests render: 189 states, 38 test files,
  wrapped in the console frame): **none overflows at 1280 px**; their action cells already wrap
  (`flex flex-wrap`) and long codes/URLs `break-all`. At 390 px these scroll inside their region
  (now without widening the page, with the edge fade): Site audit events, users, invitations,
  gallery, connectors, model providers and catalog, break-glass requests, legal holds, audit
  forwarding, skill blocklist, teams, policy rules; Team members, invitations, agents, schedules,
  egress domains/requests, budgets, connectors, break-glass history, audit events, usage
  breakdowns, eval scenarios, published versions; My agents, My schedules; Projects. No fix
  needed beyond the primitive's.

## Tests and evidence

- `components/ui/console/row-menu.test.tsx` (4): named menu button, keyboard, items, danger
  colour, console-root portal, Escape returns focus; the item runs after close with the focused
  button as trigger; disabled item doesn't run; busy and empty.
- `components/ui/console/display.test.tsx` (+3): edge fades follow the scroll position, none when
  the table fits, scroll box positioned.
- `components/admin/team-inventory-page.test.tsx` (+4 for ac-3, existing ones moved to the menu):
  compact dates (no year or seconds, one line, full tooltip), compact tokens, one named ⋯ button
  per row and no inline action buttons, the 10 headers and the owner/scope cell,
  `compactDateTime` year rule; suspend through the menu returns focus to the ⋯ button.
- Checks (2026-10-17): `format:check`, `lint`, web `typecheck`, web tests 172 files / 1728 tests (1729 after the review fixes)
  green, `next build` ok, e2e `tsc -p e2e/browser` ok. No new dependencies, no server change.

## Review fixes (coordinator review, 2026-10-17)

- **Focus after Export** (M1): the ⋯ button is disabled while its row exports, which drops focus.
  `RowMenu` now hands the button to `focusWhenEnabled` (KOBE-296 S4) after running an item, so
  focus returns to it once it is enabled again (unless the person moved on; 15 s at most). The S4
  helpers moved from `confirm-dialog.tsx` to `components/ui/console/focus-return.ts`, shared.
  Test: `row-menu.test.tsx` (fails without the fix).
- **Full values for assistive tech** (M2): compact dates render the compact text `aria-hidden`
  plus the full date, time and zone as visually hidden text; tokens likewise ("12.3M" shown,
  "12,345,678 tokens" read). The `title` stays as a mouse hint. No focusable tooltip: it would
  add two tab stops per row; sighted keyboard users see the compact value, screen readers get the
  full one.
- **Spec independent of data** (L6): the inventory browser test asserts layout at 1280 and 390 px
  (page never scrolls sideways; the table fits or is its named scroll region; every ⋯ button can be
  scrolled fully into view; dates one line with hidden full text; no inline action buttons), not
  that the team's rows fit.
- L4/L5: the export resets its busy row in `finally`; a menu choice left from an earlier opening
  is cleared when the menu opens again. L3 (export refusal shown above the table, without the
  agent's name) left as is: it is the table's single status line, as for Suspend.

## Acceptance criteria

- [x] ac-1 Fits at 1280 px; compact dates with full tooltip; ⋯ menu with accessible names;
      scrolls in its region on narrow widths (page no longer scrolls); light, dark, phone checked.
- [x] ac-2 `console-sections.spec.ts` ignores the route announcer (`pageAlerts`); other specs
      checked (scoped, unaffected).
- [x] ac-3 Component tests for the compact table. **Gate1 run after deploy** still to do:
      `npx playwright test console-sections consoles` (new inventory screenshots need
      `--update-snapshots` since the table changed).
