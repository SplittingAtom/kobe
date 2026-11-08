# KOBE-575: Rail Apps tab: the picker frame always shows a scrollbar (inline iframe baseline gap; stale height after the section shrinks)

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (PR with KOBE-574, branch `kobe-574-575-composer-polish`)
- **Branch / worktree:** `kobe-574-575-composer-polish` in `../Kobe-wt574`
- **Depends on:** KOBE-460 (rail picker), KOBE-559 (only the chosen picker)

## Plan

1. `block` on the iframe (`apps/web/components/apps/app-frame.tsx`).
2. Rail: a ResizeObserver on `[data-kobe-app-scroll]`; on a height change the frame fills the
   section again (`height: 100%`); a size report sets an explicit height only when it exceeds the
   section's clientHeight by more than 1px (the SDK reports `Math.ceil(document height)`), a
   fitting report goes back to 100%.
3. gate1 spec `e2e/browser/tests/rail-picker-scroll.spec.ts`.

## Decisions

- Inline cards and the expanded tab are unchanged: there the iframe is a flex item of the
  `flex flex-col` section, so it was already blockified (no gap); `block` only changes the rail,
  where the iframe sits in a plain scrolling div. Their sizing code path is untouched (the rail
  branch reads the wrapper only when it exists).
- The observer resets only on a height change of the section (width changes make the app
  re-report on its own); its first callback after `observe` is ignored.
- The rail frame no longer starts at `initialHeight`/360: it fills the section until a report says
  the content is taller (the rail has no card height to restore).

## Open questions (for Chris or the coordinator)

- An app with content taller than the section whose document height does not change when its
  viewport does (no new size report) stays at 100% after a section resize and scrolls inside its
  own frame until it reports again. The Lakehouse Picker (100vh) is not affected.
- The gate1 spec has not run yet (no gate1 access from the agent); coordinator runs it (ac-1, ac-4).

## Evidence (acceptance criteria → test or command output)

- ac-1: `app-frame.test.tsx` "is display block … in any placement", "fills its section, and a
  report that fits (rounded up by the SDK) keeps it there" (656 and 657 in a 656 section stay at
  100%). gate1: `rail-picker-scroll.spec.ts` (1440x900, 700, 1100: scrollHeight == clientHeight,
  iframe `display: block`): to be run by the coordinator.
- ac-2: `app-frame.test.tsx` "grows past its section when the app's content is taller" (658 in 656
  grows, 400 goes back to 100%) and "follows the section when it shrinks" (1000px frame, section
  856 → 456: back to 100%, a 456 report keeps it).
- ac-3: `components/apps` (app-frame, app-placement, tool-card-app), `shell/rail-pickers` tests
  green (88 tests); no class or style change for inline/expanded besides `block` on a flex item.
- ac-4: `pnpm verify` and PR CI: see the PR; gate1 spec: coordinator.
