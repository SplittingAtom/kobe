# KOBE-554: Catalyst look: floating shell columns with gaps (rail, conversation, artifact column, console)

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (PR #467)
- **Branch / worktree:** `kobe-554-floating-columns` in `../Kobe-wt554`
- **Depends on:** KOBE-550 (`kobe-panel` glow, `--kobe-page-ambient`)

## Plan

Catalyst's query tool (`ui/src/components/query/query-tab.tsx`: `flex gap-4`, side panels
`border rounded-lg bg-card`) as the shell in every preset:

- Chat (`components/shell/shell.module.css`, `shell-grid.tsx`): `.grid` gets a 16 px padding
  (`--kobe-shell-gutter`) and a 16 px `column-gap` (`--kobe-shell-gap`); the three regions are cards
  (`background: var(--card)`, `1px solid var(--border)`, `--kobe-radius-lg`) with class `kobe-panel`.
  The rail's room and the artifact column's default width and floors subtract the gaps.
- Rail (`rail.module.css`): its own edge borders went; background `--card`. From 768 to 1100 px
  the drawer is a card inset by the gutter (the grid holds it); under 768 px `.app` holds it, so it
  stays full height at the window's edge as before. The resize handle sits in the middle of the
  gap, as tall as the cards; its hit area is the whole gap (24 px coarse), all from the variables
  (`--kobe-handle-width`, `--kobe-shell-gap`). Positioned, the handle's `100%` is the grid's padding
  box, so it repeats the rail's clamp less both gutters (`--kobe-rail-handle-track`).
- Artifact column: the 768–820 sheet is a card inside the gutters (anchor fallback = gutter),
  without `kobe-panel` (it keeps the drawer shadow; no scrim there); the splitter's floor is
  `min(360, room)` like `layoutAt`, so 820–871 px no longer snaps to 360; the
  aside and the thread's root/composer strip paint `bg-card` instead of `bg-background` so the card
  colour reaches the rounded edge.
- Console (`components/ui/console/layout.tsx`): `gap-4 p-4`; the sidebar and the page are each
  wrapped in a card (`kobe-panel rounded-lg border border-console-border bg-card`,
  `data-console-region="nav" | "content"`); `SideNav` lost its own edge borders and panel colour.
- `lib/shell/layout.ts`: `SHELL_SPACING_PX` and `layoutAt` count the gutters and gaps (the CSS
  arithmetic mirror); `rail-resize.tsx` measures the columns' own widths (rail + `spaceRightOfRail`),
  so gutters and gaps never count as room.
- Forced colours: a hovered `kobe-panel` takes `border-color: Highlight` (both global sheets), since
  the halo is dropped there; borders stay visible because they are real borders.
- One halo at a time: the glow rule is `.kobe-panel:hover:not(:has(.kobe-panel:hover))` in both
  roots, so a column around a hovered card keeps its resting look (review round 1).

## Decisions

- **820–871 px with an artifact column:** 2 gutters + rail 48 + 2 gaps leave less than both floors
  (360 + 400). The bands stay (768/820/1100 are behaviour, tested in browser specs); the
  conversation keeps its 400 px and the artifact column yields, down to 308 px at 820
  (`minmax(min(360px, room), …)`). From 872 px both floors hold as before. Alternative for Chris:
  raise the medium band to 872 px.
- Console card border is `border-console-border` (the console's own border token, as the console
  `Card` primitive), not the chat's `--border`; background `bg-card` as asked.
- Gap and gutter are plain layout values, not theme tokens (docs/theming.md §9, new card/gap bullet).
- The artifact column's own resize handle stays inside its card's 6 px edge strip (unchanged); only
  the rail's handle moved into the gap, as the ticket asks.
- The chat compiled-CSS snapshot (`app/__snapshots__/chat-global.own.css.snap`) was updated **on
  purpose**: the new forced-colours hover rule and the `:not(:has(.kobe-panel:hover))` hover selector.
- `layout-preferences.test.tsx` "doesn't save a width chosen where both floors don't fit": the
  width it shows is now the room (260 px), not 360 px; still nothing is saved.
- The 16 px lives in `SHELL_SPACING_PX`; a layout-contract test asserts the CSS variables and the
  console's `gap-4 p-4` agree with it.

## Open questions (for Chris or the coordinator)

- 820–871 px: artifact column below 360 px acceptable, or move the medium band to 872 px?
- Screenshot baselines: none are committed (`console-shots/` and spec attachments are gitignored
  deployment data), so nothing was re-taken here. After deploy, re-take the consoles baseline
  (`npx playwright test consoles --update-snapshots=all`): every console page shifted by the 16 px
  gutter and gained card edges; `chat-layout`/`rail-resize` attachments show the chat cards.
  Never run appearance.spec.ts on gate1.

## Evidence (acceptance criteria → test or command output)

- **ac-1** `components/shell/shell.test.tsx` ("grid": each region has `kobe-panel`);
  `components/shell/layout-contract.test.tsx` ("floating cards (KOBE-554)": gutter, gap, card
  colour/border/radius, scroll containment unchanged); `lib/shell/layout.test.ts` (column widths
  with gutters and gaps); chat CSS snapshot updated.
- **ac-2** `components/ui/console/layout.test.tsx` (sidebar and page cards, `gap-4 p-4`, no
  sidebar edge borders); console CSS guard scoping still green.
- **ac-3** `rail-resize.test.tsx`, `breakpoints.test.tsx` unchanged and green; layout-contract
  evaluates the handle's position for clamped rails (1,100/1,280/1,600 px) and checks the drawer and
  sheet; `artifact-tabs.test.tsx` covers the 820–871 px splitter floor.
- **ac-4** `app/theme-css.test.ts` (glow rule, reduced motion, forced-colours hover border; the
  shell grid and console layout carry `kobe-panel`).
- **ac-5** `docs/theming.md` §7 (surfaces) and §9 (card/gap rule); this ledger.
- **ac-6** `TMPDIR=$HOME/tmp pnpm verify` green before push. First CI run: gate5-a failed on
  `e2e/browser/tests/rail-resize.spec.ts` (aria-valuemax 520 beside a file tab); with the gutters
  and gaps the bound is 1,280 − 64 − 760 = 456, so the spec was updated (typechecked).
