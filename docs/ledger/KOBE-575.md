# KOBE-575: Rail Apps tab: the picker frame always shows a scrollbar (inline iframe baseline gap; stale height after the section shrinks)

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (PR with KOBE-574, branch `kobe-574-575-composer-polish`)
- **Branch / worktree:** `kobe-574-575-composer-polish` in `../Kobe-wt574`
- **Depends on:** KOBE-460 (rail picker), KOBE-559 (only the chosen picker)

## Plan

1. `block` on the iframe (`apps/web/components/apps/app-frame.tsx`).
2. Rail: a size report sets an explicit height only when it exceeds the section's clientHeight by
   more than 1px (the SDK reports `Math.ceil(document height)`) and the section has layout
   (clientHeight > 0); otherwise the frame fills it (100%). The last report is kept in a ref. A
   ResizeObserver on `[data-kobe-app-scroll]`: on a height change the frame fills the section,
   and after `RAIL_SETTLE_MS` (150 ms, cancelled by a new report) the last report is applied
   again if still taller (a content-sized app sends no new report; a 100vh app re-reports).
3. gate1 spec `e2e/browser/tests/rail-picker-scroll.spec.ts`.

## Decisions

- Inline cards and the expanded tab are unchanged: there the iframe is a flex item of the
  `flex flex-col` section, so it was already blockified (no gap); `block` only changes the rail,
  where the iframe sits in a plain scrolling div. Their sizing code path is untouched (the rail
  branch reads the wrapper only when it exists).
- The observer resets only on a height change of the section (width changes make the app
  re-report on its own); its first callback after `observe` is ignored.
- The rail frame ignores `initialHeight` (documented on the prop) and does not set the cards'
  height state, so one report is one render.

## Open questions (for Chris or the coordinator)

- The gate1 spec has not run yet (no gate1 access from the agent); coordinator runs it (ac-1, ac-4).

## Evidence (acceptance criteria → test or command output)

- ac-1: `app-frame.test.tsx` "is display block … in any placement", "fills its section, and a
  report that fits (rounded up by the SDK) keeps it there" (656 and 657 in a 656 section stay at
  100%). gate1: `rail-picker-scroll.spec.ts` (1440x900, 700, 1100: scrollHeight == clientHeight,
  iframe `display: block`): to be run by the coordinator.
- ac-2: `app-frame.test.tsx` "grows past its section when the app's content is taller" (658 in 656
  grows, 400 goes back to 100%), "follows the section when it shrinks" (1000px, section 856 → 456,
  the app re-reports 456 within the tick: stays 100%), "keeps a content-sized app's taller
  height" (1200 in 656 → 456: 100% then 1200px after the tick; section 1300: 100%), "a report
  while the section has no layout does not pin the frame" (fake timers).
- ac-3: `components/apps` (app-frame, app-placement, tool-card-app), `shell/rail-pickers` tests
  green (88 tests); no class or style change for inline/expanded besides `block` on a flex item.
- ac-4: `pnpm verify` and PR CI: see the PR; gate1 spec: coordinator.
