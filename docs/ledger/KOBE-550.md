# KOBE-550: Catalyst look: panel hover glow in every theme and a Catalyst preset

- **Status:** in progress
- **Branch / worktree:** `kobe-550-catalyst-look` in `../Kobe-wt550`
- **Depends on:** none (theming lane KOBE-497..503 shipped 2026-10-29)

## Plan

Chris (2026-11-06): bring the look and feel of the Catalyst query tool to Kobe; "I like the way
the panels look and when I roll over them, the outside glows." Catalyst's recipe
(`ui/src/components/ui/card.tsx`, `styles/catalyst-tokens.css`, `app/globals.css`): cards with a
1px border (the accent at 10% in the dark theme) that on hover ease the border toward the accent
and gain `0 0 20px var(--glow-color)`; `--glow-color` is the accent at 25-30%; dialogs, menus and
sheets carry a static glow shadow; the dark page has an ambient radial wash.

1. Tokens (`app/theme.css`, docs/theming.md §7): `--kobe-glow-color` (brand primary at 28%, so every
   preset and a custom accent glow in their own colour), `--kobe-glow-panel`,
   `--kobe-panel-border-hover`, `--kobe-page-ambient`; the three shadows become preset tokens.
2. `kobe-panel` class: one unlayered rule per root (chat, consoles), hover-pointer only, no easing
   under reduced motion; on tool-call cards, approval and file cards, the notifications panel,
   Compare columns, the context viewer pane and the console `Card`; the composer glows on focus.
3. Preset `catalyst`: Catalyst's light palette and its "Rehoboam" dark, translucent accent borders,
   its glow colour per scheme, glow shadows, the dark ambient.

Added by Chris during the run (2026-11-06), same PR:

4. The Used-skill chip's icon is gold (the tool badge's gold token).
5. The conversation header: no pencil; the thread name itself is the rename button ("Rename
   <title>", `data-command="rename-thread"`; the h2 stays, visually hidden, as the region's label).
6. The lineage strip is one chip at every width: fork icon first, the parent's title, a chevron;
   sharp corners, the page's colours inverted (`bg-foreground text-background`); its menu is the
   former phone-line family menu. Rows, per-row links, siblings dropdowns, the fold and the
   fork-point excerpt are gone (spec TL3 amended; `lineageRows` and friends stay in the lib for
   the Conversation tree). `e2e/browser/tests/{fork,thread-lineage}.spec.ts` rewritten for the chip.

7. MCP app frames show no header line ("<title> App from <connector>"); T9 amended. The card's
   border, the region's accessible name and the display-mode rules remain the anti-spoofing cues.

## Decisions

- Glow is a Kobe-wide behaviour, not a preset feature: Chris asked for the look in Kobe, and the
  default look only changes on hover (no screenshot baseline shows a hovered card).
- The shell columns (rail, conversation, artifact column) stay edge to edge: layout is not themed
  (docs/theming.md §9). Catalyst's floating cards with gaps would be a layout decision for Chris.
- Fonts not ported: Catalyst uses Outfit + JetBrains Mono; TH10 (system stacks, no font files)
  stands. `grotesk` is the nearest stack. A decision for Chris if he wants the faces.
- Floor fixes on Catalyst's own values: dark muted text `#6b7694` → `#7f8aa8` (4.3 → 5.5 on the
  page), dark control border `#56688c`, light page `#f0f2f5` → `#f3f5f9` and soft `#e8ecf4` →
  `#eff2f7` (the fixed "done" green was 4.30 on the muted panel).
- `PRESET_IDS` grows in this PR (protocol contract): no other lane is open, so no separate PR.
- The chat's compiled-CSS snapshot (`console-css-guard`) updated on purpose for the panel rule.

## Open questions (for Chris or the coordinator)

- Outfit + JetBrains Mono (would revisit TH10)? Floating shell columns with gaps (layout)?
- Should the Catalyst preset become gate1's branding, or stay a choice on Appearance?

## Evidence (acceptance criteria → test or command output)

- ac-1: `apps/web/app/theme-css.test.ts` "panel glow (KOBE-550)" (tokens, both root rules, media
  guards, composer focus, the surfaces carry the class).
- ac-2: `packages/protocol/src/branding.test.ts`, `apps/web/lib/theme/presets.test.ts` (labels,
  floor in both schemes), `charts/kobe/tests/branding-presets.test.ts`.
- ac-3: `presets.test.ts` glow/ambient/shadow tests; docs/theming.md §3.1, §7, §9.
- ac-4: `pnpm verify`, CI on the PR.
- ac-5: gate1 deploy and browser check (below, when done).
